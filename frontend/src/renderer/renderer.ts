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
  panelLabel,
  projectStateLabel,
  runtimeStateLabel,
  serviceStateLabel,
} from "../core/vocabulary.js";
import { presentError } from "../core/errorCatalog.js";
import { ExperienceGate, type ResolvedExperienceLike } from "../core/experienceGate.js";
import type { P7mEditorApi, ProjectStatusPayload, ServiceStatusPayload } from "../main/preload.js";
import { mountLevelEditor } from "./levelEditorView.js";
import { mountWelcome } from "./welcomeView.js";
import { describeWelcome } from "../core/welcomeModel.js";
import type { ProjectState, RecentProject } from "../core/projectLifecycle.js";

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
/** Última verdade do runtime conhecida; o painel Problemas não mente sobre ela. */
let lastRuntimeState: ProjectStatusPayload["runtimeState"];
/** Recentes e templates alimentam a tela inicial; chegam pelo status/IPC. */
let lastRecents: readonly RecentProject[] = [];
let lastTemplates: Array<{ id: string; label: string; description: string }> = [];
let connected = false;

const PROJECT_STATES: readonly ProjectState[] = [
  "no-project",
  "opening",
  "open-clean",
  "open-dirty",
  "saving",
  "closing",
];

/** A borda entrega `state` como string livre; estreitar evita estado inventado. */
function narrowProjectState(state: string): ProjectState {
  return PROJECT_STATES.find((s) => s === state) ?? "no-project";
}

const PROJECTION_STATUSES = ["projected", "skipped", "deferred"] as const;
type ProjectionStatus = (typeof PROJECTION_STATUSES)[number];

/**
 * A borda de IPC entrega `status: string`. Estreitar aqui — e descartar o que
 * não reconhecemos — evita que um status desconhecido vire rótulo inventado.
 */
function narrowProjection(
  projection: { status: string; reason?: string } | undefined,
): { status: ProjectionStatus; reason?: string } | undefined {
  if (!projection) return undefined;
  const status = PROJECTION_STATUSES.find((s) => s === projection.status);
  if (!status) return undefined;
  return { status, ...(projection.reason ? { reason: projection.reason } : {}) };
}

/**
 * Ausência de problema NO LOG não significa "tudo aplicado": a sessão pode
 * estar pendente ou com falha, e o log só cobre a janela desta sessão de UI.
 */
function problemsEmptyHint(): string {
  if (lastRuntimeState === "failed") {
    return "A sessão de runtime falhou — nada novo está sendo aplicado.";
  }
  if (lastRuntimeState === "deferred") {
    return "Há trabalho pendente de aplicação no runtime.";
  }
  if (lastRuntimeState === "synchronized") return "Tudo aplicado no runtime.";
  return "Sem projeto aberto ou runtime ainda não informou seu estado.";
}

// ---------------------------------------------------------------- toolbar

function wireProjectToolbar(): void {
  const run = (command: Parameters<P7mEditorApi["projectCommand"]>[0]) => (): void => {
    // Toda falha do ciclo de vida do projeto chega ao usuário com causa e
    // ação — antes virava unhandled rejection e sumia.
    void window.p7m
      .projectCommand(command)
      .then((status) => {
        dismissError();
        applyProjectStatus(status);
      })
      .catch((error: unknown) => showError(error));
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
  applyRuntimeState(status.runtimeState);

  // aviso pontual da recuperação: aparece uma vez, no lugar onde o usuário já
  // olha para saber o estado do projeto
  if (status.notice) $("status-project").textContent = status.notice;

  lastRecents = (status.recents ?? []) as readonly RecentProject[];
  // o CSS recolhe rail e inspector sem uma segunda lógica em JS
  document.body.dataset["projectState"] = status.state;
  // notifica o model: ele reexecuta rail/vista/rodapé, então a tela inicial
  // aparece e some sozinha, sem show/hide manual
  model.applyProjectState(narrowProjectState(status.state));
}

/** Verdade do runtime na status bar: sincronizado, pendente ou com falha. */
function applyRuntimeState(state: ProjectStatusPayload["runtimeState"]): void {
  lastRuntimeState = state;
  const el = $("status-runtime");
  if (!state) {
    el.textContent = "";
    delete el.dataset["state"];
    return;
  }
  el.textContent = runtimeStateLabel(state);
  el.dataset["state"] = state;
}

// ------------------------------------------------------- superfície de erro

function showError(error: unknown): void {
  const presented = presentError(error);
  const banner = $("error-banner");
  banner.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = presented.title;
  const body = document.createElement("div");
  body.className = "reason";
  body.textContent = `${presented.cause} ${presented.action}`;
  banner.append(title, body);
  if (presented.detail) {
    const detail = document.createElement("code");
    detail.textContent = presented.detail;
    banner.append(detail);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Dispensar";
  close.addEventListener("click", dismissError);
  banner.append(close);
  banner.hidden = false;
}

function dismissError(): void {
  const banner = $("error-banner");
  banner.hidden = true;
  banner.replaceChildren();
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
    const view = describeWelcome({
      projectState: model.currentProjectState,
      recents: lastRecents,
      templates: lastTemplates,
      connected,
      now: () => Date.now(),
    });
    if (view.visible) {
      mountWelcome({
        host,
        setCleanup: (cleanup) => {
          cleanupActiveView = cleanup;
        },
        view,
        onNew: (templateId) => {
          void window.p7m
            .projectCommand("new", templateId ? { templateId } : undefined)
            .then((status) => {
              dismissError();
              applyProjectStatus(status);
            })
            .catch((error: unknown) => showError(error));
        },
        onOpen: () => {
          void window.p7m
            .projectCommand("open")
            .then((status) => {
              dismissError();
              applyProjectStatus(status);
            })
            .catch((error: unknown) => showError(error));
        },
        onOpenPath: (filePath) => {
          void window.p7m
            .projectCommand("openPath", { filePath })
            .then((status) => {
              dismissError();
              applyProjectStatus(status);
            })
            .catch((error: unknown) => showError(error));
        },
        onOpenExample: () => {
          /* ligado quando o exemplo versionado existir */
        },
      });
      return;
    }
    // com projeto aberto e nenhum painel habilitado, a governança é a razão
    host.append(
      placeholder(
        "Nenhum painel disponível",
        "A governança de runtime desabilitou todos os painéis; veja a razão no rail.",
      ),
    );
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
      content.append(placeholder("Nenhum problema", problemsEmptyHint()));
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
  window.p7m.onBlueprintEvent((event, projection) => {
    // A projeção é o que faz o painel Problemas dizer a verdade: sem ela o
    // contador era estruturalmente zero.
    log.record(event as { kind: string } & Record<string, unknown>, narrowProjection(projection));
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
    connected = true;
    $("connection-dot").className = "dot online";
    $("status-connection").textContent = "Conectado ao middleware";
    // templates antes do status: o primeiro render da tela inicial já sai com
    // os cards, em vez de aparecer vazio e piscar quando chegarem
    try {
      lastTemplates = (await window.p7m.projectTemplates()).templates;
    } catch {
      // sem templates a tela inicial ainda oferece Novo e Abrir
    }
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
