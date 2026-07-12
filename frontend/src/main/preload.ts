/**
 * Preload: expõe a API do editor ao renderer com contextIsolation.
 * O renderer nunca vê Node/rede — só esta superfície tipada.
 */

import { contextBridge, ipcRenderer } from "electron";

export interface ProjectStatusPayload {
  state: string;
  windowTitle: string;
  isDirty: boolean;
  project?: { filePath?: string; name: string };
  recents: Array<{ filePath: string; name: string; lastOpenedUnixMs: number }>;
}

export interface P7mEditorApi {
  connect(): Promise<{ sessionId: string }>;
  dispatch(kind: string, payload: Record<string, unknown>): Promise<unknown>;
  query(projection: string): Promise<unknown>;
  experience(family?: string, version?: string): Promise<unknown>;
  onBlueprintEvent(listener: (event: { kind: string }) => void): void;
  // ---- ciclo de vida do projeto (ALPHA-0.1 P0.2) ----
  /** New/Open/Save/Save As/Close disparados pela UI; diálogos vivem no main. */
  projectCommand(
    command: "new" | "open" | "openPath" | "save" | "saveAs" | "close",
    payload?: { filePath?: string },
  ): Promise<ProjectStatusPayload>;
  projectStatus(): Promise<ProjectStatusPayload>;
  onProjectStatus(listener: (status: ProjectStatusPayload) => void): void;
  /** Ações do menu nativo roteadas ao renderer (undo/redo do editor ativo). */
  onMenuAction(listener: (action: "undo" | "redo") => void): void;
}

const api: P7mEditorApi = {
  connect: () => ipcRenderer.invoke("p7m:connect"),
  dispatch: (kind, payload) => ipcRenderer.invoke("p7m:dispatch", kind, payload),
  query: (projection) => ipcRenderer.invoke("p7m:query", projection),
  experience: (family, version) => ipcRenderer.invoke("p7m:experience", family, version),
  onBlueprintEvent: (listener) => {
    ipcRenderer.on("p7m:blueprint-event", (_event, payload) => listener(payload));
  },
  projectCommand: (command, payload) => ipcRenderer.invoke("p7m:project-command", command, payload),
  projectStatus: () => ipcRenderer.invoke("p7m:project-status"),
  onProjectStatus: (listener) => {
    ipcRenderer.on("p7m:project-status", (_event, status) => listener(status));
  },
  onMenuAction: (listener) => {
    ipcRenderer.on("p7m:menu-action", (_event, action) => listener(action));
  },
};

contextBridge.exposeInMainWorld("p7m", api);
