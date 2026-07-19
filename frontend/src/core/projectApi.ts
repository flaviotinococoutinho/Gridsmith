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
  readonly commandSequence: string;
  readonly documentStateId?: string;
  readonly historyCursor?: string;
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
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

/**
 * Invocação de um comando registrado no renderer.
 *
 * O contrato é deliberadamente extensível: o processo main só conhece o id e
 * os argumentos serializáveis da contribuição. Disponibilidade, atalhos e a
 * execução pertencem ao CommandRegistry, que por sua vez chama estas APIs
 * tipadas para preservar os gates do ProjectController.
 */
export interface ProjectCommandInvocation<TArguments = unknown> {
  readonly commandId: string;
  readonly args?: TArguments;
  /** Intents do SO são serializados; cliques comuns podem ser recusados quando ocupados. */
  readonly source?: "native-menu" | "external-open";
}

/**
 * Representa somente os dados necessários para espelhar uma contribuição do
 * CommandRegistry no menu nativo. Funções, capabilities e argumentos nunca
 * atravessam o boundary Electron.
 *
 * `menuPath` preserva o path semântico completo do placement (por exemplo
 * `["Arquivo", "Salvar"]`). O último segmento localiza o item, mas o texto
 * exibido é sempre `label`; nenhum segmento pode ser interpretado como role ou
 * outro tipo de MenuItem Electron.
 */
export interface NativeMenuCommandDescriptor {
  readonly id: string;
  readonly label: string;
  readonly menuPath: readonly string[];
  readonly order?: number;
  readonly accelerator?: string;
  readonly enabled: boolean;
  /** Diagnóstico mostrado pelo menu quando o comando está indisponível. */
  readonly reason?: string;
}

/** Confirma a substituição atômica da última projeção válida do renderer. */
export interface NativeMenuProjectionResult {
  readonly acceptedCommandCount: number;
}

export type ProjectClosePreflightReason = "project-close" | "window-close";

export interface ProjectClosePreflightRequest {
  readonly requestId: string;
  readonly reason: ProjectClosePreflightReason;
  readonly deadlineUnixMs: number;
}

export type ProjectClosePreflightResponse =
  | { readonly requestId: string; readonly status: "ready" }
  | { readonly requestId: string; readonly status: "rejected"; readonly reason: string };

export type ProjectClosePreflightHandler = (
  request: ProjectClosePreflightRequest,
) => void | Promise<void>;

/** Canais internos compartilhados apenas para impedir divergência main/preload. */
export const PROJECT_CLOSE_PREFLIGHT_CHANNELS = Object.freeze({
  request: "p7m:project-close-preflight-request",
  response: "p7m:project-close-preflight-response",
});

/** IDs das contribuições acionadas pelas superfícies nativas do Electron. */
export const PROJECT_COMMAND_IDS = {
  new: "project.new",
  open: "project.open",
  openExample: "project.openExample",
  openRecent: "project.openRecent",
  save: "project.save",
  saveAs: "project.saveAs",
  close: "project.close",
  undo: "history.undo",
  redo: "history.redo",
} as const;

/** @deprecated Use ProjectCommandInvocation. Mantido para consumidores 0.1. */
export type ProjectMenuAction = ProjectCommandInvocation;
