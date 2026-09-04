/**
 * Preload: expõe a API do editor ao renderer com contextIsolation.
 * O renderer nunca vê Node/rede — só esta superfície tipada.
 */

import { contextBridge, ipcRenderer } from "electron";

export interface ProjectStatusPayload {
  state: string;
  windowTitle: string;
  isDirty: boolean;
  project?: {
    filePath?: string;
    name: string;
    projectSessionId?: string;
    projectId?: string;
  };
  recents: Array<{ filePath: string; name: string; lastOpenedUnixMs: number }>;
  /** Verdade do runtime da sessão ativa; ausente sem projeto aberto. */
  runtimeState?: "synchronized" | "deferred" | "failed";
  /** Aviso pontual (ex.: recuperação restaurada). */
  notice?: string;
}

/** Resultado da aplicação de um evento no runtime (metadado de transporte). */
export interface EventProjectionPayload {
  status: string;
  reason?: string;
}

/** Estado de um serviço supervisionado (P0.1) + últimas linhas de log. */
export interface ServiceStatusPayload {
  id: string;
  displayName: string;
  state: string;
  attempts: number;
  detail?: string;
  checks?: Readonly<Record<string, "pending" | "active" | "inactive" | "authentication-failed">>;
  recentLog: string[];
}

export interface GridsmithEditorApi {
  connect(): Promise<{ sessionId: string }>;
  dispatch(kind: string, payload: Record<string, unknown>): Promise<unknown>;
  query(projection: string): Promise<unknown>;
  experience(family?: string, version?: string): Promise<unknown>;
  onBlueprintEvent(
    listener: (
      event: {
        kind: string;
        projectSessionId: string;
        projectId: string;
        commandSequence: string;
      },
      projection?: EventProjectionPayload,
    ) => void,
  ): void;
  /** Snapshot completo após restart/gap; substitui o estado projetado local. */
  onProjectionResync(
    listener: (payload: { snapshot: unknown; record: { reason: string } }) => void,
  ): void;
  // ---- ciclo de vida do projeto (ALPHA-0.1 P0.2) ----
  /**
   * New/Open/Save/Save As/Close disparados pela UI; diálogos vivem no main.
   * `templateId` em "new" pula o diálogo de escolha (automação/e2e).
   */
  projectCommand(
    command: "new" | "open" | "openPath" | "openExample" | "save" | "saveAs" | "close",
    payload?: { filePath?: string; templateId?: string },
  ): Promise<ProjectStatusPayload>;
  projectStatus(): Promise<ProjectStatusPayload>;
  /**
   * Histórico global (documento v4). O `historyCursor` é o compare-and-swap:
   * mandar o cursor que a UI viu recusa o desfazer se outra borda (um agente
   * via MCP, por exemplo) editou nesse meio-tempo.
   */
  historyStatus(limit?: number): Promise<unknown>;
  undo(historyCursor?: string): Promise<unknown>;
  redo(historyCursor?: string): Promise<unknown>;
  /**
   * Imagem de atlas como data URL, lida pelo main DENTRO do diretório do
   * projeto aberto (referência fora dele é recusada). `undefined` = sem arte:
   * o canvas cai para a cor determinística conjunta do host.
   */
  readAtlasImage(imageReference: string): Promise<string | undefined>;
  /** Templates de projeto para a tela inicial (cards de "Novo projeto"). */
  projectTemplates(): Promise<{
    templates: Array<{ id: string; label: string; description: string }>;
  }>;
  /**
   * O exemplo versionado está instalado? A tela inicial só oferece "Abrir
   * exemplo" quando sim — o botão é derivado desta resposta.
   */
  exampleAvailable(): Promise<boolean>;
  onProjectStatus(listener: (status: ProjectStatusPayload) => void): void;
  /** Ações do menu nativo roteadas ao renderer (undo/redo do editor ativo). */
  onMenuAction(listener: (action: "undo" | "redo") => void): void;
  // ---- supervisão de processos (ALPHA-0.1 P0.1) ----
  serviceStatus(): Promise<ServiceStatusPayload[]>;
  /** Reinicia um serviço isolado (engine caída → projeto preservado). */
  serviceRestart(serviceId: string): Promise<boolean>;
  onServiceStatus(listener: (services: ServiceStatusPayload[]) => void): void;
  /** Diagnóstico técnico; não é usado pela interface normal do editor. */
  technicalDiagnostics(): Promise<unknown>;
}

const api: GridsmithEditorApi = {
  connect: () => ipcRenderer.invoke("gridsmith:connect"),
  dispatch: (kind, payload) => ipcRenderer.invoke("gridsmith:dispatch", kind, payload),
  query: (projection) => ipcRenderer.invoke("gridsmith:query", projection),
  experience: (family, version) => ipcRenderer.invoke("gridsmith:experience", family, version),
  onBlueprintEvent: (listener) => {
    ipcRenderer.on("gridsmith:blueprint-event", (_event, payload, projection) =>
      listener(payload, projection),
    );
  },
  onProjectionResync: (listener) => {
    ipcRenderer.on("gridsmith:projection-resync", (_event, payload) => listener(payload));
  },
  projectCommand: (command, payload) => ipcRenderer.invoke("gridsmith:project-command", command, payload),
  projectStatus: () => ipcRenderer.invoke("gridsmith:project-status"),
  historyStatus: (limit?: number) => ipcRenderer.invoke("gridsmith:history-status", limit),
  undo: (historyCursor?: string) => ipcRenderer.invoke("gridsmith:history-undo", historyCursor),
  redo: (historyCursor?: string) => ipcRenderer.invoke("gridsmith:history-redo", historyCursor),
  readAtlasImage: (imageReference) => ipcRenderer.invoke("gridsmith:atlas-image", imageReference),
  projectTemplates: () => ipcRenderer.invoke("gridsmith:project-templates"),
  exampleAvailable: () => ipcRenderer.invoke("gridsmith:example-available"),
  onProjectStatus: (listener) => {
    ipcRenderer.on("gridsmith:project-status", (_event, status) => listener(status));
  },
  onMenuAction: (listener) => {
    ipcRenderer.on("gridsmith:menu-action", (_event, action) => listener(action));
  },
  serviceStatus: () => ipcRenderer.invoke("gridsmith:service-status"),
  serviceRestart: (serviceId) => ipcRenderer.invoke("gridsmith:service-restart", serviceId),
  onServiceStatus: (listener) => {
    ipcRenderer.on("gridsmith:service-status", (_event, services) => listener(services));
  },
  technicalDiagnostics: () => ipcRenderer.invoke("gridsmith:technical-diagnostics"),
};

contextBridge.exposeInMainWorld("gridsmith", api);
