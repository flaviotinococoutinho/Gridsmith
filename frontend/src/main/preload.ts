/**
 * Preload: expõe a API do editor ao renderer com contextIsolation.
 * O renderer nunca vê Node/rede — só esta superfície tipada.
 */

import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateProjectFromTemplateRequest,
  DiscardAutosaveRequest,
  OpenProjectRequest,
  ProjectActionResult,
  ProjectMenuAction,
  ProjectStatusPayload,
  ProjectTemplateDescriptor,
  RestoreAutosaveRequest,
} from "../core/projectApi.js";

export type { ProjectStatusPayload } from "../core/projectApi.js";

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

export interface P7mEditorApi {
  connect(): Promise<{ sessionId: string }>;
  dispatch(kind: string, payload: Record<string, unknown>): Promise<unknown>;
  query(projection: string): Promise<unknown>;
  experience(family?: string, version?: string): Promise<unknown>;
  onBlueprintEvent(
    listener: (event: {
      kind: string;
      projectSessionId: string;
      projectId: string;
      commandSequence: string;
    }) => void,
  ): void;
  /** Snapshot completo após restart/gap; substitui o estado projetado local. */
  onProjectionResync(
    listener: (payload: { snapshot: unknown; record: { reason: string } }) => void,
  ): void;
  // ---- ciclo de vida do projeto: somente operações nomeadas e tipadas ----
  listProjectTemplates(): Promise<ProjectTemplateDescriptor[]>;
  createProjectFromTemplate(request: CreateProjectFromTemplateRequest): Promise<ProjectActionResult>;
  openProject(request?: OpenProjectRequest): Promise<ProjectActionResult>;
  saveProject(): Promise<ProjectActionResult>;
  saveProjectAs(): Promise<ProjectActionResult>;
  closeProject(): Promise<ProjectActionResult>;
  restoreAutosave(request: RestoreAutosaveRequest): Promise<ProjectActionResult>;
  discardAutosave(request: DiscardAutosaveRequest): Promise<ProjectActionResult>;
  openRecent(filePath: string): Promise<ProjectActionResult>;
  projectStatus(): Promise<ProjectStatusPayload>;
  onProjectStatus(listener: (status: ProjectStatusPayload) => void): void;
  /** Ações do menu nativo roteadas ao renderer (undo/redo do editor ativo). */
  onMenuAction(listener: (action: ProjectMenuAction) => void): void;
  // ---- supervisão de processos (ALPHA-0.1 P0.1) ----
  serviceStatus(): Promise<ServiceStatusPayload[]>;
  /** Reinicia um serviço isolado (engine caída → projeto preservado). */
  serviceRestart(serviceId: string): Promise<boolean>;
  onServiceStatus(listener: (services: ServiceStatusPayload[]) => void): void;
  /** Diagnóstico técnico; não é usado pela interface normal do editor. */
  technicalDiagnostics(): Promise<unknown>;
}

const api: P7mEditorApi = {
  connect: () => ipcRenderer.invoke("p7m:connect"),
  dispatch: (kind, payload) => ipcRenderer.invoke("p7m:dispatch", kind, payload),
  query: (projection) => ipcRenderer.invoke("p7m:query", projection),
  experience: (family, version) => ipcRenderer.invoke("p7m:experience", family, version),
  onBlueprintEvent: (listener) => {
    ipcRenderer.on("p7m:blueprint-event", (_event, payload) => listener(payload));
  },
  onProjectionResync: (listener) => {
    ipcRenderer.on("p7m:projection-resync", (_event, payload) => listener(payload));
  },
  listProjectTemplates: () => ipcRenderer.invoke("p7m:list-project-templates"),
  createProjectFromTemplate: (request) =>
    ipcRenderer.invoke("p7m:create-project-from-template", request),
  openProject: (request) => ipcRenderer.invoke("p7m:open-project", request),
  saveProject: () => ipcRenderer.invoke("p7m:save-project"),
  saveProjectAs: () => ipcRenderer.invoke("p7m:save-project-as"),
  closeProject: () => ipcRenderer.invoke("p7m:close-project"),
  restoreAutosave: (request) => ipcRenderer.invoke("p7m:restore-autosave", request),
  discardAutosave: (request) => ipcRenderer.invoke("p7m:discard-autosave", request),
  openRecent: (filePath) => ipcRenderer.invoke("p7m:open-recent", filePath),
  projectStatus: () => ipcRenderer.invoke("p7m:project-status"),
  onProjectStatus: (listener) => {
    ipcRenderer.on("p7m:project-status", (_event, status) => listener(status));
  },
  onMenuAction: (listener) => {
    ipcRenderer.on("p7m:menu-action", (_event, action) => listener(action));
  },
  serviceStatus: () => ipcRenderer.invoke("p7m:service-status"),
  serviceRestart: (serviceId) => ipcRenderer.invoke("p7m:service-restart", serviceId),
  onServiceStatus: (listener) => {
    ipcRenderer.on("p7m:service-status", (_event, services) => listener(services));
  },
  technicalDiagnostics: () => ipcRenderer.invoke("p7m:technical-diagnostics"),
};

contextBridge.exposeInMainWorld("p7m", api);
