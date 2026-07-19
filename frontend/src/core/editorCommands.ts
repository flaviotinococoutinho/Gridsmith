import type { CellChange } from "./intGridDocument.js";

export type CommandActor = "human" | "agent" | "pipeline";

/** Metadados declarados pela UI; o middleware injeta a proveniência confiável. */
export interface CommandMetadataInput {
  readonly label: string;
  readonly actor?: CommandActor;
}

export interface LevelPatchCommand {
  readonly kind: "level/patch";
  readonly levelId: string;
  readonly changes: readonly CellChange[];
  readonly transactionId: string;
  readonly metadata: CommandMetadataInput;
}

export interface BlueprintEventPayload {
  readonly kind: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
  readonly transactionId?: string;
  readonly historyAction?: "apply" | "undo" | "redo";
  readonly documentStateId?: string;
  readonly [key: string]: unknown;
}

export interface DispatchOutcome {
  readonly event: BlueprintEventPayload;
  readonly projection?: { readonly status: string; readonly reason?: string };
  readonly documentStateId?: string;
  readonly historyCursor?: string;
  readonly historyEntry?: HistoryEntryPayload;
}

export interface HistoryEntryPayload {
  readonly id: string;
  readonly label: string;
  readonly actor: CommandActor;
  readonly transactionId: string;
  /** Decimal unix-ms no wire. */
  readonly timestamp: string;
  readonly barrier?: boolean;
  readonly applied?: boolean;
  readonly forward?: readonly unknown[];
  readonly inverse?: readonly unknown[];
}

export interface HistoryStatusPayload {
  readonly projectSessionId?: string;
  readonly projectId?: string;
  readonly commandSequence?: string;
  readonly documentStateId?: string;
  readonly historyCursor?: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel?: string;
  readonly redoLabel?: string;
  readonly cursor?: string;
  readonly entries?: readonly HistoryEntryPayload[];
}

export interface HistoryOperationResult {
  readonly events: readonly BlueprintEventPayload[];
  readonly status: {
    readonly active: boolean;
    readonly projectSessionId?: string;
    readonly projectId?: string;
    readonly commandSequence: string;
    readonly documentStateId?: string;
    readonly historyCursor?: string;
    readonly canUndo?: boolean;
    readonly canRedo?: boolean;
  };
  readonly history: HistoryStatusPayload;
  readonly entry?: HistoryEntryPayload;
  readonly commandSequence?: string;
  readonly transactionId?: string;
  readonly documentStateId?: string;
  readonly historyCursor?: string;
}

export function normalizeHistoryEvents(value: {
  readonly event?: BlueprintEventPayload;
  readonly events?: readonly BlueprintEventPayload[];
}): readonly BlueprintEventPayload[] {
  return value.events ?? (value.event ? [value.event] : []);
}
