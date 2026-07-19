import type { CommandRegistry } from "../core/commandRegistry.js";
import type { ContributionContext } from "../core/contributionContext.js";
import type { HistoryStatusPayload } from "../core/editorCommands.js";
import type { EventLog, LogEntry } from "../core/eventLog.js";
import type { PanelInstance } from "../core/panelRegistry.js";
import type { ProjectStatusPayload } from "../core/projectApi.js";
import { HISTORY_ACTOR_LABELS } from "../core/vocabulary.js";
import type { WorkbenchMetrics } from "../core/workbenchMetrics.js";

interface BottomPanelOptions {
  readonly host: HTMLElement;
  readonly filter: HTMLInputElement;
}

export interface EventBottomPanelOptions extends BottomPanelOptions {
  readonly log: EventLog;
  readonly context: () => ContributionContext;
  readonly commands: CommandRegistry;
  readonly projectStatus: () => ProjectStatusPayload | undefined;
  readonly onError?: (error: unknown) => void;
}

export function mountProblemsPanel(options: EventBottomPanelOptions): PanelInstance {
  return filteredPanel(options, () => {
    const filter = options.filter.value;
    const problems = options.log
      .list({ ...(filter ? { text: filter } : {}) })
      .filter((entry) => entry.projectionStatus === "skipped" || entry.projectionStatus === "deferred");
    if (problems.length === 0) return [emptyState("Nenhum problema", "Não há projeções ignoradas ou pendentes.")];
    return problems.map((entry) => problemCard(entry, options));
  });
}

export function mountOutputPanel(options: EventBottomPanelOptions): PanelInstance {
  return filteredPanel(options, () => {
    const filter = options.filter.value;
    const entries = options.log.list({ ...(filter ? { text: filter } : {}) });
    if (entries.length === 0) return [emptyState("Saída vazia", "Eventos do editor aparecerão aqui.")];
    return entries.map((entry) => {
      const row = document.createElement("div");
      row.className = "log-row";
      const time = document.createElement("time");
      time.dateTime = new Date(entry.timestampMs).toISOString();
      time.textContent = new Date(entry.timestampMs).toLocaleTimeString();
      const label = document.createElement("span");
      label.textContent = entry.summary;
      row.append(time, label);
      if (entry.projectionLabel) {
        const status = document.createElement("span");
        status.className = `status-${entry.projectionStatus}`;
        status.textContent = `${statusSymbol(entry.projectionStatus)} ${entry.projectionLabel}`;
        row.append(status);
      }
      return row;
    });
  });
}

export interface HistoryPanelOptions extends BottomPanelOptions {
  readonly history: () => HistoryStatusPayload | undefined;
}

export function mountHistoryPanel(options: HistoryPanelOptions): PanelInstance {
  return filteredPanel(options, () => {
    const filter = options.filter.value.trim().toLocaleLowerCase("pt-BR");
    const entries = (options.history()?.entries ?? []).filter((entry) =>
      !filter || `${entry.label} ${entry.actor}`.toLocaleLowerCase("pt-BR").includes(filter));
    if (entries.length === 0) return [emptyState("Histórico vazio", "Nenhuma edição confirmada.")];
    return entries.map((entry) => {
      const row = document.createElement("div");
      row.className = "log-row history-row";
      const state = document.createElement("span");
      state.textContent = entry.applied === false ? "↷ Desfeito" : "✓ Aplicado";
      const label = document.createElement("strong");
      label.textContent = entry.label;
      const actor = document.createElement("span");
      actor.textContent = HISTORY_ACTOR_LABELS[entry.actor];
      row.append(state, label, actor);
      if (entry.barrier) {
        const barrier = document.createElement("span");
        barrier.className = "history-barrier";
        barrier.textContent = "Barreira";
        row.append(barrier);
      }
      return row;
    });
  });
}

export interface PerformancePanelOptions extends BottomPanelOptions {
  readonly metrics: WorkbenchMetrics;
}

export function mountPerformancePanel(options: PerformancePanelOptions): PanelInstance {
  const render = (): void => {
    const snapshot = options.metrics.snapshot;
    const list = document.createElement("dl");
    list.className = "performance-grid";
    appendMetric(list, "Sessão da UI iniciada", new Date(snapshot.startedAt).toLocaleTimeString());
    appendMetric(list, "Eventos Blueprint", String(snapshot.blueprintEvents));
    appendMetric(list, "Ressincronizações", String(snapshot.projectionResyncs));
    appendMetric(list, "Comandos executados", String(snapshot.commandsExecuted));
    appendMetric(list, "Ativações de painel", String(snapshot.panelActivations));
    options.host.replaceChildren(list);
  };
  const release = options.metrics.subscribe(render);
  render();
  return { activate: render, dispose: release };
}

function filteredPanel(
  options: BottomPanelOptions,
  content: () => readonly HTMLElement[],
): PanelInstance {
  const render = (): void => {
    const activeElement = options.host.ownerDocument.activeElement;
    const focusedCard = activeElement instanceof HTMLElement && options.host.contains(activeElement)
      ? activeElement.closest<HTMLElement>("[data-bottom-focus-key]")
      : undefined;
    const focusKey = focusedCard?.dataset["bottomFocusKey"];
    const fallbackCardKey = activeElement instanceof HTMLElement && options.host.contains(activeElement)
      ? activeElement.closest<HTMLElement>("[data-bottom-card-key]")?.dataset["bottomCardKey"]
      : undefined;
    options.host.replaceChildren(...content());
    if (focusKey || fallbackCardKey) {
      const replacement = [...options.host.querySelectorAll<HTMLElement>("[data-bottom-focus-key]")]
        .find((candidate) => candidate.dataset["bottomFocusKey"] === focusKey);
      const fallbackCard = [...options.host.querySelectorAll<HTMLElement>("[data-bottom-card-key]")]
        .find((candidate) => candidate.dataset["bottomCardKey"] === fallbackCardKey);
      (replacement ?? fallbackCard ?? options.host).focus();
    }
  };
  options.filter.addEventListener("input", render);
  render();
  return {
    activate: render,
    focus: () => options.host.focus(),
    dispose: () => options.filter.removeEventListener("input", render),
  };
}

function problemCard(entry: LogEntry, options: EventBottomPanelOptions): HTMLElement {
  const card = document.createElement("article");
  card.className = "problem-card";
  card.tabIndex = 0;
  const cardKey = JSON.stringify([
    entry.projectSessionId ?? null,
    entry.timestampMs,
    entry.kind,
    entry.subject ?? null,
  ]);
  card.dataset["bottomFocusKey"] = cardKey;
  card.dataset["bottomCardKey"] = cardKey;
  const title = document.createElement("strong");
  title.textContent = `⚠ ${entry.summary}`;
  const reason = document.createElement("div");
  reason.className = "reason";
  reason.textContent = `${entry.projectionLabel}${entry.projectionReason ? ` — ${entry.projectionReason}` : ""}`;
  card.append(title, reason);

  if (entry.projectSessionId && entry.projectId) {
    const selectProblem = (): void => {
      options.context().selection.select({
        kind: "problem",
        projectSessionId: entry.projectSessionId!,
        projectId: entry.projectId!,
        problemId: `${entry.timestampMs}:${entry.kind}:${entry.subject ?? "project"}`,
        severity: entry.projectionStatus === "skipped" ? "warning" : "info",
        ...(entry.subject ? { subjectId: entry.subject } : {}),
      }, "problems-panel");
    };
    card.addEventListener("click", selectProblem);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectProblem();
      }
    });
  }

  const actions = options.commands.list("corrective-action", options.context(), {
    includeDisabled: true,
  }).filter(({ placement }) => placement.surface === "corrective-action" &&
    (!placement.problemKind || placement.problemKind === entry.kind));
  if (actions.length > 0) {
    const actionHost = document.createElement("div");
    actionHost.className = "problem-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["bottomFocusKey"] = JSON.stringify([cardKey, action.contribution.id]);
      button.textContent = action.contribution.label;
      button.setAttribute("aria-disabled", String(!action.enabled));
      if (action.reason) button.title = action.reason;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!action.enabled) return;
        void options.commands.execute(action.contribution.id, options.context(), { entry })
          .catch(options.onError);
      });
      actionHost.append(button);
    }
    card.append(actionHost);
  }
  return card;
}

function emptyState(titleText: string, message: string): HTMLElement {
  const view = document.createElement("div");
  view.className = "panel-empty-state";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const paragraph = document.createElement("p");
  paragraph.className = "muted";
  paragraph.textContent = message;
  view.append(title, paragraph);
  return view;
}

function statusSymbol(status: string | undefined): string {
  if (status === "projected") return "✓";
  if (status === "skipped") return "⚠";
  return "◷";
}

function appendMetric(list: HTMLDListElement, label: string, value: string): void {
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  list.append(term, description);
}
