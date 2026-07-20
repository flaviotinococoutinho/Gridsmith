/**
 * Eventos de casos de uso do editor que nao sao fatos do Blueprint.
 *
 * Eles podem compartilhar o EventJournal para entrega, mas nunca passam pelo
 * BlueprintStore/CommandHistory e, portanto, nao alteram dirty state. O campo
 * `domain` permite que clientes separem estes eventos antes de interpretar
 * eventos canonicos do documento.
 */

export type EditorApplicationSeverity = "info" | "warning" | "error";

export interface EditorApplicationProgress {
  readonly phase: string;
  readonly current: number;
  readonly total: number;
  readonly percent: number;
  readonly message: string;
}

export type EditorApplicationEventKind =
  | "asset/operationStarted"
  | "asset/operationProgress"
  | "asset/operationCompleted"
  | "asset/operationFailed"
  | "asset/operationCancelled"
  | "asset/catalogChanged";

export interface EditorApplicationEvent {
  readonly domain: "asset";
  readonly kind: EditorApplicationEventKind;
  readonly operationId: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  /** Cursor canonico observado quando a operacao foi iniciada. */
  readonly commandSequence: string;
  readonly progress: EditorApplicationProgress;
  readonly severity: EditorApplicationSeverity;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: number;
}
