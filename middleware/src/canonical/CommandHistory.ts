/**
 * Histórico de uma única sessão de projeto: relógio lógico E undo/redo.
 *
 * Dois relógios distintos vivem aqui, e confundi-los é o erro clássico:
 *
 *   • `commandSequence` é MONOTÔNICO e nunca volta. Desfazer CONSOME
 *     sequências novas, uma por comando inverso, porque desfazer é aplicar
 *     comandos — o `EventJournal` e os clientes que acompanham eventos por
 *     `seq` quebrariam se a sequência retrocedesse.
 *   • `historyCursor` + `documentStateId` são a identidade LÓGICA do
 *     conteúdo, e esses sim voltam ao valor anterior quando se desfaz.
 *
 * O commit é em três fases (`prepare` → `assert` → `commit`) porque store e
 * histórico têm de virar juntos: o orquestrador prepara os dois, verifica os
 * dois e só então adota os dois, sem nenhum `await` no meio. Um `await` ali
 * deixaria o documento à frente do relógio se a projeção falhasse.
 */

import type {
  AppliedCommand,
  BlueprintCommand,
  BlueprintEvent,
  CommandActor,
} from "../domain/BlueprintStore.js";

export type HistoryAction = "apply" | "undo" | "redo";

/** Um item DESFAZÍVEL: o gesto do usuário, não o comando individual. */
export interface HistoryEntry {
  readonly id: string;
  /** Rótulo humano em pt-BR ("Mover entidade"), para a aba Histórico. */
  readonly label: string;
  readonly forward: readonly BlueprintCommand[];
  /** Comandos que desfazem, já na ordem de aplicação. */
  readonly inverse: readonly BlueprintCommand[];
  readonly actor: CommandActor;
  readonly transactionId?: string;
  readonly timestamp: number;
  /** Entrada sem inverso: desfazer PARA nela. */
  readonly barrier: boolean;
}

/** Registro append-only do relógio lógico (um por comando aplicado). */
export interface CommandHistoryEntry {
  readonly commandSequence: bigint;
  readonly command: BlueprintCommand;
  readonly event: BlueprintEvent;
  readonly appliedAt: number;
  readonly action: HistoryAction;
  /** Entrada desfazível a que este comando pertence; ausente no baseline. */
  readonly historyEntryId?: string;
}

export interface HistoryStatus {
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel?: string;
  readonly redoLabel?: string;
  readonly entries: readonly HistoryEntrySummary[];
}

export interface HistoryEntrySummary {
  readonly id: string;
  readonly label: string;
  readonly actor: CommandActor;
  readonly timestamp: number;
  readonly barrier: boolean;
  /** `true` para as entradas já desfeitas (o ramo do redo). */
  readonly undone: boolean;
}

export class HistoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryUnavailableError";
  }
}

/** Desfazer parou numa entrada sem inverso (ex.: definição de esqueleto). */
export class HistoryBarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryBarrierError";
  }
}

/** O cursor mudou desde a leitura do cliente: outro alguém editou. */
export class HistoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryConflictError";
  }
}

/** Plano de gravação de uma nova entrada; nada muda até `commitRecord`. */
export interface HistoryRecordPlan {
  readonly source: CommandHistory;
  readonly baseCursor: number;
  readonly commands: readonly BlueprintCommand[];
  readonly results: readonly AppliedCommand[];
  readonly entry: HistoryEntry;
  /** `true` quando o gesto se junta à entrada do topo em vez de criar outra. */
  readonly coalesced: boolean;
}

/** Plano de undo/redo; nada muda até `commitMove`. */
export interface HistoryMovePlan {
  readonly source: CommandHistory;
  readonly baseCursor: number;
  readonly action: "undo" | "redo";
  readonly entry: HistoryEntry;
  readonly commands: readonly BlueprintCommand[];
}

const BASELINE_STATE_ID = "baseline";

export class CommandHistory {
  private readonly entries: CommandHistoryEntry[] = [];
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private nextEntryId = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get lastSequence(): bigint {
    return this.entries.at(-1)?.commandSequence ?? 0n;
  }

  get length(): number {
    return this.entries.length;
  }

  list(): readonly CommandHistoryEntry[] {
    return Object.freeze([...this.entries]);
  }

  /**
   * Identidade lógica do conteúdo. Volta ao valor anterior quando se desfaz —
   * é o que permite a um cliente perguntar "o documento que eu tenho ainda é
   * este?" sem depender do relógio monotônico.
   */
  get documentStateId(): string {
    return this.past.at(-1)?.id ?? BASELINE_STATE_ID;
  }

  get historyCursor(): string {
    return String(this.past.length);
  }

  get canUndo(): boolean {
    const top = this.past.at(-1);
    return top !== undefined && !top.barrier;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  status(limit = 50): HistoryStatus {
    if (!Number.isInteger(limit) || limit < 0 || limit > 500) {
      throw new HistoryUnavailableError("history limit must be an integer between 0 and 500");
    }
    const summaries: HistoryEntrySummary[] = [
      ...this.past.map((entry) => summarize(entry, false)),
      // o ramo do redo é publicado em ordem cronológica, não de pilha
      ...[...this.future].reverse().map((entry) => summarize(entry, true)),
    ];
    return Object.freeze({
      documentStateId: this.documentStateId,
      historyCursor: this.historyCursor,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      ...(this.canUndo ? { undoLabel: this.past.at(-1)!.label } : {}),
      ...(this.canRedo ? { redoLabel: this.future.at(-1)!.label } : {}),
      entries: Object.freeze(summaries.slice(-limit)),
    });
  }

  /**
   * Avança o relógio SEM criar item desfazível, e zera as duas pilhas.
   *
   * É o caminho do replay de abertura: se o replay criasse entradas
   * desfazíveis, abrir um documento permitiria "desfazer" o documento inteiro
   * até o vazio — e o usuário perderia o projeto achando que voltou uma ação.
   */
  appendBaseline(command: BlueprintCommand, event: BlueprintEvent): CommandHistoryEntry {
    const entry = this.pushSequence(command, event, "apply", undefined);
    this.past = [];
    this.future = [];
    return entry;
  }

  /**
   * Prepara a gravação de um gesto. Não muda nada: devolve o plano que
   * `commitRecord` vai adotar.
   */
  prepareRecord(
    commands: readonly BlueprintCommand[],
    results: readonly AppliedCommand[],
  ): HistoryRecordPlan {
    if (commands.length !== results.length) {
      throw new HistoryUnavailableError("history record needs one result per command");
    }
    const actor = commands[0]?.metadata?.actor ?? "human";
    const transactionId = commands[0]?.transactionId;
    const barrier = results.some((result) => result.barrier);

    // Inverso do lote = inversos individuais em ordem REVERSA: desfazer três
    // comandos exige desfazer o terceiro primeiro.
    const inverse = [...results].reverse().flatMap((result) => [...result.inverse]);

    const top = this.past.at(-1);
    const coalesced =
      !barrier &&
      top !== undefined &&
      !top.barrier &&
      transactionId !== undefined &&
      top.transactionId === transactionId &&
      top.actor === actor;

    const entry: HistoryEntry = coalesced
      ? Object.freeze({
          ...top!,
          forward: Object.freeze([...top!.forward, ...commands]),
          // o inverso do gesto cresce pela FRENTE: o último comando é o
          // primeiro a ser desfeito
          inverse: Object.freeze([...inverse, ...top!.inverse]),
          timestamp: this.now(),
        })
      : Object.freeze({
          id: `h${++this.nextEntryId}`,
          label: labelFor(commands, results),
          forward: Object.freeze([...commands]),
          inverse: Object.freeze(inverse),
          actor,
          ...(transactionId !== undefined ? { transactionId } : {}),
          timestamp: this.now(),
          barrier,
        });

    return Object.freeze({
      source: this,
      baseCursor: this.past.length,
      commands: Object.freeze([...commands]),
      results: Object.freeze([...results]),
      entry,
      coalesced,
    });
  }

  /** Confirma que o plano ainda vale (nada mudou desde `prepareRecord`). */
  assertRecordPlan(plan: HistoryRecordPlan): void {
    this.assertPlanSource(plan.source);
    if (plan.baseCursor !== this.past.length) {
      throw new HistoryConflictError(
        `History moved while the command was being prepared ` +
          `(expected cursor ${plan.baseCursor}, is ${this.past.length})`,
      );
    }
  }

  commitRecord(plan: HistoryRecordPlan): readonly CommandHistoryEntry[] {
    this.assertRecordPlan(plan);
    if (plan.coalesced) this.past.pop();
    this.past.push(plan.entry);
    // Editar depois de desfazer descarta o ramo do redo: manter o futuro
    // permitiria "refazer" por cima de um documento que já divergiu.
    this.future = [];
    if (plan.coalesced) this.nextEntryId = this.nextEntryId; // id reaproveitado
    return plan.commands.map((command, index) =>
      this.pushSequence(command, plan.results[index]!.event, "apply", plan.entry.id),
    );
  }

  prepareUndo(expectedHistoryCursor?: string): HistoryMovePlan {
    this.assertCursor(expectedHistoryCursor);
    const entry = this.past.at(-1);
    if (!entry) throw new HistoryUnavailableError("There is nothing to undo");
    if (entry.barrier) {
      throw new HistoryBarrierError(
        `"${entry.label}" cannot be undone; the history stops here`,
      );
    }
    return Object.freeze({
      source: this,
      baseCursor: this.past.length,
      action: "undo" as const,
      entry,
      commands: entry.inverse,
    });
  }

  prepareRedo(expectedHistoryCursor?: string): HistoryMovePlan {
    this.assertCursor(expectedHistoryCursor);
    const entry = this.future.at(-1);
    if (!entry) throw new HistoryUnavailableError("There is nothing to redo");
    return Object.freeze({
      source: this,
      baseCursor: this.past.length,
      action: "redo" as const,
      entry,
      commands: entry.forward,
    });
  }

  assertMovePlan(plan: HistoryMovePlan): void {
    this.assertPlanSource(plan.source);
    if (plan.baseCursor !== this.past.length) {
      throw new HistoryConflictError(
        `History moved while undo/redo was being prepared ` +
          `(expected cursor ${plan.baseCursor}, is ${this.past.length})`,
      );
    }
  }

  commitMove(
    plan: HistoryMovePlan,
    events: readonly BlueprintEvent[],
  ): readonly CommandHistoryEntry[] {
    this.assertMovePlan(plan);
    if (plan.action === "undo") {
      this.past.pop();
      this.future.push(plan.entry);
    } else {
      this.future.pop();
      this.past.push(plan.entry);
    }
    return plan.commands.map((command, index) =>
      this.pushSequence(command, events[index]!, plan.action, plan.entry.id),
    );
  }

  private assertCursor(expected: string | undefined): void {
    if (expected !== undefined && expected !== this.historyCursor) {
      throw new HistoryConflictError(
        `History changed since it was read (expected cursor ${expected}, is ${this.historyCursor})`,
      );
    }
  }

  private assertPlanSource(source: CommandHistory): void {
    if (source !== this) {
      throw new HistoryConflictError("History plan was prepared by a different session");
    }
  }

  private pushSequence(
    command: BlueprintCommand,
    event: BlueprintEvent,
    action: HistoryAction,
    historyEntryId: string | undefined,
  ): CommandHistoryEntry {
    const entry: CommandHistoryEntry = Object.freeze({
      commandSequence: this.lastSequence + 1n,
      command,
      event,
      appliedAt: this.now(),
      action,
      ...(historyEntryId !== undefined ? { historyEntryId } : {}),
    });
    this.entries.push(entry);
    return entry;
  }
}

function summarize(entry: HistoryEntry, undone: boolean): HistoryEntrySummary {
  return Object.freeze({
    id: entry.id,
    label: entry.label,
    actor: entry.actor,
    timestamp: entry.timestamp,
    barrier: entry.barrier,
    undone,
  });
}

/**
 * Rótulos em pt-BR por kind — a aba Histórico mostra o que o usuário FEZ, não
 * o nome técnico do comando. Nenhum id interno aparece aqui.
 */
const LABELS: Readonly<Record<BlueprintCommand["kind"], string>> = {
  "skeleton/define": "Definir esqueleto",
  "mesh/bind": "Vincular malha",
  "camera/configure": "Ajustar câmera",
  "light/add": "Adicionar luz",
  "light/update": "Editar luz",
  "light/remove": "Remover luz",
  "entitydef/define": "Criar tipo de entidade",
  "entitydef/update": "Editar tipo de entidade",
  "entitydef/remove": "Remover tipo de entidade",
  "tileset/define": "Criar tileset",
  "tileset/remove": "Remover tileset",
  "entity/place": "Posicionar entidade",
  "entity/move": "Mover entidade",
  "entity/properties": "Editar propriedades",
  "entity/remove": "Remover entidade",
  "level/define": "Criar nível",
  "level/update": "Atualizar nível",
  "level/patch": "Pintar nível",
  "level/palette": "Editar paleta",
  "level/remove": "Remover nível",
  "world/place": "Posicionar no mapa",
  "world/unplace": "Retirar do mapa",
};

function labelFor(
  commands: readonly BlueprintCommand[],
  _results: readonly AppliedCommand[],
): string {
  // Rótulo explícito da borda ganha do default: a UI sabe melhor o que o
  // usuário acha que fez ("Apagar seleção" em vez de "Pintar nível").
  const explicit = commands[0]?.metadata?.label;
  if (explicit !== undefined && explicit.trim().length > 0) return explicit;
  const first = commands[0];
  return first ? LABELS[first.kind] : "Alteração";
}
