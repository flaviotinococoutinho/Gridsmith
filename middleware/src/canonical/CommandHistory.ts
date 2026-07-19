/** Histórico transacional e substituível de uma única ProjectSession. */

import { randomUUID } from "node:crypto";
import type {
  BlueprintCommand,
  CommandActor,
} from "../domain/BlueprintStore.js";

export interface HistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly forward: readonly BlueprintCommand[];
  readonly inverse: readonly BlueprintCommand[];
  readonly actor: CommandActor;
  readonly transactionId: string;
  readonly timestamp: number;
  readonly barrier?: boolean;
}

/** Alias de compatibilidade para consumidores que importavam o nome anterior. */
export type CommandHistoryEntry = HistoryEntry;

export interface CommandHistoryStatus {
  readonly commandSequence: bigint;
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel?: string;
  readonly redoLabel?: string;
}

interface HistoryRecord {
  readonly entry: HistoryEntry;
  readonly beforeStateId: string;
  readonly afterStateId: string;
}

export interface HistoryRecordPlan {
  readonly baseVersion: number;
  readonly beforeStateId: string;
  readonly record: HistoryRecord;
  readonly coalesced: boolean;
}

export interface HistoryMovePlan {
  readonly direction: "undo" | "redo";
  readonly baseVersion: number;
  readonly beforeStateId: string;
  readonly record: HistoryRecord;
  readonly commands: readonly BlueprintCommand[];
}

export interface HistoryCommitResult {
  readonly entry: HistoryEntry;
  readonly commandSequences: readonly bigint[];
  readonly commandSequence: bigint;
  readonly documentStateId: string;
  readonly historyCursor: string;
}

export class CommandHistory {
  private readonly past: HistoryRecord[] = [];
  private readonly future: HistoryRecord[] = [];
  private sequence = 0n;
  private version = 0;
  private currentStateId: string;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
  ) {
    this.currentStateId = `state-${this.createId()}`;
  }

  get lastSequence(): bigint {
    return this.sequence;
  }

  get length(): number {
    return this.past.length;
  }

  get documentStateId(): string {
    return this.currentStateId;
  }

  get historyCursor(): string {
    return this.currentStateId;
  }

  get status(): CommandHistoryStatus {
    const undo = this.past.at(-1)?.entry;
    const redo = this.future.at(-1)?.entry;
    return Object.freeze({
      commandSequence: this.sequence,
      documentStateId: this.currentStateId,
      historyCursor: this.currentStateId,
      canUndo: Boolean(undo && !undo.barrier),
      canRedo: Boolean(redo),
      ...(undo && !undo.barrier ? { undoLabel: undo.label } : {}),
      ...(redo ? { redoLabel: redo.label } : {}),
    });
  }

  list(): readonly HistoryEntry[] {
    return Object.freeze(this.past.map((record) => record.entry));
  }

  listFuture(): readonly HistoryEntry[] {
    return Object.freeze([...this.future].reverse().map((record) => record.entry));
  }

  /** Replay de Open/Template avança a revisão, porém nunca cria itens desfazíveis. */
  appendBaseline(): bigint {
    this.sequence++;
    this.currentStateId = `state-${this.createId()}`;
    this.version++;
    this.past.length = 0;
    this.future.length = 0;
    return this.sequence;
  }

  prepareRecord(
    command: BlueprintCommand,
    inverse: readonly BlueprintCommand[],
    trustedActor: CommandActor,
  ): HistoryRecordPlan {
    validateActor(trustedActor);
    const transactionId = normalizedTransactionId(command.transactionId, this.createId);
    const metadata = command.metadata;
    const barrier = metadata?.barrier === true || inverse.length === 0;
    const previous = this.past.at(-1);
    const canCoalesce = Boolean(
      previous &&
      !previous.entry.barrier &&
      !barrier &&
      previous.entry.transactionId === transactionId &&
      previous.entry.actor === trustedActor,
    );
    const afterStateId = `state-${this.createId()}`;
    const frozenCommand = immutableClone(command);
    const frozenInverse = immutableClone(inverse);
    const coalescedCommands = canCoalesce
      ? coalesceCommands(previous!.entry, frozenCommand, frozenInverse)
      : undefined;
    const entry = canCoalesce
      ? Object.freeze({
          ...previous!.entry,
          forward: coalescedCommands?.forward ?? Object.freeze([...previous!.entry.forward, frozenCommand]),
          // Desfazer respeita ordem inversa do apply dentro do gesto.
          inverse: coalescedCommands?.inverse ?? Object.freeze([...frozenInverse, ...previous!.entry.inverse]),
        })
      : Object.freeze({
          id: this.createId(),
          label: normalizedLabel(metadata?.label, command),
          forward: Object.freeze([frozenCommand]),
          inverse: Object.freeze([...frozenInverse]),
          actor: trustedActor,
          transactionId,
          timestamp: this.now(),
          ...(barrier ? { barrier: true } : {}),
        });
    return Object.freeze({
      baseVersion: this.version,
      beforeStateId: this.currentStateId,
      coalesced: canCoalesce,
      record: Object.freeze({
        entry,
        beforeStateId: canCoalesce ? previous!.beforeStateId : this.currentStateId,
        afterStateId,
      }),
    });
  }

  assertRecordPlan(plan: HistoryRecordPlan): void {
    if (plan.baseVersion !== this.version || plan.beforeStateId !== this.currentStateId) {
      throw new HistoryConflictError("History changed while a command was being prepared");
    }
  }

  commitRecord(plan: HistoryRecordPlan): HistoryCommitResult {
    if (plan.coalesced) this.past[this.past.length - 1] = plan.record;
    else this.past.push(plan.record);
    // Qualquer edição nova depois de undo invalida o ramo futuro.
    this.future.length = 0;
    this.currentStateId = plan.record.afterStateId;
    this.version++;
    const commandSequences = this.allocateSequences(1);
    return this.commitResult(plan.record.entry, commandSequences);
  }

  prepareUndo(expectedHistoryCursor?: string): HistoryMovePlan {
    this.assertExpectedCursor(expectedHistoryCursor);
    const record = this.past.at(-1);
    if (!record) throw new HistoryUnavailableError("There is no command to undo");
    if (record.entry.barrier) {
      throw new HistoryBarrierError(`Cannot undo across barrier "${record.entry.label}"`);
    }
    return Object.freeze({
      direction: "undo",
      baseVersion: this.version,
      beforeStateId: this.currentStateId,
      record,
      commands: record.entry.inverse,
    });
  }

  prepareRedo(expectedHistoryCursor?: string): HistoryMovePlan {
    this.assertExpectedCursor(expectedHistoryCursor);
    const record = this.future.at(-1);
    if (!record) throw new HistoryUnavailableError("There is no command to redo");
    return Object.freeze({
      direction: "redo",
      baseVersion: this.version,
      beforeStateId: this.currentStateId,
      record,
      commands: record.entry.forward,
    });
  }

  assertMovePlan(plan: HistoryMovePlan): void {
    if (plan.baseVersion !== this.version || plan.beforeStateId !== this.currentStateId) {
      throw new HistoryConflictError("History changed while undo/redo was being prepared");
    }
    const expected = plan.direction === "undo" ? this.past.at(-1) : this.future.at(-1);
    if (expected !== plan.record) {
      throw new HistoryConflictError("History cursor no longer identifies the selected entry");
    }
  }

  commitMove(plan: HistoryMovePlan): HistoryCommitResult {
    if (plan.direction === "undo") {
      this.past.pop();
      this.future.push(plan.record);
      this.currentStateId = plan.record.beforeStateId;
    } else {
      this.future.pop();
      this.past.push(plan.record);
      this.currentStateId = plan.record.afterStateId;
    }
    this.version++;
    const commandSequences = this.allocateSequences(plan.commands.length);
    return this.commitResult(plan.record.entry, commandSequences);
  }

  private assertExpectedCursor(expected: string | undefined): void {
    if (expected !== undefined && expected !== this.currentStateId) {
      throw new HistoryConflictError(
        `History cursor changed (expected ${expected}, got ${this.currentStateId})`,
      );
    }
  }

  private allocateSequences(count: number): readonly bigint[] {
    const sequences: bigint[] = [];
    for (let index = 0; index < count; index++) sequences.push(++this.sequence);
    return Object.freeze(sequences);
  }

  private commitResult(entry: HistoryEntry, commandSequences: readonly bigint[]): HistoryCommitResult {
    return Object.freeze({
      entry,
      commandSequences,
      commandSequence: this.sequence,
      documentStateId: this.currentStateId,
      historyCursor: this.currentStateId,
    });
  }
}

export class HistoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryUnavailableError";
  }
}

export class HistoryBarrierError extends HistoryUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "HistoryBarrierError";
  }
}

export class HistoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryConflictError";
  }
}

function validateActor(actor: CommandActor): void {
  if (!["human", "agent", "pipeline"].includes(actor)) {
    throw new TypeError(`Unknown command actor "${String(actor)}"`);
  }
}

function normalizedTransactionId(value: string | undefined, createId: () => string): string {
  const transactionId = value ?? `transaction-${createId()}`;
  if (!transactionId.trim() || transactionId.length > 128) {
    throw new TypeError("transactionId must contain 1..128 characters");
  }
  return transactionId;
}

function normalizedLabel(value: string | undefined, command: BlueprintCommand): string {
  if (value !== undefined) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 160) throw new TypeError("history label must contain 1..160 characters");
    return trimmed;
  }
  switch (command.kind) {
    case "level/patch": return `Editou nível ${command.levelId}`;
    case "level/palette": return `Editou paleta de ${command.levelId}`;
    case "entity/move": return `Moveu entidade ${command.entityId}`;
    case "entity/properties": return `Alterou propriedades de ${command.entityId}`;
    case "entity/place": return `Posicionou entidade ${command.entity.entityId}`;
    case "entity/remove": return `Removeu entidade ${command.entityId}`;
    case "light/add": return `Adicionou luz ${command.light.lightId}`;
    case "light/update": return `Alterou luz ${command.light.lightId}`;
    case "light/remove": return `Removeu luz ${command.lightId}`;
    case "camera/configure": return "Alterou câmera";
    case "world/place": return `Moveu nível ${command.placement.levelId} no mundo`;
    case "world/unplace": return `Removeu nível ${command.levelId} do mundo`;
    case "entitydef/define": return `Definiu ${command.definition.entityDefId}`;
    case "entitydef/update": return `Alterou definição ${command.definition.entityDefId}`;
    case "entitydef/remove": return `Removeu definição ${command.entityDefId}`;
    case "level/define": return `Criou nível ${command.level.levelId}`;
    case "level/update": return `Atualizou nível ${command.level.levelId}`;
    case "level/remove": return `Removeu nível ${command.levelId}`;
    case "skeleton/define": return `Definiu esqueleto ${command.skeleton.skeletonId}`;
    case "mesh/bind": return `Vinculou malha ${command.binding.meshId}`;
  }
}

function coalesceCommands(
  entry: HistoryEntry,
  command: BlueprintCommand,
  inverse: readonly BlueprintCommand[],
): { readonly forward: readonly BlueprintCommand[]; readonly inverse: readonly BlueprintCommand[] } | undefined {
  if (
    entry.forward.length === 1 && entry.inverse.length === 1 && inverse.length === 1 &&
    entry.forward[0]?.kind === "entity/move" && command.kind === "entity/move" &&
    entry.inverse[0]?.kind === "entity/move" &&
    entry.forward[0].entityId === command.entityId
  ) {
    return Object.freeze({
      forward: Object.freeze([command]),
      inverse: entry.inverse,
    });
  }
  if (
    entry.forward.length === 1 && entry.inverse.length === 1 && inverse.length === 1 &&
    entry.forward[0]?.kind === "level/patch" && command.kind === "level/patch" &&
    entry.inverse[0]?.kind === "level/patch" &&
    entry.forward[0].levelId === command.levelId
  ) {
    const byIndex = new Map<number, { index: number; before: number; after: number }>();
    for (const change of entry.forward[0].changes) byIndex.set(change.index, { ...change });
    for (const change of command.changes) {
      const previous = byIndex.get(change.index);
      byIndex.set(change.index, previous
        ? { index: change.index, before: previous.before, after: change.after }
        : { ...change });
    }
    const changes = [...byIndex.values()]
      .filter((change) => change.before !== change.after)
      .sort((a, b) => a.index - b.index);
    // Um gesto que voltou integralmente ao início continua como sequência
    // explícita; level/patch vazio não é um comando válido.
    if (changes.length === 0) return undefined;
    const forward = immutableClone({ ...command, changes });
    const reversed = immutableClone({
      ...command,
      changes: changes.map((change) => ({
        index: change.index,
        before: change.after,
        after: change.before,
      })),
    });
    return Object.freeze({ forward: Object.freeze([forward]), inverse: Object.freeze([reversed]) });
  }
  return undefined;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
