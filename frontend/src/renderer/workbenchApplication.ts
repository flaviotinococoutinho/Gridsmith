/**
 * Runtime de composição do workbench. Mantém lifecycle/transport nas portas do
 * preload e oferece estado explícito às contribuições internas.
 */

import {
  PROJECT_STABLE_CAPABILITY,
  type CapabilityDecision,
} from "../core/capabilityRegistry.js";
import { CommandRegistry, normalizeShortcut } from "../core/commandRegistry.js";
import type { ContributionContext } from "../core/contributionContext.js";
import { EditorModeService, type EditorMode } from "../core/editorModeService.js";
import type {
  BlueprintEventPayload,
  DispatchOutcome,
  HistoryStatusPayload,
} from "../core/editorCommands.js";
import { EventLog } from "../core/eventLog.js";
import type { EditorApplicationEvent } from "../core/assetApi.js";
import { ExternalOpenIntentQueue } from "../core/externalOpenIntentQueue.js";
import { ExperienceGate, type ResolvedExperienceLike } from "../core/experienceGate.js";
import { InspectorRegistry } from "../core/inspectorRegistry.js";
import type { LevelEditorProjectionDocument } from "../core/levelEditorProjection.js";
import {
  LevelEditorStore,
  reconcileSelectionsWithLevelProjection,
} from "../core/levelEditorStore.js";
import { PanelRegistry } from "../core/panelRegistry.js";
import { PendingEditCoordinator } from "../core/pendingEditCoordinator.js";
import { projectNativeMenuCommands } from "../core/nativeMenuProjection.js";
import {
  PROJECT_COMMAND_IDS,
  type ProjectActionResult,
  type ProjectCommandInvocation,
  type ProjectStatusPayload,
} from "../core/projectApi.js";
import { SelectionService, type Selection } from "../core/selectionService.js";
import { ToolRegistry } from "../core/toolRegistry.js";
import { projectStateLabel, serviceStateLabel } from "../core/vocabulary.js";
import { WorkbenchMetrics } from "../core/workbenchMetrics.js";
import type { ResizableWorkbenchRegion } from "../core/workbenchLayout.js";
import type { P7mEditorApi, ServiceStatusPayload } from "../main/preload.js";
import {
  CommandPaletteView,
  CommandSurfaceView,
  ContextCommandMenuView,
  keyboardEventChord,
} from "./commandViews.js";
import { showNewProjectWizard } from "./newProjectWizard.js";
import { PanelHostController } from "./panelHost.js";
import {
  createBrowserWorkbenchLayout,
  mountWorkbenchShell,
  resolveWorkbenchShellElements,
  type WorkbenchShellInstance,
} from "./workbenchShell.js";

export interface WorkbenchApplicationEnvironment {
  readonly api: P7mEditorApi;
  readonly document: Document;
  readonly hostWindow: Window;
}

interface RegionHosts {
  readonly left: PanelHostController;
  readonly center: PanelHostController;
  readonly right: PanelHostController;
  readonly bottom: PanelHostController;
}

export class EditorWorkbenchApplication {
  readonly panels = new PanelRegistry<HTMLElement>();
  readonly commands = new CommandRegistry();
  readonly tools = new ToolRegistry();
  readonly inspector = new InspectorRegistry();
  readonly selection = new SelectionService();
  readonly mode = new EditorModeService();
  readonly levelStore = new LevelEditorStore();
  readonly eventLog = new EventLog(500);
  readonly metrics = new WorkbenchMetrics();
  readonly pendingEdits = new PendingEditCoordinator();

  private readonly services = new Map<string, unknown>();
  private experienceGate: ExperienceGate | undefined;
  private currentProjectStatus: ProjectStatusPayload | undefined;
  private currentHistory: HistoryStatusPayload | undefined;
  private preferredLevelId: string | undefined;
  private readonly pendingProjectionEvents = new Map<string, BlueprintEventPayload>();
  private historyRefreshInFlight: Promise<void> | undefined;
  private historyRefreshQueued = false;
  private historyOperationBusy = false;
  private projectOperationBusy = false;
  private readonly projectIdleWaiters = new Set<() => void>();
  private readonly externalOpenIntents: ExternalOpenIntentQueue;
  private shell: WorkbenchShellInstance | undefined;
  private regions: RegionHosts | undefined;
  private projectToolbar: CommandSurfaceView | undefined;
  private contextToolbar: CommandSurfaceView | undefined;
  private readonly commandPalette: CommandPaletteView;
  private readonly contextMenu: ContextCommandMenuView;
  private nativeMenuRequestedSignature: string | undefined;
  private nativeMenuUpdateChain: Promise<void> = Promise.resolve();
  private booted = false;

  constructor(readonly environment: WorkbenchApplicationEnvironment) {
    this.externalOpenIntents = new ExternalOpenIntentQueue(async (filePath) => {
      await this.waitForProjectIdle();
      const outcome = await this.runExternalOpenAction(filePath);
      return outcome === "blocked-by-draft" ? "blocked" : "consumed";
    });
    this.commandPalette = new CommandPaletteView({
      registry: this.commands,
      context: () => this.contributionContext(),
      onError: (error) => this.showError(error),
    });
    this.contextMenu = new ContextCommandMenuView({
      registry: this.commands,
      context: () => this.contributionContext(),
      onError: (error) => this.showError(error),
    });
    this.commands.onDidExecute(() => this.metrics.record("command"));
    this.commands.onDidChange(() => this.renderCommandSurfaces());
    this.selection.subscribe(({ current }) => {
      this.synchronizeSelectedLevel(current);
      this.tools.refresh(this.contributionContext());
      this.refreshAllRegions();
      this.renderCommandSurfaces();
    });
    this.mode.subscribe(() => {
      this.tools.refresh(this.contributionContext());
      this.refreshAllRegions();
      this.renderCommandSurfaces();
    });
  }

  get api(): P7mEditorApi {
    return this.environment.api;
  }

  get projectStatus(): ProjectStatusPayload | undefined {
    return this.currentProjectStatus;
  }

  get historyStatus(): HistoryStatusPayload | undefined {
    return this.currentHistory;
  }

  get activeProject(): ProjectStatusPayload["project"] | undefined {
    return this.currentProjectStatus?.project;
  }

  get activeLevelId(): string | undefined {
    return this.levelStore.snapshot.level?.levelId ?? this.preferredLevelId;
  }

  contributionContext(): ContributionContext {
    return {
      selection: this.selection,
      capabilities: (capability) => this.resolveCapability(capability),
      mode: this.mode.current,
      services: this.services,
    };
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    this.mountStructure();
    this.renderProjectStatus();
    this.renderProblemBadge();

    try {
      this.renderServices(await this.api.serviceStatus());
      await this.api.connect();
      this.setConnection(true, "Conectado ao middleware");
      this.applyProjectStatus(await this.api.projectStatus());
      await this.refreshHistory();
      try {
        const experience = await this.api.experience() as ResolvedExperienceLike;
        this.experienceGate = new ExperienceGate(experience);
        this.element("runtime-label").textContent = this.experienceGate.runtimeLabel;
      } catch (error) {
        this.element("runtime-label").textContent = "Runtime desconectado; edição canônica disponível";
        this.showError(error);
      }
      this.refreshAllRegions();
      this.renderCommandSurfaces();
    } catch (error) {
      this.setConnection(false, `Sem conexão com o middleware. ${errorMessage(error)}`);
      this.renderReconnectAction();
    }
  }

  handleProjectStatus(status: ProjectStatusPayload): void {
    this.applyProjectStatus(status);
  }

  handleBlueprintEvent(event: BlueprintEventPayload): void {
    const project = this.activeProject;
    if (!project?.projectSessionId || !project.projectId ||
        event.projectSessionId !== project.projectSessionId || event.projectId !== project.projectId) {
      return;
    }
    if (this.levelStore.cursor?.projectSessionId !== event.projectSessionId) {
      this.pendingProjectionEvents.set(event.commandSequence, event);
      return;
    }
    this.applyReadyBlueprintEvent(event);
  }

  recordDispatchOutcome(outcome: DispatchOutcome): void {
    const active = this.activeProject;
    if (!active?.projectSessionId || !active.projectId ||
        outcome.event.projectSessionId !== active.projectSessionId ||
        outcome.event.projectId !== active.projectId) return;
    const status = outcome.projection?.status;
    let projection: { status: "projected" | "skipped" | "deferred"; reason?: string } | undefined;
    if (status === "projected" || status === "skipped" || status === "deferred") {
      projection = { status, ...(outcome.projection?.reason ? { reason: outcome.projection.reason } : {}) };
    }
    this.eventLog.record(
      outcome.event as BlueprintEventPayload & { kind: string } & Record<string, unknown>,
      projection,
    );
    this.renderProblemBadge();
    this.regions?.bottom.activateCurrent();
  }

  /** Registra falhas operacionais acionáveis sem misturá-las ao EventJournal. */
  recordDiagnosticProblem(
    event: { kind: string } & Record<string, unknown>,
    reason: string,
  ): void {
    this.eventLog.record(event, { status: "skipped", reason });
    this.renderProblemBadge();
    this.regions?.bottom.activateCurrent();
  }

  recordApplicationEvent(event: EditorApplicationEvent): void {
    this.eventLog.recordApplication({
      seq: event.seq,
      domain: event.domain,
      kind: event.kind,
      severity: event.severity,
      projectSessionId: event.projectSessionId,
      projectId: event.projectId,
      ...(event.operationId ? { operationId: event.operationId } : {}),
      payload: event.payload,
      ...(event.progress?.message ? { detail: event.progress.message } : {}),
    });
    this.renderProblemBadge();
    this.regions?.bottom.activateCurrent();
  }

  resolveApplicationProblem(options: {
    readonly kind: string;
    readonly projectSessionId?: string;
    readonly subject?: string;
    readonly operationId?: string;
  }): void {
    if (this.eventLog.resolveApplication(options) === 0) return;
    this.renderProblemBadge();
    this.regions?.bottom.activateCurrent();
  }

  private applyReadyBlueprintEvent(event: BlueprintEventPayload): void {
    const applied = this.levelStore.applyEvent(event);
    this.eventLog.record(event as BlueprintEventPayload & { kind: string } & Record<string, unknown>);
    this.metrics.record("blueprint-event");
    // applyEvent também pode fechar um gap e aplicar eventos bufferizados. A
    // validação contra a projeção inteira cobre remoções que não são `event`.
    if (applied) this.ensureSelectionIsValid();
    this.renderProblemBadge();
    this.regions?.bottom.activateCurrent();
    if (applied) {
      this.regions?.left.activateCurrent();
      this.regions?.right.activateCurrent();
    }
    void this.refreshHistory();
  }

  handleProjectionResync(snapshot: unknown): void {
    const cursor = projectionCursor(snapshot);
    const active = this.activeProject;
    if (!cursor || !active?.projectSessionId || !active.projectId ||
        cursor.projectSessionId !== active.projectSessionId || cursor.projectId !== active.projectId) {
      return;
    }
    const document = projectionDocument(snapshot);
    if (!document) {
      this.showError("A ressincronização não trouxe uma projeção de documento válida.");
      return;
    }
    this.metrics.record("projection-resync");
    const preferredLevelId = selectedLevelId(this.selection.current) ?? this.activeLevelId;
    this.levelStore.replace(document, preferredLevelId, cursor);
    this.preferredLevelId = this.levelStore.snapshot.level?.levelId;
    this.drainPendingProjectionEvents();
    this.ensureSelectionIsValid();
    this.regions?.left.activateCurrent();
    this.regions?.center.refresh();
    this.regions?.right.activateCurrent();
    this.regions?.bottom.activateCurrent();
  }

  handleServiceStatus(services: ServiceStatusPayload[]): void {
    this.renderServices(services);
  }

  handleMenuInvocation(invocation: ProjectCommandInvocation): void {
    if (invocation.source === "external-open" && invocation.commandId === PROJECT_COMMAND_IDS.openRecent) {
      const filePath = externalOpenPath(invocation.args);
      if (!filePath) {
        this.showError("O pedido externo não contém um caminho de projeto válido.");
        return;
      }
      this.blurActiveEditorDraft();
      void this.externalOpenIntents.enqueue(filePath);
      return;
    }
    const contribution = this.commands.get(invocation.commandId);
    const activeElement = this.environment.document.activeElement;
    if (contribution?.commitEditorDrafts && activeElement instanceof HTMLElement) activeElement.blur();
    void this.executeCommand(invocation.commandId, invocation.args).catch(() => {
      // executeCommand já publicou feedback acionável; o boundary nativo não
      // deve transformar uma recusa esperada em unhandled rejection.
    });
  }

  handleGlobalKeyDown(event: KeyboardEvent): void {
    const editingText = event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable);
    const chord = keyboardEventChord(event);
    const context = this.contributionContext();
    const command = this.commands.resolveShortcut(chord, context);
    if (!command || (editingText && isNativeTextEditingShortcut(chord))) return;
    // Browser/Electron só respeitam preventDefault durante o dispatch síncrono.
    event.preventDefault();
    if (!command.enabled) {
      if (command.reason) this.showError(command.reason);
      return;
    }
    if (editingText && command.contribution.commitEditorDrafts &&
        event.target instanceof HTMLElement) event.target.blur();
    void this.executeCommand(command.contribution.id).catch(() => undefined);
  }

  handleContextMenu(event: MouseEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
    if (!(event.target instanceof Node) || !this.element("workbench").contains(event.target)) return;
    this.contextMenu.open(event);
  }

  async prepareProjectClose(): Promise<void> {
    const activeElement = this.environment.document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
    await this.pendingEdits.flush();
  }

  openCommandPalette(): void {
    this.commandPalette.open();
  }

  setMode(mode: EditorMode): void {
    this.mode.set(mode, "command");
  }

  async startNewProject(): Promise<void> {
    if (this.projectOperationBusy) return;
    this.blurActiveEditorDraft();
    this.setProjectOperationBusy(true);
    this.clearError();
    try {
      await this.pendingEdits.flush();
      const templates = await this.api.listProjectTemplates();
      const request = await showNewProjectWizard(templates);
      if (!request) return;
      this.applyProjectActionResult(await this.api.createProjectFromTemplate(request));
    } catch (error) {
      this.showError(error);
    } finally {
      this.setProjectOperationBusy(false);
    }
  }

  async runProjectAction(action: () => Promise<ProjectActionResult>): Promise<void> {
    if (this.projectOperationBusy) return;
    this.blurActiveEditorDraft();
    this.setProjectOperationBusy(true);
    this.clearError();
    try {
      await this.pendingEdits.flush();
      this.applyProjectActionResult(await action());
    } catch (error) {
      this.showError(error);
      throw error;
    } finally {
      this.setProjectOperationBusy(false);
    }
  }

  async runHistoryAction(action: () => Promise<unknown>): Promise<void> {
    if (this.historyOperationBusy) return;
    this.historyOperationBusy = true;
    this.renderCommandSurfaces();
    try {
      await this.pendingEdits.flush();
      await action();
      await this.refreshHistory();
    } catch (error) {
      this.showError(error);
      throw error;
    } finally {
      this.historyOperationBusy = false;
      this.renderCommandSurfaces();
    }
  }

  async executeCommand(commandId: string, args?: unknown): Promise<unknown> {
    try {
      const result = await this.commands.execute(commandId, this.contributionContext(), args);
      this.renderCommandSurfaces();
      return result;
    } catch (error) {
      this.showError(error);
      throw error;
    }
  }

  async restartService(serviceId: string): Promise<boolean> {
    return this.api.serviceRestart(serviceId);
  }

  showError(error: unknown): void {
    const feedback = this.element("project-feedback");
    feedback.textContent = errorMessage(error);
    feedback.hidden = false;
    feedback.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  clearError(): void {
    const feedback = this.element("project-feedback");
    feedback.textContent = "";
    feedback.hidden = true;
  }

  isProjectCommandAvailable(kind: "save" | "close" | "open" | "new"): boolean {
    if (this.projectOperationBusy) return false;
    if (kind === "new" || kind === "open") return true;
    return this.currentProjectStatus?.state === "open-clean" ||
      this.currentProjectStatus?.state === "open-dirty";
  }

  canUndo(): boolean {
    return !this.projectOperationBusy && !this.historyOperationBusy && Boolean(
      this.currentHistory?.canUndo ?? this.currentProjectStatus?.canUndo,
    );
  }

  canRedo(): boolean {
    return !this.projectOperationBusy && !this.historyOperationBusy && Boolean(
      this.currentHistory?.canRedo ?? this.currentProjectStatus?.canRedo,
    );
  }

  assertProjectEditable(): void {
    if (this.projectOperationBusy) {
      throw new Error("Aguarde a operação de projeto terminar antes de editar.");
    }
  }

  trackPendingEdit<T>(key: string, operation: Promise<T>): Promise<T> {
    const tracked = this.pendingEdits.track(key, operation);
    void tracked.then(
      () => this.externalOpenIntents.retry(),
      () => undefined,
    );
    return tracked;
  }

  toggleWorkbenchRegion(region: ResizableWorkbenchRegion): void {
    this.shell?.layout.toggleRegion(region);
    this.renderCommandSurfaces();
  }

  restoreWorkbenchLayout(): void {
    this.shell?.layout.restoreDefaults();
    this.renderCommandSurfaces();
  }

  refreshPanels(): void {
    this.refreshAllRegions();
  }

  /** Ativa uma contribuição pelo registro, sem acoplar módulos aos hosts privados. */
  activatePanel(panelId: string, focus = true): boolean {
    const panel = this.panels.get(panelId);
    if (!panel || !this.regions) return false;
    return this.regions[panel.defaultRegion].activate(panelId, focus);
  }

  private setProjectOperationBusy(busy: boolean): void {
    if (this.projectOperationBusy === busy) return;
    this.projectOperationBusy = busy;

    // Cancelar o tool encerra/reverte o gesto antes que a operação de sessão
    // possa alcançar o ProjectController. `inert` preserva o draft visível do
    // Inspector, inclusive quando sua validação bloquear a operação.
    this.tools.refresh(this.contributionContext());
    for (const id of ["view-host", "inspector-content"]) {
      const host = this.environment.document.getElementById(id) as HTMLElement | null;
      if (!host) continue;
      host.inert = busy;
      host.setAttribute("aria-busy", String(busy));
    }
    if (!busy) this.regions?.center.activateCurrent();
    this.renderProjectStatus();
    this.renderCommandSurfaces();

    if (!busy) {
      for (const resolve of this.projectIdleWaiters) resolve();
      this.projectIdleWaiters.clear();
    }
  }

  private waitForProjectIdle(): Promise<void> {
    if (!this.projectOperationBusy) return Promise.resolve();
    return new Promise((resolve) => this.projectIdleWaiters.add(resolve));
  }

  private async runExternalOpenAction(
    filePath: string,
  ): Promise<"opened" | "blocked-by-draft" | "open-failed"> {
    if (this.projectOperationBusy) return "blocked-by-draft";
    this.blurActiveEditorDraft();
    this.setProjectOperationBusy(true);
    this.clearError();
    try {
      try {
        await this.pendingEdits.flush();
      } catch (error) {
        this.showError(error);
        return "blocked-by-draft";
      }
      try {
        this.applyProjectActionResult(await this.api.openRecent(filePath));
        return "opened";
      } catch (error) {
        this.showError(error);
        return "open-failed";
      }
    } finally {
      this.setProjectOperationBusy(false);
    }
  }

  private blurActiveEditorDraft(): void {
    const activeElement = this.environment.document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
  }

  private mountStructure(): void {
    const layout = createBrowserWorkbenchLayout(
      this.environment.hostWindow.localStorage,
      this.environment.hostWindow.innerWidth,
    );
    this.shell = mountWorkbenchShell(
      // Toolbar, compact tabs and status bar intentionally live outside the
      // workbench grid. Resolve the complete shell from the document boundary;
      // the resolver still returns #workbench as its resize/layout root.
      resolveWorkbenchShellElements(this.environment.document),
      layout,
      this.environment.hostWindow,
    );
    const context = () => this.contributionContext();
    const projectSessionKey = () => this.activeProject?.projectSessionId;
    this.regions = {
      left: new PanelHostController({
        region: "left",
        content: this.element("project-tree-host"),
        tabs: this.element("panel-rail"),
        registry: this.panels,
        context,
        instanceKey: projectSessionKey,
        onActivated: () => this.metrics.record("panel-activation"),
        onError: (_panelId, error) => this.showError(error),
      }),
      center: new PanelHostController({
        region: "center",
        content: this.element("view-host"),
        tabs: this.element("center-tabs"),
        registry: this.panels,
        context,
        instanceKey: projectSessionKey,
        onActivated: () => this.metrics.record("panel-activation"),
        onError: (_panelId, error) => this.showError(error),
      }),
      right: new PanelHostController({
        region: "right",
        content: this.element("inspector-content"),
        tabs: this.element("inspector-tabs"),
        registry: this.panels,
        context,
        instanceKey: projectSessionKey,
        onActivated: () => this.metrics.record("panel-activation"),
        onError: (_panelId, error) => this.showError(error),
      }),
      bottom: new PanelHostController({
        region: "bottom",
        content: this.element("bottom-content"),
        tabs: this.element("bottom-tabs"),
        registry: this.panels,
        context,
        instanceKey: projectSessionKey,
        onActivated: () => this.metrics.record("panel-activation"),
        onError: (_panelId, error) => this.showError(error),
      }),
    };
    this.projectToolbar = new CommandSurfaceView({
      host: this.element("project-toolbar"),
      surface: "toolbar",
      group: "project",
      registry: this.commands,
      context,
      onError: (error) => this.showError(error),
    });
    this.contextToolbar = new CommandSurfaceView({
      host: this.element("context-toolbar"),
      surface: "toolbar",
      group: "context",
      registry: this.commands,
      context,
      onError: (error) => this.showError(error),
    });
  }

  private applyProjectActionResult(result: ProjectActionResult): void {
    if (result.openedLevelId) this.preferredLevelId = result.openedLevelId;
    else if (!result.status.project) this.preferredLevelId = undefined;
    this.applyProjectStatus(result.status);
  }

  private applyProjectStatus(status: ProjectStatusPayload): void {
    const previousSession = this.currentProjectStatus?.project?.projectSessionId;
    const nextSession = status.project?.projectSessionId;
    this.currentProjectStatus = status;
    if (previousSession !== nextSession) {
      this.selection.switchSession(nextSession, "project-session-changed");
      this.mode.set("edit", "project-session-changed");
      this.currentHistory = undefined;
      this.pendingProjectionEvents.clear();
      this.pendingEdits.clear();
      this.eventLog.clear();
      this.renderProblemBadge();
      if (!nextSession) {
        this.preferredLevelId = undefined;
        this.levelStore.replace(undefined, undefined, undefined);
      } else {
        void this.refreshLevelProjection(nextSession);
      }
      void this.refreshHistory();
    }
    this.renderProjectStatus();
    this.refreshAllRegions();
    this.renderCommandSurfaces();
  }

  private renderProjectStatus(): void {
    const status = this.currentProjectStatus;
    this.element("project-title").textContent = status?.project
      ? `${status.isDirty ? "● " : ""}${status.project.name}`
      : "Nenhum projeto aberto";
    this.element("status-project").textContent = projectStateLabel(status?.state ?? "no-project");
  }

  private async refreshLevelProjection(expectedSessionId: string): Promise<void> {
    try {
      const snapshot = await this.api.captureProjectSnapshot(expectedSessionId);
      const active = this.activeProject;
      if (expectedSessionId !== active?.projectSessionId ||
          snapshot.status.projectSessionId !== expectedSessionId ||
          snapshot.status.projectId !== active.projectId) return;
      this.levelStore.replace(snapshot.document as LevelEditorProjectionDocument, this.preferredLevelId, {
        projectSessionId: expectedSessionId,
        commandSequence: snapshot.status.commandSequence,
      });
      this.preferredLevelId = this.levelStore.snapshot.level?.levelId;
      this.drainPendingProjectionEvents();
      this.ensureDefaultSelection();
      this.regions?.left.activateCurrent();
      this.regions?.center.refresh();
      this.regions?.right.activateCurrent();
    } catch (error) {
      if (expectedSessionId === this.activeProject?.projectSessionId) this.showError(error);
    }
  }

  private refreshHistory(): Promise<void> {
    this.historyRefreshQueued = true;
    if (this.historyRefreshInFlight) return this.historyRefreshInFlight;
    let task!: Promise<void>;
    task = (async () => {
      while (this.historyRefreshQueued) {
        this.historyRefreshQueued = false;
        const expectedSessionId = this.activeProject?.projectSessionId;
        const expectedProjectId = this.activeProject?.projectId;
        if (!expectedSessionId || !expectedProjectId) {
          this.currentHistory = undefined;
          this.regions?.bottom.activateCurrent();
          this.renderCommandSurfaces();
          continue;
        }
        try {
          const history = await this.api.historyStatus(100);
          if (this.activeProject?.projectSessionId !== expectedSessionId ||
              this.activeProject.projectId !== expectedProjectId ||
              history.projectSessionId !== expectedSessionId || history.projectId !== expectedProjectId) {
            continue;
          }
          this.currentHistory = history;
          this.regions?.bottom.activateCurrent();
          this.renderCommandSurfaces();
        } catch {
          // O journal/resync tentará novamente; o editor permanece utilizável.
        }
      }
    })().finally(() => {
      if (this.historyRefreshInFlight === task) this.historyRefreshInFlight = undefined;
      if (this.historyRefreshQueued) void this.refreshHistory();
    });
    this.historyRefreshInFlight = task;
    return task;
  }

  private drainPendingProjectionEvents(): void {
    const events = [...this.pendingProjectionEvents.values()].sort((left, right) =>
      compareCommandSequence(left.commandSequence, right.commandSequence));
    this.pendingProjectionEvents.clear();
    for (const event of events) this.applyReadyBlueprintEvent(event);
  }

  private ensureDefaultSelection(): void {
    if (this.selection.current) return;
    const project = this.activeProject;
    const projectId = project?.projectId ?? this.levelStore.snapshot.projectId;
    const sessionId = project?.projectSessionId;
    const level = this.levelStore.snapshot.level;
    if (!projectId || !sessionId) return;
    if (level) {
      this.selection.select({
        kind: "level",
        projectId,
        projectSessionId: sessionId,
        levelId: level.levelId,
      }, "project-open");
    } else {
      this.selection.select({ kind: "project", projectId, projectSessionId: sessionId }, "project-open");
    }
  }

  private ensureSelectionIsValid(): void {
    const selections = this.selection.selections;
    if (selections.length === 0) {
      this.ensureDefaultSelection();
      return;
    }
    const snapshot = this.levelStore.snapshot;
    const reconciled = reconcileSelectionsWithLevelProjection(selections, snapshot);
    if (reconciled.length === 0) {
      this.selection.clear("projection-invalidated-selection");
      this.ensureDefaultSelection();
      return;
    }
    this.selection.selectMany(reconciled, 0, "projection-reconciled-selection");
    this.synchronizeSelectedLevel(this.selection.current);
  }

  private synchronizeSelectedLevel(selection: Selection | undefined): void {
    const levelId = selectedLevelId(selection);
    if (!levelId) return;
    this.levelStore.select(levelId);
    if (this.levelStore.snapshot.level?.levelId === levelId) this.preferredLevelId = levelId;
  }

  private resolveCapability(capability: string): CapabilityDecision {
    if (capability === PROJECT_STABLE_CAPABILITY) {
      return this.projectOperationBusy
        ? { enabled: false, reason: "Aguarde a operação de projeto atual terminar." }
        : { enabled: true, reason: "A sessão ativa está disponível para edição." };
    }
    if (!this.experienceGate) {
      return {
        enabled: false,
        reason: "Aguardando o perfil de capacidades do runtime.",
      };
    }
    return this.experienceGate.feature(capability);
  }

  private refreshAllRegions(): void {
    this.regions?.left.refresh();
    this.regions?.center.refresh();
    this.regions?.right.refresh();
    this.regions?.bottom.refresh();
  }

  private renderCommandSurfaces(): void {
    this.projectToolbar?.render();
    this.contextToolbar?.render();
    this.syncNativeMenu();
  }

  private syncNativeMenu(): void {
    if (!this.booted || !this.shell) return;
    const context = this.contributionContext();
    const descriptors = projectNativeMenuCommands(
      this.commands.list("menu", context, { includeDisabled: true }),
      this.commands.list("shortcut", context, { includeDisabled: true }),
    );
    const signature = JSON.stringify(descriptors);
    if (signature === this.nativeMenuRequestedSignature) return;
    this.nativeMenuRequestedSignature = signature;
    this.nativeMenuUpdateChain = this.nativeMenuUpdateChain.then(async () => {
      if (signature !== this.nativeMenuRequestedSignature) return;
      try {
        const result = await this.api.updateNativeMenu(descriptors);
        if (result.acceptedCommandCount !== descriptors.length) {
          throw new Error("O menu nativo aceitou uma projeção incompleta de comandos.");
        }
      } catch (error) {
        if (this.nativeMenuRequestedSignature === signature) {
          this.nativeMenuRequestedSignature = undefined;
          this.showError(error);
        }
      }
    });
  }

  private renderProblemBadge(): void {
    const badge = this.element("problem-count");
    badge.textContent = String(this.eventLog.problemCount);
    badge.dataset["zero"] = String(this.eventLog.problemCount === 0);
  }

  private renderServices(services: ServiceStatusPayload[]): void {
    const host = this.element("status-services");
    host.replaceChildren();
    for (const service of services) {
      const chip = document.createElement("span");
      chip.className = `service-chip state-${service.state}`;
      chip.textContent = `${service.displayName}: ${serviceStateLabel(service.state)}`;
      const diagnostics = [service.detail, ...service.recentLog].filter(Boolean).join("\n");
      if (diagnostics) chip.title = diagnostics;
      host.append(chip);
      if (service.state === "failed" || service.state === "retrying") {
        const actions = this.commands.list("corrective-action", this.contributionContext(), {
          includeDisabled: true,
        }).filter(({ placement }) => placement.surface === "corrective-action" &&
          (!placement.problemKind || placement.problemKind === "service-failed"));
        for (const action of actions) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = action.contribution.label;
          button.title = action.enabled
            ? `${action.contribution.label}: ${service.displayName}`
            : action.reason ?? "Ação indisponível";
          button.setAttribute("aria-disabled", String(!action.enabled));
          button.addEventListener("click", () => {
            if (!action.enabled) return;
            void this.executeCommand(action.contribution.id, { serviceId: service.id }).catch(() => undefined);
          });
          host.append(button);
        }
      }
    }
  }

  private setConnection(connected: boolean, label: string): void {
    this.element("connection-dot").className = `dot ${connected ? "online" : "offline"}`;
    this.element("status-connection").textContent = label;
  }

  private renderReconnectAction(): void {
    if (this.environment.document.getElementById("reconnect-editor")) return;
    const button = document.createElement("button");
    button.id = "reconnect-editor";
    button.type = "button";
    button.textContent = "Tentar reconectar";
    button.addEventListener("click", () => {
      button.disabled = true;
      void this.reconnect().then(
        () => button.remove(),
        (error) => {
          button.disabled = false;
          this.showError(error);
        },
      );
    });
    this.element("status-bar").append(button);
  }

  private async reconnect(): Promise<void> {
    this.renderServices(await this.api.serviceStatus());
    await this.api.connect();
    this.setConnection(true, "Conectado ao middleware");
    this.applyProjectStatus(await this.api.projectStatus());
    await this.refreshHistory();
    if (!this.experienceGate) {
      this.experienceGate = new ExperienceGate(await this.api.experience() as ResolvedExperienceLike);
      this.element("runtime-label").textContent = this.experienceGate.runtimeLabel;
    }
    this.refreshAllRegions();
    this.renderCommandSurfaces();
  }

  private element<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = this.environment.document.getElementById(id);
    if (!element) throw new Error(`Estrutura do renderer incompleta: #${id}`);
    return element as T;
  }
}

export function routeGlobalEditorEvents(application: EditorWorkbenchApplication): void {
  const { api, hostWindow } = application.environment;
  api.onProjectStatus((status) => application.handleProjectStatus(status));
  api.onMenuAction((invocation) => application.handleMenuInvocation(invocation));
  api.onProjectClosePreflight(() => application.prepareProjectClose());
  api.onServiceStatus((services) => application.handleServiceStatus(services));
  api.onBlueprintEvent((event) => application.handleBlueprintEvent(event));
  api.onProjectionResync(({ snapshot }) => application.handleProjectionResync(snapshot));
  hostWindow.addEventListener("keydown", (event) => application.handleGlobalKeyDown(event));
  hostWindow.addEventListener("contextmenu", (event) => application.handleContextMenu(event));
}

function projectionDocument(snapshot: unknown): LevelEditorProjectionDocument | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const projections = (snapshot as { projections?: Record<string, unknown> }).projections;
  const documentProjection = projections?.["document"];
  if (!documentProjection || typeof documentProjection !== "object") return undefined;
  return (documentProjection as { document?: LevelEditorProjectionDocument }).document;
}

function projectionCursor(snapshot: unknown):
  { projectSessionId: string; projectId: string; commandSequence: string } | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const status = (snapshot as { status?: Record<string, unknown> }).status;
  return status && typeof status["projectSessionId"] === "string" &&
    typeof status["projectId"] === "string" &&
    typeof status["commandSequence"] === "string"
    ? {
        projectSessionId: status["projectSessionId"],
        projectId: status["projectId"],
        commandSequence: status["commandSequence"],
      }
    : undefined;
}

function compareCommandSequence(left: string, right: string): number {
  try {
    const leftSequence = BigInt(left);
    const rightSequence = BigInt(right);
    return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function externalOpenPath(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const filePath = (args as Record<string, unknown>)["filePath"];
  return typeof filePath === "string" && filePath.trim() ? filePath : undefined;
}

function selectedLevelId(selection: Selection | undefined): string | undefined {
  if (!selection) return undefined;
  if (selection.kind === "level" || selection.kind === "cell") return selection.levelId;
  if (selection.kind === "entity-instance" || selection.kind === "camera" || selection.kind === "light") {
    return selection.levelId;
  }
  return undefined;
}

function isNativeTextEditingShortcut(chord: string): boolean {
  const normalized = normalizeShortcut(chord);
  return normalized === "CtrlOrMeta+Z" || normalized === "CtrlOrMeta+Shift+Z" ||
    normalized === "CtrlOrMeta+Y" || normalized === "CtrlOrMeta+X" ||
    normalized === "CtrlOrMeta+C" || normalized === "CtrlOrMeta+V" ||
    normalized === "CtrlOrMeta+A";
}
