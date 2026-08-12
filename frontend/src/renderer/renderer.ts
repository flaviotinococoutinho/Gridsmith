/**
 * Renderer do workbench — a CASCA da aplicação.
 *
 * Desde a E10 a casca não conhece os próprios painéis: ela materializa o que
 * os REGISTROS lhe entregam (painéis, comandos, ferramentas, seções de
 * inspector). Acrescentar um painel deixou de exigir um `if` aqui, e o
 * teclado deixou de ser instalado por cada vista — o que dava ao Ctrl+Z dois
 * donos e fazia vencer quem tivesse montado por último.
 *
 * Nenhum ID interno aparece: tudo passa pelo vocabulário.
 */

import { EventLog } from "../core/eventLog.js";
import { WorkbenchModel, type BottomTab } from "../core/workbench/workbenchShell.js";
import { CommandDisabledError } from "../core/workbench/commandRegistry.js";
import {
  LEVEL_EDITOR_PANEL,
  defaultInspectorSections,
  levelEditorTools,
} from "../core/workbench/editorContributions.js";
import { LAYOUT_AREAS, type LayoutArea } from "../core/workbench/workbenchLayout.js";
import type { KeyStroke } from "../core/workbench/keybindings.js";
import {
  historyActorLabel,
  panelLabel,
  projectStateLabel,
  runtimeStateLabel,
  serviceStateLabel,
} from "../core/vocabulary.js";
import { presentError } from "../core/errorCatalog.js";
import type { ResolvedExperienceLike } from "../core/experienceGate.js";
import type { P7mEditorApi, ProjectStatusPayload, ServiceStatusPayload } from "../main/preload.js";
import type { HistoryStatus } from "../main/EditorClient.js";
import { mountLevelEditor, type InspectorDataProvider } from "./levelEditorView.js";
import { mountWelcome } from "./welcomeView.js";
import { describeWelcome } from "../core/welcomeModel.js";
import type { ProjectState, RecentProject } from "../core/projectLifecycle.js";

declare global {
  interface Window {
    p7m: P7mEditorApi;
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const model = new WorkbenchModel();
const log = new EventLog(500);

/** Cópia substituível das projeções; resync nunca é tratado como evento incremental. */
let projectionSnapshot: unknown;
/** Última verdade do runtime conhecida; o painel Problemas não mente sobre ela. */
let lastRuntimeState: ProjectStatusPayload["runtimeState"];
/** Recentes e templates alimentam a tela inicial; chegam pelo status/IPC. */
let lastRecents: readonly RecentProject[] = [];
let lastTemplates: Array<{ id: string; label: string; description: string }> = [];
let connected = false;
/**
 * Estado do histórico canônico (E9). O `historyCursor` é o compare-and-swap:
 * mandá-lo de volta faz o middleware RECUSAR o desfazer se outra borda — um
 * agente via MCP, por exemplo — editou entre a leitura e o clique.
 */
let history: HistoryStatus | undefined;
/** Quem sabe descrever a seleção corrente; publicado pela vista montada. */
let inspectorData: InspectorDataProvider | undefined;

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

// ------------------------------------------------------- contribuições

/**
 * Comandos que falam com o DOCUMENTO. Vivem aqui, e não no núcleo, porque
 * atravessam a borda (`window.p7m`); os que só reorganizam a janela são puros
 * e ficam no `WorkbenchModel`.
 */
function registerDocumentCommands(): void {
  model.commands.register({
    id: "document.undo",
    label: "Desfazer no documento",
    category: "Editar",
    requires: [],
    requiresProject: true,
    order: 0,
    // sem atalho DE PROPÓSITO: o Ctrl+Z ainda pertence ao rascunho da vista de
    // níveis (a pintura não é canônica até a F6), e reivindicá-lo aqui faria o
    // usuário perder o desfazer da pincelada. O registro impede o empate.
    run: () => runHistory("undo"),
  });
  model.commands.register({
    id: "document.redo",
    label: "Refazer no documento",
    category: "Editar",
    requires: [],
    requiresProject: true,
    order: 1,
    run: () => runHistory("redo"),
  });
}

async function runHistory(action: "undo" | "redo"): Promise<void> {
  const cursor = history?.historyCursor;
  try {
    await (action === "undo" ? window.p7m.undo(cursor) : window.p7m.redo(cursor));
    dismissError();
  } catch (error: unknown) {
    // conflito de CAS é o caso ESPERADO quando outra borda editou: releia e
    // mostre a causa, em vez de repetir cegamente sobre um documento que mudou
    showError(error);
  } finally {
    await refreshHistory();
  }
}

async function refreshHistory(): Promise<void> {
  if (!connected || model.currentProjectState === "no-project") {
    history = undefined;
    renderBottom();
    return;
  }
  try {
    history = (await window.p7m.historyStatus(50)) as HistoryStatus;
  } catch {
    // histórico indisponível não pode derrubar a casca; a aba mostra o vazio
    history = undefined;
  }
  renderBottom();
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
  void refreshHistory();
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

/** Limpeza da vista corrente (contribuições, listeners) ao trocar de painel. */
let cleanupActiveView: (() => void) | undefined;
/** Painel MONTADO agora; `null` significa "nada montado ainda". */
let mountedPanel: string | undefined | null = null;
/** Teclas da vista corrente, consultadas depois de comandos e ferramentas. */
let viewKeyHandler: ((stroke: KeyStroke) => boolean) | undefined;

function renderView(): void {
  const panel = model.currentPanel;
  // Remontar a vista a cada notificação destruiria o canvas a cada clique de
  // ferramenta. Só a TROCA de painel remonta; o resto a vista trata sozinha,
  // assinando o workbench.
  if (mountedPanel === panel && panel !== undefined) return;

  const host = $("view-host");
  const cleanup = cleanupActiveView;
  cleanupActiveView = undefined;
  viewKeyHandler = undefined;
  inspectorData = undefined;
  cleanup?.();
  host.replaceChildren();
  mountedPanel = panel;
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
  if (panel === LEVEL_EDITOR_PANEL) {
    mountLevelEditor({
      host,
      workbench: model,
      setCleanup: (cleanup) => {
        cleanupActiveView = cleanup;
      },
      setInspectorData: (provider) => {
        inspectorData = provider;
      },
      setKeyHandler: (handler) => {
        viewKeyHandler = handler;
      },
    });
    return;
  }
  // painel contribuído sem vista montável: o resumo da contribuição explica o
  // que ele será, em vez de uma tela morta sem texto nenhum
  const contribution = model.panels.get(panel);
  host.append(
    placeholder(
      panelLabel(panel),
      contribution?.summary
        ? `${contribution.summary} Chega nas próximas iterações da milestone Alpha 0.1.`
        : "Este painel chega nas próximas iterações da milestone Alpha 0.1.",
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

// -------------------------------------------------------------- inspector

function renderInspector(): void {
  const host = $("inspector-content");
  host.replaceChildren();
  const selection = model.selection.current;
  if (!selection) {
    host.append(muted("Nada selecionado."));
    return;
  }
  const sections = model.inspectorSections();
  if (sections.length === 0) {
    host.append(muted("Nenhuma seção do inspector se aplica a esta seleção."));
    return;
  }
  for (const resolved of sections) {
    const block = document.createElement("section");
    block.className = "inspector-section";
    if (!resolved.enabled) block.dataset["readonly"] = "true";

    const heading = document.createElement("h3");
    heading.textContent = resolved.section.label;
    block.append(heading);

    if (resolved.reason) {
      // somente-leitura COM a razão: esconder a seção faria o usuário concluir
      // que o objeto não tem a propriedade
      const reason = document.createElement("p");
      reason.className = "reason";
      reason.textContent = resolved.reason;
      block.append(reason);
    }

    const fields = inspectorData?.fields(resolved.section.id, selection) ?? [];
    if (fields.length === 0) {
      block.append(muted("Sem dados para esta seleção."));
    } else {
      const list = document.createElement("dl");
      for (const field of fields) {
        const term = document.createElement("dt");
        term.textContent = field.label;
        const value = document.createElement("dd");
        value.textContent = field.value;
        list.append(term, value);
      }
      block.append(list);
    }
    host.append(block);
  }
}

function muted(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  return p;
}

// ---------------------------------------------------------- painel inferior

function wireBottomPanel(): void {
  for (const tabButton of document.querySelectorAll<HTMLButtonElement>("#bottom-tabs [role=tab]")) {
    tabButton.addEventListener("click", () =>
      model.selectBottomTab(tabButton.dataset["tab"] as BottomTab),
    );
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
    renderHistory(content);
    return;
  }

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

/**
 * Histórico CANÔNICO (E9): o mesmo que o agente via MCP compartilha. Mostra
 * quem fez cada edição — é o que permite ao usuário perceber que a última
 * mudança veio de um agente, e não dele.
 */
function renderHistory(content: HTMLElement): void {
  const actions = document.createElement("div");
  actions.className = "history-actions";
  actions.append(
    commandButton("document.undo", history?.undoLabel ?? undefined),
    commandButton("document.redo", history?.redoLabel ?? undefined),
  );
  content.append(actions);

  if (!history || history.entries.length === 0) {
    content.append(
      muted(
        model.currentProjectState === "no-project"
          ? "Abra um projeto para ver o histórico do documento."
          : "Nenhuma edição no documento ainda.",
      ),
    );
    return;
  }

  // mais recente primeiro: é onde o desfazer age
  for (const entry of [...history.entries].reverse()) {
    const row = document.createElement("div");
    row.className = "log-row history-row";
    if (entry.undone) row.dataset["undone"] = "true";
    const actor = document.createElement("span");
    actor.className = "history-actor";
    actor.textContent = historyActorLabel(entry.actor);
    const label = document.createElement("span");
    label.textContent = entry.label;
    row.append(actor, label);
    if (entry.barrier) {
      const barrier = document.createElement("span");
      barrier.className = "history-barrier";
      barrier.textContent = "barreira";
      barrier.title = "O desfazer para aqui: esta edição não tem inverso.";
      row.append(barrier);
    }
    content.append(row);
  }
}

/** Botão ligado a um comando: rótulo, atalho no tooltip e razão quando desabilitado. */
function commandButton(commandId: string, labelOverride?: string): HTMLButtonElement {
  const button = document.createElement("button");
  const resolved = model.resolveCommand(commandId);
  const base = resolved?.command.label ?? commandId;
  button.textContent = labelOverride ? `${base}: ${labelOverride}` : base;
  button.disabled = !resolved?.enabled;
  const tooltip = resolved?.enabled ? resolved.shortcut : resolved?.reason;
  if (tooltip) button.title = tooltip;
  button.addEventListener("click", () => void execute(commandId));
  return button;
}

async function execute(commandId: string): Promise<void> {
  try {
    await model.executeCommand(commandId);
  } catch (error: unknown) {
    // comando desabilitado tem razão da governança: mostrá-la é o ponto
    showError(error instanceof CommandDisabledError ? new Error(error.reason) : error);
  }
}

function refreshProblemBadge(): void {
  const badge = $("problem-count");
  badge.textContent = String(log.problemCount);
  badge.dataset["zero"] = String(log.problemCount === 0);
}

// ------------------------------------------------------------------ layout

const LAYOUT_STORAGE_KEY = "p7m.workbench.layout";

function restoreLayout(): void {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw) model.layout.restore(JSON.parse(raw));
  } catch {
    // preferência ilegível não pode impedir o editor de abrir: fica o default
  }
}

function persistLayout(): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(model.layout.serialize()));
  } catch {
    // armazenamento indisponível (modo privado): o layout vale só nesta sessão
  }
}

const AREA_ELEMENTS: Readonly<Record<LayoutArea, string>> = {
  rail: "panel-rail",
  inspector: "inspector",
  bottom: "bottom-panel",
};

function applyLayout(): void {
  for (const area of LAYOUT_AREAS) {
    const element = $(AREA_ELEMENTS[area]);
    const layout = model.layout.get(area);
    element.hidden = !layout.visible;
    if (area === "bottom") element.style.height = `${layout.size}px`;
    else element.style.width = `${layout.size}px`;
    const resizer = document.getElementById(`resize-${area}`);
    if (resizer) resizer.hidden = !layout.visible;
  }
}

/**
 * Arrasto das alças. O `pointerId` é capturado para que soltar o botão fora da
 * janela ainda encerre o arrasto — sem isso a alça ficava "colada" no cursor.
 */
function wireResizers(): void {
  const drag = (area: LayoutArea, resizerId: string, axis: "x" | "y", invert: boolean): void => {
    const resizer = document.getElementById(resizerId);
    if (!resizer) return;
    resizer.addEventListener("pointerdown", (event) => {
      const start = axis === "x" ? event.clientX : event.clientY;
      const initial = model.layout.get(area).size;
      resizer.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent): void => {
        const delta = (axis === "x" ? moveEvent.clientX : moveEvent.clientY) - start;
        model.layout.resize(area, initial + (invert ? -delta : delta));
      };
      const up = (): void => {
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", up);
        persistLayout();
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up);
      event.preventDefault();
    });
  };
  drag("rail", "resize-rail", "x", false);
  // inspector e painel inferior crescem para o lado oposto ao do arrasto
  drag("inspector", "resize-inspector", "x", true);
  drag("bottom", "resize-bottom", "y", true);
}

// ------------------------------------------------------------------ teclado

/**
 * ÚNICO ouvinte de teclado do aplicativo. Cada vista instalar o seu era o que
 * permitia dois donos do mesmo acorde; agora o registro resolve, e um conflito
 * de atalho falha no `register`, não em produção.
 */
function wireKeyboard(): void {
  window.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    const outcome = model.resolveKeyStroke(event);
    if (outcome.kind === "command") {
      event.preventDefault();
      void execute(outcome.commandId);
      return;
    }
    if (outcome.kind === "tool") {
      event.preventDefault();
      model.activateTool(outcome.toolId);
      return;
    }
    // por último a vista: assim ela nunca rouba um atalho global
    if (viewKeyHandler?.(event) === true) event.preventDefault();
  });
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

function renderAll(): void {
  renderRail();
  renderView();
  renderInspector();
  renderBottom();
  applyLayout();
}

async function boot(): Promise<void> {
  model.registerViewCommands();
  registerDocumentCommands();
  model.tools.registerAll(levelEditorTools());
  model.inspector.registerAll(defaultInspectorSections());
  restoreLayout();

  wireProjectToolbar();
  wireBottomPanel();
  wireResizers();
  wireKeyboard();

  // uma única assinatura redesenha tudo: rail, vista, inspector e rodapé são
  // projeções do MESMO estado, e mantê-los em sincronia à mão foi a origem de
  // telas que discordavam entre si
  model.onChange(renderAll);
  renderAll();

  window.p7m.onProjectStatus(applyProjectStatus);
  window.p7m.onMenuAction((action) => {
    // o menu nativo resolve pelo MESMO registro do teclado: quem responde ao
    // Ctrl+Z responde ao item de menu, por construção
    const stroke = { key: "z", ctrlKey: true, shiftKey: action === "redo" };
    const outcome = model.resolveKeyStroke(stroke);
    if (outcome.kind === "command") void execute(outcome.commandId);
  });
  window.p7m.onServiceStatus(renderServices);
  window.p7m.onBlueprintEvent((event, projection) => {
    // A projeção é o que faz o painel Problemas dizer a verdade: sem ela o
    // contador era estruturalmente zero.
    log.record(event as { kind: string } & Record<string, unknown>, narrowProjection(projection));
    refreshProblemBadge();
    renderBottom();
    // o documento mudou: o cursor do CAS precisa acompanhar, ou o próximo
    // desfazer seria recusado por estar lendo um estado velho
    void refreshHistory();
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
