/**
 * Renderer do workbench (ALPHA-0.1 P0.3) — a CASCA da aplicação.
 *
 * Organizado para crescer: cada vista mora em seu módulo
 * (renderer/levelEditorView.ts, ...) e recebe CONTEXTO explícito
 * (activeEditor/cleanup/gate) — sem estado de módulo compartilhado entre
 * vistas. A lógica de ferramentas é pura em core/levelEditorTools.ts.
 * Nenhum ID interno aparece: tudo passa pelo vocabulário.
 */

import { EventLog } from "../core/eventLog.js";
import { WorkbenchModel, type BottomTab } from "../core/workbenchModel.js";
import {
  HISTORY_ACTOR_LABELS,
  panelLabel,
  projectStateLabel,
  serviceStateLabel,
} from "../core/vocabulary.js";
import { ExperienceGate, type ResolvedExperienceLike } from "../core/experienceGate.js";
import type { ProjectActionResult } from "../core/projectApi.js";
import type { HistoryStatusPayload } from "../core/editorCommands.js";
import { LevelEditorStore } from "../core/levelEditorStore.js";
import type { LevelEditorProjectionDocument } from "../core/levelEditorProjection.js";
import type { P7mEditorApi, ProjectStatusPayload, ServiceStatusPayload } from "../main/preload.js";
import { mountLevelEditor } from "./levelEditorView.js";
import { showNewProjectWizard } from "./newProjectWizard.js";

declare global {
  interface Window {
    p7m: P7mEditorApi;
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const model = new WorkbenchModel();
const log = new EventLog(500);
const levelStore = new LevelEditorStore();

/** Gate da experiência corrente (governança por runtime); definido no boot. */
let experienceGate: ExperienceGate | undefined;
/** Cópia substituível das projeções; resync nunca é tratado como evento incremental. */
let projectionSnapshot: unknown;
let currentProjectStatus: ProjectStatusPayload | undefined;
let preferredLevelId: string | undefined;
let projectOperationBusy = false;
let currentHistory: HistoryStatusPayload | undefined;

// ---------------------------------------------------------------- toolbar

function wireProjectToolbar(): void {
  $("btn-new").addEventListener("click", () => void startNewProject());
  $("btn-open").addEventListener("click", () => void runProjectAction(() => window.p7m.openProject()));
  $("btn-save").addEventListener("click", () => void runProjectAction(() => window.p7m.saveProject()));
  $("btn-close").addEventListener("click", () => void runProjectAction(() => window.p7m.closeProject()));
}

function applyProjectStatus(status: ProjectStatusPayload): void {
  const previousSession = currentProjectStatus?.project?.projectSessionId;
  currentProjectStatus = status;
  if (!status.project) {
    preferredLevelId = undefined;
    currentHistory = undefined;
  }
  $("project-title").textContent = status.project
    ? `${status.isDirty ? "● " : ""}${status.project.name}`
    : "Nenhum projeto aberto";
  $("status-project").textContent = projectStateLabel(status.state);
  const stableProject = status.state === "open-clean" || status.state === "open-dirty";
  ($("btn-save") as HTMLButtonElement).disabled = !stableProject || projectOperationBusy;
  ($("btn-close") as HTMLButtonElement).disabled = !stableProject || projectOperationBusy;
  ($("btn-new") as HTMLButtonElement).disabled = projectOperationBusy;
  ($("btn-open") as HTMLButtonElement).disabled = projectOperationBusy;
  if (previousSession !== status.project?.projectSessionId || !status.project) {
    if (!status.project) levelStore.replace(undefined, undefined, undefined);
    else void refreshLevelProjection(status.project.projectSessionId);
    renderView();
  }
}

async function refreshLevelProjection(expectedSessionId?: string): Promise<void> {
  try {
    const projection = await window.p7m.query("document") as {
      readonly document?: LevelEditorProjectionDocument;
    };
    const status = currentProjectStatus;
    if (!status || expectedSessionId !== status.project?.projectSessionId) return;
    levelStore.replace(
      projection.document,
      preferredLevelId,
      expectedSessionId
        ? {
            projectSessionId: expectedSessionId,
            commandSequence: status.commandSequence,
          }
        : undefined,
    );
  } catch (error) {
    showProjectError(error);
  }
}

async function startNewProject(): Promise<void> {
  if (projectOperationBusy) return;
  projectOperationBusy = true;
  if (currentProjectStatus) applyProjectStatus(currentProjectStatus);
  clearProjectError();
  try {
    const templates = await window.p7m.listProjectTemplates();
    const request = await showNewProjectWizard(templates);
    if (!request) return;
    applyProjectActionResult(await window.p7m.createProjectFromTemplate(request));
  } catch (error) {
    showProjectError(error);
  } finally {
    projectOperationBusy = false;
    if (currentProjectStatus) applyProjectStatus(currentProjectStatus);
  }
}

async function runProjectAction(
  action: () => Promise<ProjectActionResult>,
): Promise<void> {
  if (projectOperationBusy) return;
  projectOperationBusy = true;
  if (currentProjectStatus) applyProjectStatus(currentProjectStatus);
  clearProjectError();
  try {
    applyProjectActionResult(await action());
  } catch (error) {
    showProjectError(error);
  } finally {
    projectOperationBusy = false;
    if (currentProjectStatus) applyProjectStatus(currentProjectStatus);
  }
}

function applyProjectActionResult(result: ProjectActionResult): void {
  if (result.openedLevelId) preferredLevelId = result.openedLevelId;
  else if (!result.status.project) preferredLevelId = undefined;
  applyProjectStatus(result.status);
  if (result.openedLevelId) model.activatePanel("level-editor");
}

function showProjectError(error: unknown): void {
  const feedback = $("project-feedback");
  feedback.textContent = error instanceof Error ? error.message : String(error);
  feedback.hidden = false;
}

function clearProjectError(): void {
  const feedback = $("project-feedback");
  feedback.textContent = "";
  feedback.hidden = true;
}

// ------------------------------------------------------------------ rail

function renderRail(): void {
  const rail = $("panel-rail");
  rail.replaceChildren();
  for (const item of model.navigation()) {
    const button = document.createElement("button");
    button.className = "rail-item";
    button.textContent = item.label;
    button.setAttribute("aria-pressed", String(item.active));
    button.disabled = !item.enabled;
    if (item.reason) button.title = item.reason; // razão da governança no tooltip
    button.addEventListener("click", () => model.activatePanel(item.panelId));
    rail.append(button);
  }
}

// ----------------------------------------------------------------- views

/** Limpeza da vista corrente (listeners de teclado etc.) ao trocar de painel. */
let cleanupActiveView: (() => void) | undefined;

function renderView(): void {
  const host = $("view-host");
  cleanupActiveView?.();
  cleanupActiveView = undefined;
  host.replaceChildren();
  if (!currentProjectStatus?.project) {
    host.append(projectStartView());
    return;
  }
  const panel = model.currentPanel;
  if (!panel) {
    host.append(placeholder("Bem-vindo ao P7M", "Crie ou abra um projeto para começar."));
    return;
  }
  if (panel === "level-editor") {
    mountLevelEditor({
      host,
      store: levelStore,
      setCleanup: (cleanup) => {
        cleanupActiveView = cleanup;
      },
      gate: experienceGate,
      ...(preferredLevelId ? { preferredLevelId } : {}),
    });
    return;
  }
  host.append(
    placeholder(
      panelLabel(panel),
      "Este painel chega nas próximas iterações da milestone Alpha 0.1.",
    ),
  );
}

function projectStartView(): HTMLElement {
  const view = document.createElement("div");
  view.className = "project-start";
  const title = document.createElement("h1");
  title.textContent = "Comece por um projeto";
  const description = document.createElement("p");
  description.textContent = "Crie um Plataforma 2D, abra um arquivo existente ou explore uma cópia do exemplo.";
  const actions = document.createElement("div");
  actions.className = "project-start-actions";
  actions.append(
    actionButton("Novo projeto", () => void startNewProject(), true),
    actionButton("Abrir projeto…", () => void runProjectAction(() => window.p7m.openProject())),
    actionButton("Abrir exemplo", () => void runProjectAction(() =>
      window.p7m.openProject({ source: "example" }))),
  );
  view.append(title, description, actions);

  const recents = currentProjectStatus?.recents ?? [];
  if (recents.length > 0) {
    const heading = document.createElement("h2");
    heading.textContent = "Recentes";
    const list = document.createElement("div");
    list.className = "recent-list";
    for (const recent of recents) {
      const button = actionButton(recent.name, () => void runProjectAction(() =>
        window.p7m.openRecent(recent.filePath)));
      button.title = recent.filePath;
      const timestamp = document.createElement("small");
      timestamp.textContent = new Date(recent.lastOpenedUnixMs).toLocaleString();
      button.append(timestamp);
      list.append(button);
    }
    view.append(heading, list);
  }
  return view;
}

function actionButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (primary) button.className = "primary";
  button.addEventListener("click", onClick);
  return button;
}

function placeholder(title: string, message: string): HTMLElement {
  const view = document.createElement("div");
  view.className = "placeholder-view";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  const p = document.createElement("p");
  p.textContent = message;
  view.append(h2, p);
  return view;
}

// ---------------------------------------------------------- painel inferior

function wireBottomPanel(): void {
  for (const tabButton of document.querySelectorAll<HTMLButtonElement>("#bottom-tabs [role=tab]")) {
    tabButton.addEventListener("click", () => model.selectBottomTab(tabButton.dataset["tab"] as BottomTab));
  }
  $("log-filter").addEventListener("input", renderBottom);
}

function renderBottom(): void {
  const tab = model.currentBottomTab;
  for (const tabButton of document.querySelectorAll<HTMLButtonElement>("#bottom-tabs [role=tab]")) {
    tabButton.setAttribute("aria-selected", String(tabButton.dataset["tab"] === tab));
  }
  const content = $("bottom-content");
  content.replaceChildren();
  const filterText = ($("log-filter") as HTMLInputElement).value;

  if (tab === "history") {
    const entries = currentHistory?.entries ?? [];
    for (const entry of entries) {
      if (filterText && !`${entry.label} ${entry.actor}`.toLowerCase().includes(filterText.toLowerCase())) continue;
      const row = document.createElement("div");
      row.className = "log-row history-row";
      const state = document.createElement("span");
      state.textContent = entry.applied === false ? "↷" : "✓";
      const label = document.createElement("strong");
      label.textContent = entry.label;
      const actor = document.createElement("span");
      actor.textContent = HISTORY_ACTOR_LABELS[entry.actor];
      const barrier = document.createElement("span");
      barrier.textContent = entry.barrier ? "Barreira" : "";
      row.append(state, label, actor, barrier);
      content.append(row);
    }
    if (entries.length === 0) content.append(placeholder("Histórico vazio", "Nenhuma edição confirmada."));
    return;
  }

  if (tab === "problems") {
    const problems = log
      .list({ ...(filterText ? { text: filterText } : {}) })
      .filter((e) => e.projectionStatus === "skipped" || e.projectionStatus === "deferred");
    if (problems.length === 0) {
      content.append(placeholder("Nenhum problema", "Tudo aplicado no runtime."));
      return;
    }
    for (const entry of problems) {
      const card = document.createElement("div");
      card.className = "problem-card";
      const title = document.createElement("strong");
      title.textContent = entry.summary;
      const reason = document.createElement("div");
      reason.className = "reason";
      reason.textContent = `${entry.projectionLabel}${entry.projectionReason ? ` — ${entry.projectionReason}` : ""}`;
      card.append(title, reason);
      content.append(card);
    }
    return;
  }

  const entries = log.list({ ...(filterText ? { text: filterText } : {}) });
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "log-row";
    const time = document.createElement("time");
    time.textContent = new Date(entry.timestampMs).toLocaleTimeString();
    const label = document.createElement("span");
    label.textContent = entry.summary;
    row.append(time, label);
    if (tab === "output" && entry.projectionLabel) {
      const status = document.createElement("span");
      status.className = `status-${entry.projectionStatus}`;
      status.textContent = entry.projectionLabel;
      row.append(status);
    }
    content.append(row);
  }
}

function refreshProblemBadge(): void {
  const badge = $("problem-count");
  badge.textContent = String(log.problemCount);
  badge.dataset["zero"] = String(log.problemCount === 0);
}

// --------------------------------------------- serviços supervisionados (P0.1)

/**
 * Estados compreensíveis dos serviços na status bar ("Iniciando serviços…",
 * "Conectando ao MonoGame…", "Pronto") + ação corretiva por serviço falho,
 * com as últimas linhas de stderr no tooltip (diagnóstico de dependências).
 */
function renderServices(services: ServiceStatusPayload[]): void {
  const host = $("status-services");
  host.replaceChildren();
  if (services.length === 0) return; // --external-services: nada a supervisar

  for (const service of services) {
    const chip = document.createElement("span");
    chip.className = `service-chip state-${service.state}`;
    chip.textContent = `${service.displayName}: ${serviceStateLabel(service.state)}`;
    const diagnostics = [service.detail, ...service.recentLog].filter(Boolean).join("\n");
    if (diagnostics) chip.title = diagnostics;
    host.append(chip);

    if (service.state === "failed" || service.state === "retrying") {
      const retry = document.createElement("button");
      retry.textContent = `Reiniciar ${service.displayName}`;
      retry.addEventListener("click", () => {
        retry.disabled = true;
        void window.p7m.serviceRestart(service.id).finally(() => {
          retry.disabled = false;
        });
      });
      host.append(retry);
    }
  }
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  wireProjectToolbar();
  wireBottomPanel();
  model.onChange(() => {
    renderRail();
    renderView();
    renderBottom();
  });
  renderRail();
  renderView();
  renderBottom();

  window.p7m.onProjectStatus(applyProjectStatus);
  window.p7m.onMenuAction((action) => {
    if (action === "undo") void runHistoryAction(() => window.p7m.undo());
    else if (action === "redo") void runHistoryAction(() => window.p7m.redo());
    else if (action === "new") void startNewProject();
    else if (action === "open") void runProjectAction(() => window.p7m.openProject());
    else if (action === "open-example") void runProjectAction(() =>
      window.p7m.openProject({ source: "example" }));
  });
  window.p7m.onServiceStatus(renderServices);
  window.p7m.onBlueprintEvent((event) => {
    levelStore.applyEvent(event);
    log.record(event as { kind: string } & Record<string, unknown>);
    refreshProblemBadge();
    renderBottom();
    void refreshHistory();
  });
  window.p7m.onProjectionResync(({ snapshot }) => {
    projectionSnapshot = snapshot;
    const document = projectionDocument(snapshot);
    levelStore.replace(document, preferredLevelId, projectionCursor(snapshot));
    renderView();
  });

  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      void runHistoryAction(() => event.shiftKey ? window.p7m.redo() : window.p7m.undo());
    } else if (key === "y") {
      event.preventDefault();
      void runHistoryAction(() => window.p7m.redo());
    }
  });

  renderServices(await window.p7m.serviceStatus());

  try {
    await window.p7m.connect();
    $("connection-dot").className = "dot online";
    $("status-connection").textContent = "Conectado ao middleware";
    applyProjectStatus(await window.p7m.projectStatus());
    await refreshHistory();

    const experience = (await window.p7m.experience()) as ResolvedExperienceLike;
    experienceGate = new ExperienceGate(experience);
    model.applyExperience(experience);
    $("runtime-label").textContent = model.runtimeLabel;
  } catch (err) {
    $("connection-dot").className = "dot offline";
    $("status-connection").textContent =
      `Sem conexão com o middleware — verifique os serviços e tente novamente. (${err instanceof Error ? err.message : err})`;
    const retry = document.createElement("button");
    retry.textContent = "Tentar reconectar";
    retry.addEventListener("click", () => window.location.reload());
    $("status-bar").append(retry);
  }
}

void boot();

async function runHistoryAction(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    await refreshHistory();
  } catch (error) {
    showProjectError(error);
  }
}

async function refreshHistory(): Promise<void> {
  if (!currentProjectStatus?.project) {
    currentHistory = undefined;
    renderBottom();
    return;
  }
  try {
    currentHistory = await window.p7m.historyStatus(100);
    renderBottom();
  } catch {
    // O event pump tentará novamente no próximo evento/resync.
  }
}

function projectionDocument(snapshot: unknown): LevelEditorProjectionDocument | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const projections = (snapshot as { projections?: Record<string, unknown> }).projections;
  const documentProjection = projections?.["document"];
  if (!documentProjection || typeof documentProjection !== "object") return undefined;
  return (documentProjection as { document?: LevelEditorProjectionDocument }).document;
}

function projectionCursor(snapshot: unknown):
  { projectSessionId: string; commandSequence: string } | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const status = (snapshot as { status?: Record<string, unknown> }).status;
  return status &&
    typeof status["projectSessionId"] === "string" &&
    typeof status["commandSequence"] === "string"
    ? {
        projectSessionId: status["projectSessionId"],
        commandSequence: status["commandSequence"],
      }
    : undefined;
}
