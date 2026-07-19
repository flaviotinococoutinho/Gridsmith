import path from "node:path";
import type {
  CreateProjectFromTemplateRequest,
  DiscardAutosaveRequest,
  OpenProjectRequest,
  ProjectActionResult,
  ProjectStatusPayload,
  ProjectTemplateDescriptor,
  RestoreAutosaveRequest,
} from "../../core/projectApi.js";
import { MAX_PROJECT_TILE_SIZE } from "../../core/projectApi.js";
import {
  ProjectLifecycle,
  type ProjectDescriptor,
} from "../../core/projectLifecycle.js";
import type {
  CapturedProjectSnapshot,
  DispatchOutcome,
  HistoryOperationResult,
  HistoryStatusPayload,
  ProjectOperationResult,
  ProjectRevisionExpectation,
  ProjectStatus,
  ProjectTemplateCreationOptions,
} from "../EditorClient.js";
import { ProjectFileService, type RecoveryCandidate } from "./ProjectFileService.js";

export interface EditorProjectPort {
  readonly activeProjectSessionId: string | undefined;
  dispatch(kind: string, payload: Record<string, unknown>): Promise<DispatchOutcome>;
  listProjectTemplates(): Promise<{ templates: ProjectTemplateDescriptor[] }>;
  materializeProjectTemplate(
    templateId: string,
    options: ProjectTemplateCreationOptions,
  ): Promise<unknown>;
  openProjectDocument(
    document: unknown,
    expectation?: ProjectRevisionExpectation,
  ): Promise<ProjectOperationResult>;
  captureProjectSnapshot(expectedProjectSessionId?: string): Promise<CapturedProjectSnapshot>;
  closeProject(expectation?: ProjectRevisionExpectation): Promise<ProjectStatus>;
  undo(): Promise<HistoryOperationResult>;
  redo(): Promise<HistoryOperationResult>;
  historyStatus(limit?: number): Promise<HistoryStatusPayload>;
}

export type UnsavedDecision = "save" | "discard" | "cancel";
export type RecoveryDecision = "restore" | "copy" | "ignore" | "cancel";

export interface ProjectDialogPort {
  chooseProjectFile(): Promise<string | undefined>;
  chooseProjectDirectory(projectName: string): Promise<string | undefined>;
  chooseSavePath(suggestedName: string): Promise<string | undefined>;
  confirmUnsavedChanges(projectName: string): Promise<UnsavedDecision>;
  chooseRecovery(candidate: RecoveryCandidate): Promise<RecoveryDecision>;
}

export interface ProjectFileLease {
  readonly canonicalPath: string;
  release(): Promise<void>;
}

export interface ProjectFileLeasePort {
  acquire(canonicalPath: string): Promise<ProjectFileLease | undefined>;
}

export interface ProjectControllerOptions {
  readonly lifecycle: ProjectLifecycle;
  readonly editor: EditorProjectPort;
  readonly files: ProjectFileService;
  readonly dialogs: ProjectDialogPort;
  readonly leases: ProjectFileLeasePort;
  readonly exampleProjectPath: string;
  readonly createId: () => string;
}

interface ReplacementGuard {
  readonly proceed: boolean;
  readonly discardedProject?: ProjectDescriptor;
}

/**
 * Caso de uso único do ciclo de vida. Não importa Electron nem node:fs;
 * dialogs/filesystem/leases entram por portas e todas as operações são
 * serializadas para impedir interleaving de menu, toolbar e segunda instância.
 */
export class ProjectController {
  private tail: Promise<void> = Promise.resolve();
  private activeLease: ProjectFileLease | undefined;
  private lastKnownDocument: unknown;
  private lastKnownCommandSequence: string | undefined;
  private readonly activeGestures = new Set<string>();
  private readonly gestureWaiters = new Set<() => void>();

  constructor(private readonly options: ProjectControllerOptions) {}

  get status(): ProjectStatusPayload {
    return statusOf(this.options.lifecycle);
  }

  listProjectTemplates(): Promise<ProjectTemplateDescriptor[]> {
    return this.enqueue(async () => (await this.options.editor.listProjectTemplates()).templates);
  }

  dispatch(
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<{ readonly outcome: DispatchOutcome; readonly autosaveDue: boolean }> {
    return this.enqueue(async () => {
      const outcome = await this.options.editor.dispatch(kind, payload);
      const autosaveDue = await this.observeCommittedCommandUnlocked(outcome.event);
      return { outcome, autosaveDue };
    });
  }

  observeCommittedCommand(event: {
    readonly projectSessionId: string;
    readonly commandSequence: string;
    readonly documentStateId?: string;
  }): Promise<boolean> {
    return this.enqueue(() => this.observeCommittedCommandUnlocked(event));
  }

  reconcileRemoteSnapshot(snapshot: {
    readonly status: ProjectStatus;
    readonly projections: Readonly<Record<string, unknown>>;
  }): Promise<"applied" | "recovered" | "preserved"> {
    return this.enqueue(() => this.reconcileRemoteSnapshotUnlocked(snapshot));
  }

  createProjectFromTemplate(
    request: CreateProjectFromTemplateRequest,
  ): Promise<ProjectActionResult> {
    return this.afterGestures(() =>
      this.enqueue(() => this.createProjectFromTemplateUnlocked(request)));
  }

  openProject(request: OpenProjectRequest = {}): Promise<ProjectActionResult> {
    return this.afterGestures(() => this.enqueue(() => this.openProjectUnlocked(request)));
  }

  openRecent(filePath: string): Promise<ProjectActionResult> {
    return this.afterGestures(() => this.enqueue(async () => {
      if (!(await this.options.files.exists(filePath))) {
        this.options.lifecycle.removeRecent(filePath);
        throw new Error(`O projeto recente não existe mais: ${filePath}`);
      }
      return this.openPathUnlocked(filePath);
    }));
  }

  saveProject(): Promise<ProjectActionResult> {
    return this.afterGestures(() => this.enqueue(() => this.saveUnlocked(false)));
  }

  saveProjectAs(): Promise<ProjectActionResult> {
    return this.afterGestures(() => this.enqueue(() => this.saveUnlocked(true)));
  }

  closeProject(): Promise<ProjectActionResult> {
    return this.afterGestures(() => this.enqueue(() => this.closeUnlocked()));
  }

  beginEditGesture(transactionId: string): void {
    if (!transactionId.trim()) throw new Error("transactionId is required");
    this.activeGestures.add(transactionId);
  }

  endEditGesture(transactionId: string): void {
    if (!this.activeGestures.delete(transactionId) || this.activeGestures.size > 0) return;
    for (const resolve of this.gestureWaiters) resolve();
    this.gestureWaiters.clear();
  }

  /** Libera operações se o renderer terminar antes de enviar `gesture-end`. */
  clearEditGestures(): void {
    if (this.activeGestures.size === 0) return;
    this.activeGestures.clear();
    for (const resolve of this.gestureWaiters) resolve();
    this.gestureWaiters.clear();
  }

  historyStatus(limit = 100): Promise<HistoryStatusPayload> {
    return this.enqueue(() => this.options.editor.historyStatus(limit));
  }

  undo(): Promise<HistoryOperationResult> {
    return this.historyOperation("undo");
  }

  redo(): Promise<HistoryOperationResult> {
    return this.historyOperation("redo");
  }

  restoreAutosave(request: RestoreAutosaveRequest): Promise<ProjectActionResult> {
    return this.afterGestures(() =>
      this.enqueue(() => this.restoreAutosaveUnlocked(request)));
  }

  discardAutosave(request: DiscardAutosaveRequest): Promise<ProjectActionResult> {
    return this.enqueue(async () => {
      await this.options.files.discardAutosave(request.filePath);
      return this.completed();
    });
  }

  autosave(): Promise<boolean> {
    if (this.activeGestures.size > 0) return Promise.resolve(false);
    return this.enqueue(async () => {
      const descriptor = this.options.lifecycle.project;
      if (
        !descriptor?.filePath ||
        !descriptor.projectSessionId ||
        !this.options.lifecycle.isDirty
      ) return false;
      const snapshot = await this.options.editor.captureProjectSnapshot(
        descriptor.projectSessionId,
      );
      if (this.options.lifecycle.project?.projectSessionId !== descriptor.projectSessionId) {
        return false;
      }
      this.rememberDocument(snapshot.document, snapshot.status.commandSequence);
      await this.options.files.writeAutosave(descriptor.filePath, snapshot.document);
      this.options.lifecycle.autosaveCompleted(snapshot.status.commandSequence);
      return true;
    });
  }

  private historyOperation(action: "undo" | "redo"): Promise<HistoryOperationResult> {
    return this.afterGestures(() => this.enqueue(async () => {
      const result = await this.options.editor[action]();
      for (const event of result.events) await this.observeCommittedCommandUnlocked(event);
      const descriptor = this.options.lifecycle.project;
      if (!this.options.lifecycle.isDirty && descriptor?.filePath) {
        await this.options.files.discardAutosave(descriptor.filePath).catch(() => undefined);
      }
      return result;
    }));
  }

  private async afterGestures<T>(operation: () => Promise<T>): Promise<T> {
    // Um segundo pointer gesture pode começar no mesmo turno em que o
    // primeiro resolve os waiters; revalidar evita atravessar esse intervalo.
    while (this.activeGestures.size > 0) {
      await new Promise<void>((resolve) => this.gestureWaiters.add(resolve));
    }
    return operation();
  }

  pruneMissingRecents(): Promise<void> {
    return this.enqueue(async () => {
      for (const recent of [...this.options.lifecycle.recentProjects]) {
        if (!(await this.options.files.exists(recent.filePath))) {
          this.options.lifecycle.removeRecent(recent.filePath);
        }
      }
    });
  }

  private async createProjectFromTemplateUnlocked(
    request: CreateProjectFromTemplateRequest,
  ): Promise<ProjectActionResult> {
    validateCreateRequest(request);
    const guard = await this.guardReplacement();
    if (!guard.proceed) return this.cancelled();

    const directory = await this.options.dialogs.chooseProjectDirectory(request.name);
    if (!directory) return this.cancelled();
    const filePath = path.join(directory, `${safeProjectFileStem(request.name)}.p7m.json`);
    if (await this.options.files.exists(filePath)) {
      throw new Error(`Já existe um projeto com este nome em ${directory}`);
    }
    const canonicalPath = await this.options.files.canonicalPath(filePath);
    const candidateLease = await this.acquireLease(canonicalPath);

    const options: ProjectTemplateCreationOptions = {
      projectId: this.options.createId(),
      name: request.name.trim(),
      referenceResolution: request.referenceResolution,
      tileSize: request.tileSize,
    };
    try {
      // Materialização e escrita acontecem sem tocar A. Só depois da
      // publicação exclusiva o documento entra na operação transacional.
      const document = await this.options.editor.materializeProjectTemplate(
        request.templateId,
        options,
      );
      await this.options.files.createProject(filePath, document);
      const result = await this.activateDocument(document, {
        filePath: canonicalPath,
        name: request.name.trim(),
      });
      await this.swapLease(candidateLease);
      await this.discardDescriptorAutosaves(guard.discardedProject);
      return withOpenedLevel(result, document);
    } catch (error) {
      await candidateLease.release().catch(() => undefined);
      // Depois da publicação exclusiva o arquivo é um documento válido e
      // pode ser a única evidência de um commit cuja resposta se perdeu.
      // Nunca o apagamos num erro ambíguo; o usuário pode reabri-lo.
      throw error;
    }
  }

  private async openProjectUnlocked(request: OpenProjectRequest): Promise<ProjectActionResult> {
    if (request.source === "example") return this.openExampleUnlocked();
    const filePath = request.filePath ?? await this.options.dialogs.chooseProjectFile();
    if (!filePath) return this.cancelled();
    return this.openPathUnlocked(filePath);
  }

  private async openPathUnlocked(filePath: string): Promise<ProjectActionResult> {
    const canonicalPath = await this.options.files.canonicalPath(filePath);
    if (this.activeLease?.canonicalPath === canonicalPath) return this.alreadyOpen();
    if (!(await this.options.files.exists(canonicalPath))) {
      this.options.lifecycle.removeRecent(filePath);
      throw new Error(`O arquivo de projeto não existe: ${filePath}`);
    }

    const recovery = await this.options.files.detectRecovery(canonicalPath);
    let discardRecoveryAfterOpen = false;
    if (recovery) {
      const decision = await this.options.dialogs.chooseRecovery(recovery);
      if (decision === "cancel") return this.cancelled();
      if (decision === "restore" || decision === "copy") {
        return this.restoreAutosaveUnlocked({
          filePath: canonicalPath,
          mode: decision === "restore" ? "restore" : "copy",
        });
      }
      // O sidecar só é descartado depois que parse, guarda e ativação do
      // original concluírem. Até lá, qualquer falha/cancelamento o preserva.
      discardRecoveryAfterOpen = true;
    }

    const document = await this.options.files.readDocument(canonicalPath);
    const guard = await this.guardReplacement();
    if (!guard.proceed) return this.cancelled();
    const candidateLease = await this.acquireLease(canonicalPath);
    let result: ProjectActionResult;
    try {
      result = await this.activateDocument(document, {
        filePath: canonicalPath,
        name: documentName(document, canonicalPath),
      });
      await this.swapLease(candidateLease);
    } catch (error) {
      await candidateLease.release().catch(() => undefined);
      throw error;
    }
    if (discardRecoveryAfterOpen) {
      await this.options.files.discardAutosave(canonicalPath).catch(() => undefined);
    }
    await this.discardDescriptorAutosaves(guard.discardedProject);
    return withOpenedLevel(result, document);
  }

  private async openExampleUnlocked(): Promise<ProjectActionResult> {
    const distributed = await this.options.files.readDocument(this.options.exampleProjectPath);
    const guard = await this.guardReplacement();
    if (!guard.proceed) return this.cancelled();
    const copy = cloneAsEditableCopy(distributed, this.options.createId(), " — cópia");
    const result = await this.activateDocument(copy, {
        name: suffixedDocumentName(copy, "Exemplo", " — cópia"),
      });
    await this.releaseActiveLease();
    await this.discardDescriptorAutosaves(guard.discardedProject);
    return withOpenedLevel(result, copy);
  }

  private async restoreAutosaveUnlocked(
    request: RestoreAutosaveRequest,
  ): Promise<ProjectActionResult> {
    const canonicalPath = await this.options.files.canonicalPath(request.filePath);
    const document = await this.options.files.readAutosave(canonicalPath);
    const guard = await this.guardReplacement();
    if (!guard.proceed) return this.cancelled();

    if (request.mode === "copy") {
      const copy = cloneAsEditableCopy(document, this.options.createId(), " — recuperado");
      const result = await this.activateDocument(copy, {
        name: suffixedDocumentName(copy, canonicalPath, " — recuperado"),
        recoverySourceFilePath: canonicalPath,
      }, true);
      await this.releaseActiveLease();
      await this.discardDescriptorAutosaves(guard.discardedProject);
      return withOpenedLevel(result, copy);
    }

    const candidateLease = this.activeLease?.canonicalPath === canonicalPath
      ? this.activeLease
      : await this.acquireLease(canonicalPath);
    try {
      const result = await this.activateDocument(document, {
        filePath: canonicalPath,
        name: documentName(document, canonicalPath),
        recoverySourceFilePath: canonicalPath,
      }, true);
      if (candidateLease !== this.activeLease) await this.swapLease(candidateLease);
      await this.discardDescriptorAutosaves(guard.discardedProject);
      return withOpenedLevel(result, document);
    } catch (error) {
      if (candidateLease !== this.activeLease) {
        await candidateLease.release().catch(() => undefined);
      }
      // Sidecar só é removido por Save confirmado ou discardAutosave.
      throw error;
    }
  }

  private async saveUnlocked(forceSaveAs: boolean): Promise<ProjectActionResult> {
    const descriptor = this.options.lifecycle.project;
    const expectedSessionId = descriptor?.projectSessionId;
    if (!descriptor || !expectedSessionId) {
      throw new Error("Não há projeto ativo para salvar");
    }

    let filePath = forceSaveAs ? undefined : descriptor.filePath;
    if (!filePath) {
      filePath = await this.options.dialogs.chooseSavePath(descriptor.name);
      if (!filePath) return this.cancelled();
    }
    const canonicalPath = await this.options.files.canonicalPath(filePath);
    const candidateLease = this.activeLease?.canonicalPath === canonicalPath
      ? this.activeLease
      : await this.acquireLease(canonicalPath);

    this.options.lifecycle.beginSave();
    try {
      const snapshot = await this.options.editor.captureProjectSnapshot(expectedSessionId);
      await this.options.files.writeProject(canonicalPath, snapshot.document);
      this.rememberDocument(snapshot.document, snapshot.status.commandSequence);
      this.options.lifecycle.saved(
        canonicalPath,
        snapshot.status.commandSequence,
        snapshot.status.documentStateId,
      );
      if (candidateLease !== this.activeLease) await this.swapLease(candidateLease);
    } catch (error) {
      this.options.lifecycle.saveFailed();
      if (candidateLease !== this.activeLease) {
        await candidateLease.release().catch(() => undefined);
      }
      throw error;
    }

    // O documento já foi publicado e o lifecycle está clean. A limpeza de um
    // sidecar não pode transformar retrospectivamente um Save confirmado em
    // falha nem autorizar outro write; se o SO recusar a remoção, ele fica
    // preservado e será reavaliado pelo timestamp na próxima abertura.
    const autosaveSources = new Set(
      [descriptor.filePath, descriptor.recoverySourceFilePath, canonicalPath].filter(
        (value): value is string => typeof value === "string",
      ),
    );
    for (const source of autosaveSources) {
      await this.options.files.discardAutosave(source).catch(() => undefined);
    }
    return this.completed();
  }

  private async closeUnlocked(): Promise<ProjectActionResult> {
    const lifecycle = this.options.lifecycle;
    if (!lifecycle.project) return this.completed();
    const closingProject = lifecycle.project;
    let discardChanges = false;
    const decision = lifecycle.requestClose();
    if (decision === "confirm-discard") {
      let answer: UnsavedDecision;
      try {
        answer = await this.options.dialogs.confirmUnsavedChanges(lifecycle.project!.name);
      } catch (error) {
        lifecycle.cancelClose();
        throw error;
      }
      if (answer === "cancel") {
        lifecycle.cancelClose();
        return this.cancelled();
      }
      if (answer === "save") {
        lifecycle.cancelClose();
        const saved = await this.saveUnlocked(false);
        if (saved.outcome !== "completed") return saved;
        lifecycle.requestClose();
      } else {
        discardChanges = true;
      }
    }

    const expectedSessionId = lifecycle.project?.projectSessionId;
    try {
      const remote = await this.options.editor.closeProject({
        ...(expectedSessionId ? { projectSessionId: expectedSessionId } : {}),
        commandSequence: lifecycle.commandSequence,
      });
      if (remote.active) throw new Error("O middleware manteve a sessão de projeto ativa");
      lifecycle.confirmClose();
      await this.releaseActiveLease();
      if (discardChanges) await this.discardDescriptorAutosaves(closingProject);
      this.lastKnownDocument = undefined;
      this.lastKnownCommandSequence = undefined;
      return this.completed();
    } catch (error) {
      lifecycle.cancelClose();
      throw error;
    }
  }

  private async guardReplacement(): Promise<ReplacementGuard> {
    const lifecycle = this.options.lifecycle;
    if (!lifecycle.project || !lifecycle.isDirty) return { proceed: true };
    const answer = await this.options.dialogs.confirmUnsavedChanges(lifecycle.project.name);
    if (answer === "cancel") return { proceed: false };
    if (answer === "save") {
      const result = await this.saveUnlocked(false);
      return { proceed: result.outcome === "completed" };
    }
    return { proceed: true, discardedProject: lifecycle.project };
  }

  private async discardDescriptorAutosaves(descriptor?: ProjectDescriptor): Promise<void> {
    if (!descriptor) return;
    const active = this.options.lifecycle.project;
    const activeSources = new Set(
      [active?.filePath, active?.recoverySourceFilePath].filter(
        (value): value is string => typeof value === "string",
      ),
    );
    const sources = new Set(
      [descriptor.filePath, descriptor.recoverySourceFilePath].filter(
        (value): value is string => typeof value === "string",
      ),
    );
    for (const source of sources) {
      // Uma substituição pode reabrir o mesmo recovery como outra cópia ou
      // como restore. Enquanto a nova sessão ainda referenciar esse sidecar,
      // ele só pode ser removido por Save confirmado ou descarte explícito.
      if (activeSources.has(source)) continue;
      await this.options.files.discardAutosave(source).catch(() => undefined);
    }
  }

  private async activateDocument(
    document: unknown,
    descriptor: Omit<ProjectDescriptor, "projectSessionId" | "projectId">,
    dirty = false,
  ): Promise<ProjectActionResult> {
    const lifecycle = this.options.lifecycle;
    const previousSessionId = lifecycle.project?.projectSessionId;
    const expectation: ProjectRevisionExpectation = {
      ...(previousSessionId ? { projectSessionId: previousSessionId } : {}),
      commandSequence: lifecycle.commandSequence,
    };
    lifecycle.beginOpen();
    try {
      const result = await this.options.editor.openProjectDocument(document, expectation);
      lifecycle.opened(descriptorFromStatus(result.status, descriptor), {
        dirty,
        commandSequence: result.status.commandSequence,
        ...(result.status.documentStateId
          ? { documentStateId: result.status.documentStateId }
          : {}),
      });
      this.rememberDocument(document, result.status.commandSequence);
      return this.completed();
    } catch (error) {
      // A mutação pode ter sido commitada e só a resposta ter se perdido.
      // Confirma pelo snapshot/identidade antes de declarar rollback local.
      try {
        const snapshot = await this.options.editor.captureProjectSnapshot();
        const expectedProjectId = documentProjectId(document);
        if (
          snapshot.status.active &&
          snapshot.status.projectSessionId !== previousSessionId &&
          snapshot.status.projectId === expectedProjectId &&
          documentsEqual(snapshot.document, document)
        ) {
          lifecycle.opened(descriptorFromStatus(snapshot.status, descriptor), {
            dirty,
            commandSequence: snapshot.status.commandSequence,
            ...(snapshot.status.documentStateId
              ? { documentStateId: snapshot.status.documentStateId }
              : {}),
          });
          this.rememberDocument(snapshot.document, snapshot.status.commandSequence);
          return this.completed();
        }
      } catch {
        // Falha de confirmação mantém o resultado ambíguo; arquivo e A local
        // continuam preservados para reconciliação posterior.
      }
      lifecycle.openFailed();
      throw error;
    }
  }

  private async acquireLease(canonicalPath: string): Promise<ProjectFileLease> {
    const lease = await this.options.leases.acquire(canonicalPath);
    if (!lease) {
      throw new Error(`O projeto já está aberto para edição: ${canonicalPath}`);
    }
    return lease;
  }

  private async swapLease(next: ProjectFileLease): Promise<void> {
    const previous = this.activeLease;
    this.activeLease = next;
    if (previous && previous !== next) await previous.release().catch(() => undefined);
  }

  private async releaseActiveLease(): Promise<void> {
    const lease = this.activeLease;
    this.activeLease = undefined;
    await lease?.release().catch(() => undefined);
  }

  private async observeCommittedCommandUnlocked(event: {
    readonly projectSessionId: string;
    readonly commandSequence: string;
    readonly documentStateId?: string;
  }): Promise<boolean> {
    const descriptor = this.options.lifecycle.project;
    if (!descriptor || descriptor.projectSessionId !== event.projectSessionId) return false;
    let autosaveDue = this.options.lifecycle.commandApplied(
      event.commandSequence,
      event.documentStateId,
    );
    try {
      const snapshot = await this.options.editor.captureProjectSnapshot(event.projectSessionId);
      if (this.options.lifecycle.project?.projectSessionId === event.projectSessionId) {
        this.rememberDocument(snapshot.document, snapshot.status.commandSequence);
        autosaveDue = this.options.lifecycle.commandApplied(
          snapshot.status.commandSequence,
          snapshot.status.documentStateId,
        ) || autosaveDue;
      }
    } catch {
      // O comando já foi confirmado e o dirty watermark já avançou. Uma queda
      // durante a captura não pode converter sucesso em erro nem limpar dirty.
    }
    return autosaveDue;
  }

  private async reconcileRemoteSnapshotUnlocked(snapshot: {
    readonly status: ProjectStatus;
    readonly projections: Readonly<Record<string, unknown>>;
  }): Promise<"applied" | "recovered" | "preserved"> {
    const lifecycle = this.options.lifecycle;
    const local = lifecycle.project;
    const remote = snapshot.status;
    const remoteDocument = projectionDocument(snapshot.projections);

    if (!local) {
      if (!remote.active || !remote.projectSessionId || !remote.projectId || !remoteDocument) {
        return "applied";
      }
      lifecycle.beginOpen();
      lifecycle.opened({
        name: documentName(remoteDocument, `Projeto ${remote.projectId}`),
        projectSessionId: remote.projectSessionId,
        projectId: remote.projectId,
      }, {
        commandSequence: remote.commandSequence,
        ...(remote.documentStateId ? { documentStateId: remote.documentStateId } : {}),
      });
      this.rememberDocument(remoteDocument, remote.commandSequence);
      await this.releaseActiveLease();
      return "applied";
    }

    if (remote.active && remote.projectSessionId && remote.projectId) {
      if (remote.projectSessionId === local.projectSessionId) {
        lifecycle.commandApplied(remote.commandSequence, remote.documentStateId);
        if (remoteDocument) this.rememberDocument(remoteDocument, remote.commandSequence);
        return "applied";
      }
      if (
        remoteDocument &&
        this.lastKnownDocument !== undefined &&
        this.lastKnownCommandSequence === lifecycle.commandSequence &&
        documentsEqual(remoteDocument, this.lastKnownDocument)
      ) {
        lifecycle.rebindSession({
          projectSessionId: remote.projectSessionId,
          projectId: remote.projectId,
        }, remote.commandSequence, remote.documentStateId);
        if (remoteDocument) this.rememberDocument(remoteDocument, remote.commandSequence);
        return "applied";
      }
      if (!lifecycle.isDirty && remoteDocument) {
        lifecycle.beginOpen();
        lifecycle.opened({
          name: documentName(remoteDocument, `Projeto ${remote.projectId}`),
          projectSessionId: remote.projectSessionId,
          projectId: remote.projectId,
        }, {
          commandSequence: remote.commandSequence,
          ...(remote.documentStateId ? { documentStateId: remote.documentStateId } : {}),
        });
        this.rememberDocument(remoteDocument, remote.commandSequence);
        await this.releaseActiveLease();
        return "applied";
      }
    }

    // Middleware reiniciado com snapshot vazio: restaura a cópia integral
    // confirmada pelo controller sem tocar caminho, recovery, dirty state ou
    // lease. Uma sessão remota ativa e divergente nunca é sobrescrita/religada
    // só por compartilhar projectId.
    if (
      !remote.active &&
      this.lastKnownDocument !== undefined &&
      this.lastKnownCommandSequence === lifecycle.commandSequence
    ) {
      const restored = await this.options.editor.openProjectDocument(
        structuredClone(this.lastKnownDocument),
        { commandSequence: remote.commandSequence },
      );
      if (!restored.status.active || !restored.status.projectSessionId || !restored.status.projectId) {
        return "preserved";
      }
      lifecycle.rebindSession({
        projectSessionId: restored.status.projectSessionId,
        projectId: restored.status.projectId,
      }, restored.status.commandSequence, restored.status.documentStateId);
      this.lastKnownCommandSequence = restored.status.commandSequence;
      return "recovered";
    }
    return "preserved";
  }

  private rememberDocument(document: unknown, commandSequence: string): void {
    this.lastKnownDocument = structuredClone(document);
    this.lastKnownCommandSequence = commandSequence;
  }

  private completed(): ProjectActionResult {
    return { status: this.status, outcome: "completed" };
  }

  private cancelled(): ProjectActionResult {
    return { status: this.status, outcome: "cancelled" };
  }

  private alreadyOpen(): ProjectActionResult {
    return { status: this.status, outcome: "already-open" };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class SingleInstanceProjectLeaseRegistry implements ProjectFileLeasePort {
  private readonly held = new Set<string>();

  async acquire(canonicalPath: string): Promise<ProjectFileLease | undefined> {
    if (this.held.has(canonicalPath)) return undefined;
    this.held.add(canonicalPath);
    let released = false;
    return {
      canonicalPath,
      release: async () => {
        if (released) return;
        released = true;
        this.held.delete(canonicalPath);
      },
    };
  }
}

export function statusOf(lifecycle: ProjectLifecycle): ProjectStatusPayload {
  return {
    state: lifecycle.currentState,
    windowTitle: lifecycle.windowTitle,
    isDirty: lifecycle.isDirty,
    commandSequence: lifecycle.commandSequence,
    ...(lifecycle.currentDocumentStateId
      ? { documentStateId: lifecycle.currentDocumentStateId }
      : {}),
    ...(lifecycle.project ? { project: lifecycle.project } : {}),
    recents: lifecycle.recentProjects,
  };
}

function descriptorFromStatus(
  status: ProjectStatus,
  descriptor: Omit<ProjectDescriptor, "projectSessionId" | "projectId">,
): ProjectDescriptor {
  if (!status.active || !status.projectSessionId || !status.projectId) {
    throw new Error("O middleware não ativou a sessão de projeto preparada");
  }
  return {
    ...descriptor,
    projectSessionId: status.projectSessionId,
    projectId: status.projectId,
  };
}

function validateCreateRequest(request: CreateProjectFromTemplateRequest): void {
  if (!request.templateId.trim()) throw new Error("Selecione um template");
  if (!request.name.trim()) throw new Error("Informe o nome do projeto");
  if (!/^[^\\/:*?\"<>|]+$/.test(request.name.trim())) {
    throw new Error("O nome contém caracteres inválidos para um arquivo");
  }
  const { width, height } = request.referenceResolution;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("A resolução deve conter largura e altura inteiras positivas");
  }
  if (
    !Number.isInteger(request.tileSize) ||
    request.tileSize < 1 ||
    request.tileSize > MAX_PROJECT_TILE_SIZE
  ) {
    throw new Error(`Tile size deve ser um inteiro entre 1 e ${MAX_PROJECT_TILE_SIZE}`);
  }
}

function safeProjectFileStem(name: string): string {
  const normalized = name.trim().normalize("NFKC").replace(/\s+/g, " ");
  return normalized.replace(/[. ]+$/g, "") || "projeto";
}

function documentName(document: unknown, filePath: string): string {
  const name = (document as { metadata?: { name?: unknown } })?.metadata?.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return path.basename(filePath).replace(/\.p7m\.json$/i, "");
}

function documentProjectId(document: unknown): string | undefined {
  const projectId = (document as { projectId?: unknown })?.projectId;
  return typeof projectId === "string" && projectId.length > 0 ? projectId : undefined;
}

function projectionDocument(
  projections: Readonly<Record<string, unknown>>,
): unknown | undefined {
  const projection = projections["document"];
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return undefined;
  const document = (projection as Record<string, unknown>)["document"];
  return document === null || document === undefined ? undefined : document;
}

function suffixedDocumentName(document: unknown, fallback: string, suffix: string): string {
  const name = documentName(document, fallback);
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

function firstLevelId(document: unknown): string | undefined {
  const levels = (document as { levels?: Array<{ levelId?: unknown }> })?.levels;
  const id = levels?.[0]?.levelId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function withOpenedLevel(
  result: ProjectActionResult,
  document: unknown,
): ProjectActionResult {
  const openedLevelId = firstLevelId(document);
  return {
    ...result,
    ...(openedLevelId ? { openedLevelId } : {}),
  };
}

function cloneAsEditableCopy(document: unknown, projectId: string, nameSuffix: string): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("O projeto distribuído não é um documento válido");
  }
  const clone = structuredClone(document as Record<string, unknown>);
  clone["projectId"] = projectId;
  const metadata = clone["metadata"];
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const currentName = (metadata as Record<string, unknown>)["name"];
    if (typeof currentName === "string" && currentName.trim()) {
      (metadata as Record<string, unknown>)["name"] = `${currentName.trim()}${nameSuffix}`;
    }
  }
  return clone;
}

function documentsEqual(left: unknown, right: unknown): boolean {
  try {
    return stableDocumentJson(left) === stableDocumentJson(right);
  } catch {
    return false;
  }
}

function stableDocumentJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableDocumentJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableDocumentJson(record[key])}`)
    .join(",")}}`;
}
