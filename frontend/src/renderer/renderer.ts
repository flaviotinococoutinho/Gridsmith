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
import { panelLabel, projectStateLabel, serviceStateLabel } from "../core/vocabulary.js";
import { ExperienceGate, type ResolvedExperienceLike } from "../core/experienceGate.js";
import type { P7mEditorApi, ProjectStatusPayload, ServiceStatusPayload } from "../main/preload.js";
import { mountLevelEditor } from "./levelEditorView.js";

/** Ações do editor ativo (menu Editar e atalhos globais roteiam para cá). */
const activeEditor: { undo?: () => void; redo?: () => void } = {};

declare global {
  interface Window {
    p7m: P7mEditorApi;
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const model = new WorkbenchModel();
const log = new EventLog(500);

/** Gate da experiência corrente (governança por runtime); definido no boot. */
let experienceGate: ExperienceGate | undefined;
/** Cópia substituível das projeções; resync nunca é tratado como evento incremental. */
let projectionSnapshot: unknown;

// ---------------------------------------------------------------- toolbar

function wireProjectToolbar(): void {
  const run = (command: Parameters<P7mEditorApi["projectCommand"]>[0]) => (): void => {
    void window.p7m.projectCommand(command).then(applyProjectStatus);
  };
  $("btn-new").addEventListener("click", run("new"));
  $("btn-open").addEventListener("click", run("open"));
  $("btn-save").addEventListener("click", run("save"));
  $("btn-close").addEventListener("click", run("close"));
}

function applyProjectStatus(status: ProjectStatusPayload): void {
  $("project-title").textContent = status.project
    ? `${status.isDirty ? "● " : ""}${status.project.name}`
    : "Nenhum projeto aberto";
  $("status-project").textContent = projectStateLabel(status.state);
  const hasProject = status.state !== "no-project";
  ($("btn-save") as HTMLButtonElement).disabled = !hasProject;
  ($("btn-close") as HTMLButtonElement).disabled = !hasProject;
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
  const panel = model.currentPanel;
  if (!panel) {
    host.append(placeholder("Bem-vindo ao P7M", "Crie ou abra um projeto para começar."));
    return;
  }
  if (panel === "level-editor") {
    mountLevelEditor({
      host,
      activeEditor,
      setCleanup: (cleanup) => {
        cleanupActiveView = cleanup;
      },
      gate: experienceGate,
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
    if (action === "undo") activeEditor.undo?.();
    else if (action === "redo") activeEditor.redo?.();
  });
  window.p7m.onServiceStatus(renderServices);
  window.p7m.onBlueprintEvent((event) => {
    log.record(event as { kind: string } & Record<string, unknown>);
    refreshProblemBadge();
    renderBottom();
  });
  window.p7m.onProjectionResync(({ snapshot }) => {
    projectionSnapshot = snapshot;
    // Mantém a reconstrução separada do dirty tracking/event log. Vistas que
    // consomem projeções leem esta referência no próximo render.
    void projectionSnapshot;
    renderView();
  });

  renderServices(await window.p7m.serviceStatus());

  try {
    await window.p7m.connect();
    $("connection-dot").className = "dot online";
    $("status-connection").textContent = "Conectado ao middleware";
    applyProjectStatus(await window.p7m.projectStatus());

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
