/** Contratos tipados compartilhados pelo main/preload/renderer. */

import type { ProjectState, RecentProject } from "./projectLifecycle.js";

/** Limite do campo `level.tileSize` publicado pelo runtime MonoGame. */
export const MAX_PROJECT_TILE_SIZE = 256;

export interface ProjectTemplateDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly preview: {
    readonly kind: "level-schematic";
    readonly widthCells: number;
    readonly heightCells: number;
    readonly playerCell: readonly [number, number];
    readonly accent: string;
  };
  readonly defaults: {
    readonly referenceResolution: { readonly width: number; readonly height: number };
    readonly tileSize: number;
  };
}

export interface ProjectStatusPayload {
  readonly state: ProjectState;
  readonly windowTitle: string;
  readonly isDirty: boolean;
  readonly project?: {
    readonly filePath?: string;
    readonly name: string;
    readonly projectSessionId?: string;
    readonly projectId?: string;
    readonly recoverySourceFilePath?: string;
  };
  readonly recents: readonly RecentProject[];
}

export interface CreateProjectFromTemplateRequest {
  readonly templateId: string;
  readonly name: string;
  readonly referenceResolution: {
    readonly width: number;
    readonly height: number;
  };
  readonly tileSize: number;
}

export interface OpenProjectRequest {
  readonly filePath?: string;
  readonly source?: "file" | "example";
}

export interface ProjectActionResult {
  readonly status: ProjectStatusPayload;
  readonly outcome: "completed" | "cancelled" | "already-open";
  readonly openedLevelId?: string;
}

export interface RestoreAutosaveRequest {
  readonly filePath: string;
  readonly mode: "restore" | "copy";
}

export interface DiscardAutosaveRequest {
  readonly filePath: string;
}

export type ProjectMenuAction = "new" | "open" | "open-example" | "undo" | "redo";
