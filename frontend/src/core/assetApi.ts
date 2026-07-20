/**
 * Contrato transport-neutral do catálogo de assets. O GraphQL é o baseline
 * completo; estes tipos não expõem detalhes do transporte ao renderer.
 */

export interface AssetCatalogFilter {
  readonly search?: string;
  readonly tags?: readonly string[];
  readonly directory?: string;
}

export interface AssetSummary {
  readonly assetId: string;
  readonly kind: string;
  readonly name: string;
  readonly revision: number;
  readonly sourcePath: string;
  readonly directory: string;
  readonly tags: readonly string[];
  readonly thumbnailPath?: string;
  /** Preview seguro para o renderer. Nunca contém URL file://. */
  readonly thumbnailDataUrl?: string;
  readonly spritesheetPng?: string;
  readonly compiledXnb?: string;
  readonly clipCount: number;
  /** Decimal unix-ms no wire. */
  readonly updatedAt: string;
}

export interface AssetCatalogResult {
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly assets: readonly AssetSummary[];
  readonly tags: readonly string[];
  readonly directories: readonly string[];
}

export interface AssetSpriteFrame {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly durationMs: number;
}

export type AssetClipDirection = "forward" | "reverse" | "pingpong";

export interface AssetAnimationClip {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly direction: AssetClipDirection;
  readonly playback: readonly number[];
  readonly durationMs: number;
}

export interface AssetRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface AssetPoint {
  readonly x: number;
  readonly y: number;
}

export interface AssetSpriteSlice {
  readonly name: string;
  readonly bounds: AssetRect;
  readonly center?: AssetRect;
  readonly pivot?: AssetPoint;
}

export interface AssetDetails {
  readonly asset: AssetSummary;
  readonly payload: unknown;
  readonly frames: readonly AssetSpriteFrame[];
  readonly clips: readonly AssetAnimationClip[];
  /** Alias explícito para consumidores que usam o vocabulário do Aseprite. */
  readonly frameTags: readonly AssetAnimationClip[];
  readonly slices: readonly AssetSpriteSlice[];
}

export interface AssetImportInput {
  readonly sourcePath: string;
  readonly targetDirectory?: string;
  readonly tags?: readonly string[];
  readonly operationId?: string;
}

export type AssetOperationStatus =
  | "accepted"
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "ignored";

export type AssetOperationKind = "import" | "reimport";

export interface AssetOperationResult {
  readonly operationId: string;
  readonly operation: AssetOperationKind;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly assetId?: string;
  readonly status: AssetOperationStatus;
  readonly message?: string;
}

export interface AssetRemoveResult {
  readonly operationId: string;
  readonly assetId: string;
  readonly removed: boolean;
  readonly filesPreserved: boolean;
  readonly asset?: AssetSummary;
}

export type AssetToolScope = "project" | "user";

export interface AssetToolConfigurationInput {
  readonly scope: AssetToolScope;
  readonly asepritePath?: string;
  readonly mgcbPath?: string;
}

export interface AssetToolConfiguration {
  readonly scope: AssetToolScope;
  readonly projectId: string;
  readonly asepritePath: string;
  readonly mgcbPath: string;
  readonly aseprite: AssetToolDetection;
  readonly mgcb: AssetToolDetection;
  readonly persisted: boolean;
}

export interface AssetToolDetection {
  readonly path: string;
  readonly available: boolean;
  readonly version?: string;
  readonly message: string;
  readonly source: "project" | "user" | "default";
  readonly testedAt: string;
}

export interface AssetRevealResult {
  readonly operationId: string;
  readonly assetId?: string;
  readonly sourceOperationId?: string;
  readonly target: "source" | "output";
  readonly path: string;
  readonly revealed: boolean;
}

export type AssetSourceReference =
  | { readonly assetId: string; readonly operationId?: never }
  | { readonly operationId: string; readonly assetId?: never };

export type AssetCancellationStatus =
  | "cancellation-requested"
  | "already-finished"
  | "not-found";

export interface AssetCancelResult {
  readonly operationId: string;
  readonly status: AssetCancellationStatus;
  readonly cancelled: boolean;
}

export type EditorApplicationEventSeverity = "info" | "warning" | "error";

export interface EditorApplicationProgress {
  readonly phase: string;
  readonly current: number;
  readonly total: number;
  readonly percent: number;
  readonly message: string;
}

/** Evento operacional: deliberadamente separado do histórico do Blueprint. */
export interface EditorApplicationEvent {
  readonly seq: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
  readonly domain: string;
  readonly kind: string;
  readonly operationId?: string;
  readonly progress?: EditorApplicationProgress;
  readonly severity: EditorApplicationEventSeverity;
  readonly payload: unknown;
  /** Decimal unix-ms no wire. */
  readonly timestamp: string;
}
