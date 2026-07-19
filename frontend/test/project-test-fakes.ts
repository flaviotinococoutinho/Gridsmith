import path from "node:path";
import type {
  ProjectTemplateDescriptor,
} from "../src/core/projectApi.js";
import type {
  CapturedProjectSnapshot,
  DispatchOutcome,
  HistoryOperationResult,
  HistoryStatusPayload,
  ProjectOperationResult,
  ProjectRevisionExpectation,
  ProjectStatus,
  ProjectTemplateCreationOptions,
} from "../src/main/EditorClient.js";
import type {
  EditorProjectPort,
  ProjectDialogPort,
  RecoveryDecision,
  UnsavedDecision,
} from "../src/main/project/ProjectController.js";
import type {
  DurableWriteHandle,
  ProjectFileStat,
  ProjectFileSystemPort,
  RecoveryCandidate,
} from "../src/main/project/ProjectFileService.js";

export class MemoryProjectFileSystem implements ProjectFileSystemPort {
  readonly files = new Map<string, { content: string; modifiedAtMs: number }>();
  readonly operations: string[] = [];
  failReplaceDestination: string | undefined;
  failRemovePath: string | undefined;
  private clock = 1;

  seed(filePath: string, content: string, modifiedAtMs = this.clock++): void {
    this.files.set(this.normalize(filePath), { content, modifiedAtMs });
  }

  content(filePath: string): string | undefined {
    return this.files.get(this.normalize(filePath))?.content;
  }

  async readText(filePath: string): Promise<string> {
    const entry = this.files.get(this.normalize(filePath));
    if (!entry) throw enoent(filePath);
    this.operations.push(`read:${this.normalize(filePath)}`);
    return entry.content;
  }

  async exists(filePath: string): Promise<boolean> {
    return this.files.has(this.normalize(filePath));
  }

  async stat(filePath: string): Promise<ProjectFileStat> {
    const entry = this.files.get(this.normalize(filePath));
    if (!entry) throw enoent(filePath);
    return { modifiedAtMs: entry.modifiedAtMs, size: Buffer.byteLength(entry.content) };
  }

  async ensureDirectory(directoryPath: string): Promise<void> {
    this.operations.push(`mkdir:${this.normalize(directoryPath)}`);
  }

  async openDurableWrite(filePath: string): Promise<DurableWriteHandle> {
    const normalized = this.normalize(filePath);
    if (this.files.has(normalized)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.operations.push(`open:${normalized}`);
    let content = "";
    let closed = false;
    return {
      writeText: async (value) => {
        this.operations.push(`write:${normalized}`);
        content = value;
      },
      flush: async () => {
        this.operations.push(`flush:${normalized}`);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.operations.push(`close:${normalized}`);
        this.files.set(normalized, { content, modifiedAtMs: this.clock++ });
      },
    };
  }

  async replaceFile(tempPath: string, destinationPath: string): Promise<void> {
    const source = this.normalize(tempPath);
    const destination = this.normalize(destinationPath);
    this.operations.push(`replace:${source}->${destination}`);
    if (this.failReplaceDestination === destination) throw new Error("fault injected at replace");
    const entry = this.files.get(source);
    if (!entry) throw enoent(source);
    this.files.set(destination, { ...entry, modifiedAtMs: this.clock++ });
    this.files.delete(source);
  }

  async publishNewFile(tempPath: string, destinationPath: string): Promise<void> {
    const source = this.normalize(tempPath);
    const destination = this.normalize(destinationPath);
    this.operations.push(`publish-new:${source}->${destination}`);
    if (this.files.has(destination)) {
      throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
    }
    const entry = this.files.get(source);
    if (!entry) throw enoent(source);
    this.files.set(destination, { ...entry, modifiedAtMs: this.clock++ });
    this.files.delete(source);
  }

  async removeFile(filePath: string): Promise<void> {
    const normalized = this.normalize(filePath);
    this.operations.push(`remove:${normalized}`);
    if (this.failRemovePath === normalized) throw new Error("fault injected at remove");
    this.files.delete(normalized);
  }

  async canonicalPath(filePath: string): Promise<string> {
    return this.normalize(filePath);
  }

  async flushDirectory(directoryPath: string): Promise<void> {
    this.operations.push(`flushdir:${this.normalize(directoryPath)}`);
  }

  private normalize(filePath: string): string {
    return path.resolve("/", filePath);
  }
}

export class FakeProjectDialogs implements ProjectDialogPort {
  projectFile: string | undefined;
  projectDirectory: string | undefined;
  savePath: string | undefined;
  unsavedDecision: UnsavedDecision = "discard";
  recoveryDecision: RecoveryDecision = "ignore";
  failUnsavedDialog = false;
  chooseSaveCalls = 0;
  recoveryCandidates: RecoveryCandidate[] = [];

  async chooseProjectFile(): Promise<string | undefined> { return this.projectFile; }
  async chooseProjectDirectory(): Promise<string | undefined> { return this.projectDirectory; }
  async chooseSavePath(): Promise<string | undefined> {
    this.chooseSaveCalls++;
    return this.savePath;
  }
  async confirmUnsavedChanges(): Promise<UnsavedDecision> {
    if (this.failUnsavedDialog) throw new Error("fault injected at unsaved dialog");
    return this.unsavedDecision;
  }
  async chooseRecovery(candidate: RecoveryCandidate): Promise<RecoveryDecision> {
    this.recoveryCandidates.push(candidate);
    return this.recoveryDecision;
  }
}

export class FakeEditorProjectPort implements EditorProjectPort {
  activeProjectSessionId: string | undefined;
  currentDocument: unknown;
  openCalls = 0;
  closeCalls = 0;
  materializeCalls: Array<{ templateId: string; options: ProjectTemplateCreationOptions }> = [];
  failSave = false;
  failOpenAfterCommit = false;
  afterNextCapture: ((snapshot: CapturedProjectSnapshot) => void) | undefined;
  private session = 0;
  private commandSequence = 0;
  private documentStateId = "state-0";

  constructor(
    private readonly templateFactory: (options: ProjectTemplateCreationOptions) => unknown,
    private readonly templates: ProjectTemplateDescriptor[],
  ) {}

  async listProjectTemplates(): Promise<{ templates: ProjectTemplateDescriptor[] }> {
    return { templates: this.templates };
  }

  async dispatch(kind: string, _payload: Record<string, unknown>): Promise<DispatchOutcome> {
    return this.commitExternalCommand(kind, _payload);
  }

  commitExternalCommand(kind: string, payload: Record<string, unknown>): DispatchOutcome {
    if (!this.activeProjectSessionId) throw new Error("no active project");
    this.commandSequence++;
    this.documentStateId = `state-${this.commandSequence}`;
    if (kind === "camera/configure") {
      const document = this.currentDocument as { camera?: Record<string, unknown> };
      document.camera = { ...document.camera, ...(payload["settings"] as object | undefined) };
    }
    if (kind === "level/patch") {
      const levelId = payload["levelId"];
      const changes = payload["changes"];
      const document = this.currentDocument as {
        levels?: Array<{ levelId: string; intGrid: number[] }>;
      };
      const level = document.levels?.find((candidate) => candidate.levelId === levelId);
      if (!level || !Array.isArray(changes)) throw new Error("invalid level patch");
      for (const raw of changes) {
        const change = raw as { index: number; before: number; after: number };
        if (level.intGrid[change.index] !== change.before) throw new Error("level patch conflict");
        level.intGrid[change.index] = change.after;
      }
    }
    return {
      event: {
        kind,
        projectSessionId: this.activeProjectSessionId,
        projectId: (this.currentDocument as { projectId?: string })?.projectId ?? "project",
        commandSequence: String(this.commandSequence),
        ...(typeof payload["transactionId"] === "string"
          ? { transactionId: payload["transactionId"] }
          : {}),
        documentStateId: this.documentStateId,
        historyCursor: `cursor-${this.commandSequence}`,
      },
      documentStateId: this.documentStateId,
      historyCursor: `cursor-${this.commandSequence}`,
    };
  }

  restartMiddleware(): void {
    this.activeProjectSessionId = undefined;
    this.commandSequence = 0;
    this.documentStateId = "state-0";
  }

  async materializeProjectTemplate(
    templateId: string,
    options: ProjectTemplateCreationOptions,
  ): Promise<unknown> {
    this.materializeCalls.push({ templateId, options });
    return this.templateFactory(options);
  }

  async openProjectDocument(
    document: unknown,
    expectation?: ProjectRevisionExpectation,
  ): Promise<ProjectOperationResult> {
    this.assertExpectation(expectation);
    this.openCalls++;
    this.currentDocument = structuredClone(document);
    this.activeProjectSessionId = `session-${++this.session}`;
    this.commandSequence = 0;
    this.documentStateId = "state-0";
    if (this.failOpenAfterCommit) {
      this.failOpenAfterCommit = false;
      throw new Error("response lost after remote commit");
    }
    return {
      status: this.status(true),
      summary: { applied: 1, projected: 1, deferred: 0, skipped: 0 },
    };
  }

  async captureProjectSnapshot(
    expectedProjectSessionId?: string,
  ): Promise<CapturedProjectSnapshot> {
    if (this.failSave) throw new Error("fault injected while reading snapshot");
    if (
      expectedProjectSessionId !== undefined &&
      expectedProjectSessionId !== this.activeProjectSessionId
    ) {
      throw new Error("session changed");
    }
    const snapshot = {
      document: structuredClone(this.currentDocument),
      status: this.status(true),
    };
    const afterCapture = this.afterNextCapture;
    this.afterNextCapture = undefined;
    afterCapture?.(snapshot);
    return snapshot;
  }

  async closeProject(expectation?: ProjectRevisionExpectation): Promise<ProjectStatus> {
    this.closeCalls++;
    this.assertExpectation(expectation);
    this.activeProjectSessionId = undefined;
    return this.status(false);
  }

  async historyStatus(): Promise<HistoryStatusPayload> {
    return {
      projectSessionId: this.activeProjectSessionId,
      projectId: (this.currentDocument as { projectId?: string })?.projectId,
      commandSequence: String(this.commandSequence),
      documentStateId: this.documentStateId,
      historyCursor: `cursor-${this.commandSequence}`,
      canUndo: this.commandSequence > 0,
      canRedo: false,
      entries: [],
    };
  }

  async undo(): Promise<HistoryOperationResult> {
    if (this.commandSequence < 1) throw new Error("nothing to undo");
    this.commandSequence++;
    this.documentStateId = "state-0";
    const event = {
      kind: "cameraConfigured",
      projectSessionId: this.activeProjectSessionId!,
      projectId: (this.currentDocument as { projectId?: string })?.projectId ?? "project",
      commandSequence: String(this.commandSequence),
      documentStateId: this.documentStateId,
      historyCursor: "cursor-0",
      historyAction: "undo" as const,
    };
    return {
      status: this.status(true),
      history: await this.historyStatus(),
      events: [event],
      documentStateId: this.documentStateId,
      historyCursor: "cursor-0",
    };
  }

  async redo(): Promise<HistoryOperationResult> {
    throw new Error("nothing to redo");
  }

  private assertExpectation(expectation?: ProjectRevisionExpectation): void {
    if (!expectation) return;
    if (expectation.projectSessionId !== undefined) {
      if (expectation.projectSessionId !== this.activeProjectSessionId) {
        throw new Error("session changed");
      }
    } else if (expectation.commandSequence !== undefined && this.activeProjectSessionId) {
      throw new Error("session appeared");
    }
    if (
      expectation.commandSequence !== undefined &&
      expectation.commandSequence !== String(this.commandSequence)
    ) {
      throw new Error(
        `command sequence changed (expected ${expectation.commandSequence}, got ${this.commandSequence})`,
      );
    }
  }

  private status(active: boolean): ProjectStatus {
    const document = this.currentDocument as { projectId?: unknown } | undefined;
    return {
      active,
      ...(active ? {
        projectSessionId: this.activeProjectSessionId!,
        projectId: typeof document?.projectId === "string" ? document.projectId : "project",
        createdAt: "1",
      } : {}),
      commandSequence: String(this.commandSequence),
      documentStateId: this.documentStateId,
      historyCursor: `cursor-${this.commandSequence}`,
      canUndo: this.commandSequence > 0,
      canRedo: false,
      runtimeState: "synchronized",
    };
  }
}

export function platformerTemplateDescriptor(): ProjectTemplateDescriptor {
  return {
    id: "platformer-2d",
    label: "Plataforma 2D",
    description: "Template de teste",
    preview: {
      kind: "level-schematic",
      widthCells: 16,
      heightCells: 9,
      playerCell: [2, 7],
      accent: "#3aa0ff",
    },
    defaults: {
      referenceResolution: { width: 1280, height: 720 },
      tileSize: 16,
    },
  };
}

function enoent(filePath: string): Error {
  return Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
}
