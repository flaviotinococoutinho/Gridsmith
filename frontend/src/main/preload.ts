/**
 * Preload: expõe a API do editor ao renderer com contextIsolation.
 * O renderer nunca vê Node/rede — só esta superfície tipada.
 */

import { contextBridge, ipcRenderer } from "electron";
import { PROJECT_CLOSE_PREFLIGHT_CHANNELS } from "../core/projectApi.js";
import type {
  CreateProjectFromTemplateRequest,
  DiscardAutosaveRequest,
  NativeMenuCommandDescriptor,
  NativeMenuProjectionResult,
  OpenProjectRequest,
  ProjectActionResult,
  ProjectClosePreflightHandler,
  ProjectClosePreflightRequest,
  ProjectClosePreflightResponse,
  ProjectCommandInvocation,
  ProjectStatusPayload,
  ProjectTemplateDescriptor,
  RestoreAutosaveRequest,
} from "../core/projectApi.js";
import type {
  BlueprintEventPayload,
  DispatchOutcome,
  HistoryOperationResult,
  HistoryStatusPayload,
} from "../core/editorCommands.js";
import type { CapturedProjectSnapshot } from "./EditorClient.js";

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
  dispatch(kind: string, payload: Record<string, unknown>): Promise<DispatchOutcome>;
  query(projection: string): Promise<unknown>;
  /** Documento + sessão + commandSequence capturados sob a mesma barreira. */
  captureProjectSnapshot(expectedProjectSessionId: string): Promise<CapturedProjectSnapshot>;
  experience(family?: string, version?: string): Promise<unknown>;
  onBlueprintEvent(
    listener: (event: BlueprintEventPayload) => void,
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
  /** Invocações do menu/shell nativos roteadas ao CommandRegistry do renderer. */
  onMenuAction(listener: (invocation: ProjectCommandInvocation) => void): void;
  /** Substitui atomicamente a projeção serializável do CommandRegistry no main. */
  updateNativeMenu(
    commands: readonly NativeMenuCommandDescriptor[],
  ): Promise<NativeMenuProjectionResult>;
  /**
   * Registra o único preflight de Close. O wiring deve desfocar o controle
   * ativo e aguardar PendingEditCoordinator.flush(); rejeição cancela Close.
   */
  onProjectClosePreflight(handler: ProjectClosePreflightHandler): void;
  /** Histórico global da sessão, independente do painel ativo. */
  undo(): Promise<HistoryOperationResult>;
  redo(): Promise<HistoryOperationResult>;
  historyStatus(limit?: number): Promise<HistoryStatusPayload>;
  /** Gate de Save/autosave/Close enquanto um pointer gesture está aberto. */
  beginEditGesture(transactionId: string): void;
  endEditGesture(transactionId: string): void;
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
  captureProjectSnapshot: (expectedProjectSessionId) =>
    ipcRenderer.invoke("p7m:capture-project-snapshot", expectedProjectSessionId),
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
    ipcRenderer.on("p7m:menu-action", (_event, invocation) => listener(invocation));
  },
  updateNativeMenu: (commands) => ipcRenderer.invoke("p7m:update-native-menu", commands),
  onProjectClosePreflight: (handler) => {
    projectClosePreflightHandler = handler;
  },
  undo: () => ipcRenderer.invoke("p7m:history-undo"),
  redo: () => ipcRenderer.invoke("p7m:history-redo"),
  historyStatus: (limit) => ipcRenderer.invoke("p7m:history-status", limit),
  beginEditGesture: (transactionId) => ipcRenderer.send("p7m:gesture-begin", transactionId),
  endEditGesture: (transactionId) => ipcRenderer.send("p7m:gesture-end", transactionId),
  serviceStatus: () => ipcRenderer.invoke("p7m:service-status"),
  serviceRestart: (serviceId) => ipcRenderer.invoke("p7m:service-restart", serviceId),
  onServiceStatus: (listener) => {
    ipcRenderer.on("p7m:service-status", (_event, services) => listener(services));
  },
  technicalDiagnostics: () => ipcRenderer.invoke("p7m:technical-diagnostics"),
};

let projectClosePreflightHandler: ProjectClosePreflightHandler | undefined;

ipcRenderer.on(PROJECT_CLOSE_PREFLIGHT_CHANNELS.request, (_event, value: unknown) => {
  const request = projectClosePreflightRequest(value);
  if (!request) return;
  void respondToProjectClosePreflight(request);
});

async function respondToProjectClosePreflight(
  request: ProjectClosePreflightRequest,
): Promise<void> {
  let response: ProjectClosePreflightResponse;
  try {
    if (Date.now() > request.deadlineUnixMs) throw new Error("A solicitação de fechamento expirou.");
    if (!projectClosePreflightHandler) {
      throw new Error("O editor ainda não registrou a confirmação de alterações pendentes.");
    }
    await projectClosePreflightHandler(request);
    response = { requestId: request.requestId, status: "ready" };
  } catch (error) {
    response = {
      requestId: request.requestId,
      status: "rejected",
      reason: safePreflightReason(error),
    };
  }
  ipcRenderer.send(PROJECT_CLOSE_PREFLIGHT_CHANNELS.response, response);
}

function projectClosePreflightRequest(value: unknown): ProjectClosePreflightRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["requestId"] !== "string" ||
    !["project-close", "window-close"].includes(candidate["reason"] as string) ||
    typeof candidate["deadlineUnixMs"] !== "number" ||
    !Number.isFinite(candidate["deadlineUnixMs"])
  ) return undefined;
  return candidate as unknown as ProjectClosePreflightRequest;
}

function safePreflightReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, " ")
    .trim()
    .slice(0, 240);
  return message || "A edição pendente não pôde ser confirmada.";
}

contextBridge.exposeInMainWorld("p7m", api);
