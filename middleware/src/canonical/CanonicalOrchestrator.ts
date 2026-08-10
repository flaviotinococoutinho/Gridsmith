/**
 * Orquestrador do modelo canônico (docs/CANONICAL-MODEL.md §1): o ÚNICO
 * caminho de mutação do domínio.
 *
 *   dispatch(comando)
 *     = applyFilters("command:<kind>", comando)   // filters interceptam
 *     → planBatch / prepareRecord                 // valida store E histórico
 *     → commitBatch / commitRecord                // adota os dois juntos
 *     → doAction("event:<kind>", evento)          // actions notificam
 *     → adapter.project(evento)                   // projeção no runtime
 *
 * UI, ferramentas MCP e agentes usam o mesmo dispatch — mesma validação,
 * mesmos hooks, mesma projeção. Desfazer também: `undo`/`redo` aplicam
 * comandos inversos pelo MESMO caminho, então a engine vê a reversão como
 * qualquer outra edição.
 */

import type {
  BlueprintCommand,
  BlueprintEvent,
  BlueprintStore,
  CommandActor,
} from "../domain/BlueprintStore.js";
import type { HookBus } from "./HookBus.js";
import type { ProjectionResult, RuntimeAdapter } from "../runtime/RuntimeAdapter.js";
import { CommandHistory, type HistoryAction, type HistoryEntry } from "./CommandHistory.js";

export interface DispatchResult {
  readonly event: BlueprintEvent;
  readonly projection: ProjectionResult | undefined;
  readonly commandSequence: bigint;
  /** Identidade lógica do conteúdo APÓS o commit. */
  readonly documentStateId: string;
  readonly historyCursor: string;
  /** Entrada desfazível a que o comando pertence; ausente no replay. */
  readonly historyEntry?: HistoryEntry;
}

/** Resultado de um undo/redo: um gesto pode render N eventos. */
export interface HistoryDispatchResult {
  readonly entry: HistoryEntry;
  readonly action: HistoryAction;
  readonly results: readonly {
    readonly event: BlueprintEvent;
    readonly projection: ProjectionResult | undefined;
    readonly commandSequence: bigint;
  }[];
  readonly documentStateId: string;
  readonly historyCursor: string;
}

export interface DispatchOptions {
  /** Replay de preparação: valida/faz apply no store temporário, sem side-effects externos. */
  readonly mode?: "live" | "prepare";
  /**
   * Proveniência do comando, definida pela BORDA confiável — nunca pelo
   * payload. A UI despacha como "human", o MCP fixa "agent", o pipeline de
   * assets fixa "pipeline". Sem isso, qualquer cliente poderia se declarar
   * humano e a trilha de auditoria não valeria nada.
   */
  readonly actor?: CommandActor;
}

export class CanonicalOrchestrator {
  constructor(
    private readonly store: BlueprintStore,
    private readonly hooks: HookBus,
    private readonly adapter?: RuntimeAdapter,
    readonly history = new CommandHistory(),
  ) {}

  async dispatch(command: BlueprintCommand, options: DispatchOptions = {}): Promise<DispatchResult> {
    const filtered = await this.hooks.applyFilters<BlueprintCommand>(
      `command:${command.kind}`,
      command,
    );
    if (filtered?.kind !== command.kind) {
      throw new Error(
        `Filter chain for "command:${command.kind}" must preserve the command kind ` +
          `(got "${filtered?.kind}")`,
      );
    }

    // A proveniência é carimbada AQUI, com o valor que a borda confiável
    // passou — depois dos filters, para que nenhum filter possa forjá-la.
    const canonical: BlueprintCommand = options.actor
      ? { ...filtered, metadata: { ...filtered.metadata, actor: options.actor } }
      : filtered;

    const preparing = options.mode === "prepare";

    // ---- bloco de commit: ZERO await daqui até o fim ----------------------
    // Store e histórico têm de virar juntos. Um await no meio deixaria o
    // documento à frente do relógio lógico/EventJournal se algo falhasse.
    const plan = this.store.planBatch([canonical]);
    const applied = plan.results[0]!;
    const event = applied.event;

    let sequence: bigint;
    let entry: HistoryEntry | undefined;
    if (preparing) {
      // Replay de abertura: avança o relógio mas NÃO cria item desfazível,
      // senão abrir um projeto permitiria desfazê-lo até o vazio.
      this.store.commitBatch(plan);
      sequence = this.history.appendBaseline(canonical, event).commandSequence;
    } else {
      const record = this.history.prepareRecord([canonical], [applied]);
      this.history.assertRecordPlan(record);
      this.store.commitBatch(plan);
      sequence = this.history.commitRecord(record)[0]!.commandSequence;
      entry = record.entry;
    }
    // ---- fim do bloco de commit ------------------------------------------

    if (!preparing) await this.hooks.doAction(`event:${event.kind}`, event);
    const projection = preparing ? undefined : await this.projectSafely(event);
    if (projection) await this.hooks.doAction("projection:completed", projection);

    return {
      event,
      projection,
      commandSequence: sequence,
      documentStateId: this.history.documentStateId,
      historyCursor: this.history.historyCursor,
      ...(entry ? { historyEntry: entry } : {}),
    };
  }

  undo(expectedHistoryCursor?: string): Promise<HistoryDispatchResult> {
    return this.moveHistory("undo", expectedHistoryCursor);
  }

  redo(expectedHistoryCursor?: string): Promise<HistoryDispatchResult> {
    return this.moveHistory("redo", expectedHistoryCursor);
  }

  private async moveHistory(
    action: "undo" | "redo",
    expectedHistoryCursor?: string,
  ): Promise<HistoryDispatchResult> {
    // ---- bloco de commit: ZERO await ------------------------------------
    const move =
      action === "undo"
        ? this.history.prepareUndo(expectedHistoryCursor)
        : this.history.prepareRedo(expectedHistoryCursor);
    const plan = this.store.planBatch(move.commands);
    this.history.assertMovePlan(move);
    this.store.commitBatch(plan);
    const events = plan.results.map((result) => result.event);
    const sequences = this.history.commitMove(move, events);
    // ---- fim do bloco de commit -----------------------------------------

    // A projeção acontece DEPOIS e em ordem: a engine vê a reversão como uma
    // sequência normal de edições.
    const results: {
      event: BlueprintEvent;
      projection: ProjectionResult | undefined;
      commandSequence: bigint;
    }[] = [];
    for (const [index, event] of events.entries()) {
      await this.hooks.doAction(`event:${event.kind}`, event);
      const projection = await this.projectSafely(event);
      if (projection) await this.hooks.doAction("projection:completed", projection);
      results.push({
        event,
        projection,
        commandSequence: sequences[index]!.commandSequence,
      });
    }

    return Object.freeze({
      entry: move.entry,
      action,
      results: Object.freeze(results),
      documentStateId: this.history.documentStateId,
      historyCursor: this.history.historyCursor,
    });
  }

  private async projectSafely(event: BlueprintEvent): Promise<ProjectionResult | undefined> {
    if (!this.adapter) return undefined;
    try {
      return await this.adapter.project(event);
    } catch (error) {
      // O Blueprint é a fonte de verdade. Uma falha externa após o commit
      // vira estado deferred explícito e será reparada por rehydrateFrom;
      // jamais transforma um comando aplicado em mutação invisível.
      return {
        event: event.kind,
        status: "deferred",
        reason: `runtime projection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
