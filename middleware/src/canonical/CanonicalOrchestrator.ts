/** Único caminho de mutação do Blueprint, incluindo undo/redo globais. */

import type {
  BlueprintCommand,
  BlueprintEvent,
  BlueprintStore,
  CommandActor,
} from "../domain/BlueprintStore.js";
import type { HookBus } from "./HookBus.js";
import type { ProjectionResult, RuntimeAdapter } from "../runtime/RuntimeAdapter.js";
import {
  CommandHistory,
  type HistoryCommitResult,
  type HistoryEntry,
} from "./CommandHistory.js";

export interface DispatchResult {
  readonly event: BlueprintEvent;
  readonly projection: ProjectionResult | undefined;
  readonly commandSequence: bigint;
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly historyEntry?: HistoryEntry;
}

export interface HistoryEventResult extends DispatchResult {
  readonly historyEntry: HistoryEntry;
}

export interface HistoryDispatchResult {
  readonly entry: HistoryEntry;
  readonly results: readonly HistoryEventResult[];
  readonly commandSequence: bigint;
  readonly documentStateId: string;
  readonly historyCursor: string;
}

export interface DispatchOptions {
  /** Replay de preparação: valida/aplica no store temporário, sem side-effects externos. */
  readonly mode?: "live" | "prepare";
  /** Proveniência definida pela borda confiável; nunca pelo JSON do caller. */
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

    const actor = options.actor ?? filtered.metadata?.actor ?? "human";
    const canonical = withTrustedActor(filtered, actor);
    const storePlan = this.store.planBatch([canonical]);
    const applyResult = storePlan.results[0]!;
    const preparing = options.mode === "prepare";

    let commit: HistoryCommitResult | undefined;
    if (preparing) {
      // Nenhum await entre store e relógio lógico.
      this.store.commitBatch(storePlan);
      const commandSequence = this.history.appendBaseline();
      return {
        event: applyResult.event,
        projection: undefined,
        commandSequence,
        documentStateId: this.history.documentStateId,
        historyCursor: this.history.historyCursor,
      };
    }

    const historyPlan = this.history.prepareRecord(canonical, applyResult.inverse, actor);
    this.history.assertRecordPlan(historyPlan);
    // Commit canônico síncrono: observers só rodam depois de store + history.
    this.store.commitBatch(storePlan);
    commit = this.history.commitRecord(historyPlan);

    const projection = await this.runConsequences(applyResult.event);
    return {
      event: applyResult.event,
      projection,
      commandSequence: commit.commandSequence,
      documentStateId: commit.documentStateId,
      historyCursor: commit.historyCursor,
      historyEntry: commit.entry,
    };
  }

  undo(expectedHistoryCursor?: string): Promise<HistoryDispatchResult> {
    return this.moveHistory("undo", expectedHistoryCursor);
  }

  redo(expectedHistoryCursor?: string): Promise<HistoryDispatchResult> {
    return this.moveHistory("redo", expectedHistoryCursor);
  }

  private async moveHistory(
    direction: "undo" | "redo",
    expectedHistoryCursor?: string,
  ): Promise<HistoryDispatchResult> {
    const historyPlan = direction === "undo"
      ? this.history.prepareUndo(expectedHistoryCursor)
      : this.history.prepareRedo(expectedHistoryCursor);

    // O lote inteiro é aplicado num draft privado; qualquer falha deixa store,
    // cursor, journal e runtime intocados.
    const storePlan = this.store.planBatch(historyPlan.commands);
    this.history.assertMovePlan(historyPlan);
    this.store.commitBatch(storePlan);
    const commit = this.history.commitMove(historyPlan);

    const results: HistoryEventResult[] = [];
    for (let index = 0; index < storePlan.results.length; index++) {
      const applied = storePlan.results[index]!;
      const projection = await this.runConsequences(applied.event);
      results.push(Object.freeze({
        event: applied.event,
        projection,
        commandSequence: commit.commandSequences[index]!,
        documentStateId: commit.documentStateId,
        historyCursor: commit.historyCursor,
        historyEntry: commit.entry,
      }));
    }
    return Object.freeze({
      entry: commit.entry,
      results: Object.freeze(results),
      commandSequence: commit.commandSequence,
      documentStateId: commit.documentStateId,
      historyCursor: commit.historyCursor,
    });
  }

  private async runConsequences(event: BlueprintEvent): Promise<ProjectionResult | undefined> {
    await this.hooks.doAction(`event:${event.kind}`, event);
    let projection: ProjectionResult | undefined;
    if (this.adapter) {
      try {
        projection = await this.adapter.project(event, undefined, this.store);
      } catch (error) {
        projection = {
          event: event.kind,
          status: "deferred",
          reason: `runtime projection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (projection) await this.hooks.doAction("projection:completed", projection);
    return projection;
  }
}

function withTrustedActor(command: BlueprintCommand, actor: CommandActor): BlueprintCommand {
  return Object.freeze({
    ...command,
    metadata: Object.freeze({
      ...command.metadata,
      actor,
    }),
  }) as BlueprintCommand;
}
