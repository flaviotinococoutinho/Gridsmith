/**
 * Unidade transacional do editor.
 *
 * Uma sessão preparada é totalmente privada: store, histórico e replay não
 * estão ligados a journal, gateways ou runtime. A referência ativa só muda
 * depois que o runtime foi resetado e reidratado; em erro, o runtime anterior
 * é reconstruído e a sessão publicada continua sendo a anterior.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  BlueprintCommand,
  BlueprintEvent,
  BlueprintStore as BlueprintStoreType,
  CommandActor,
} from "../domain/BlueprintStore.js";
import { BlueprintStore } from "../domain/BlueprintStore.js";
import type { ProjectionResult, RuntimeAdapter } from "../runtime/RuntimeAdapter.js";
import type { RuntimeSessionResetResult } from "../runtime/RuntimeAdapter.js";
import {
  BlueprintDocumentError,
  migrateBlueprintDocument,
  parseBlueprintDocument,
  replayDocument,
  type ReplaySummary,
  DEFAULT_PROJECT_METADATA,
  type ProjectMetadata,
  validateProjectMetadata,
} from "./BlueprintSerializer.js";
import { CanonicalOrchestrator } from "./CanonicalOrchestrator.js";
import {
  CommandHistory,
  HistoryConflictError,
  type HistoryEntry,
} from "./CommandHistory.js";
import type { HookBus } from "./HookBus.js";
import { getProjectTemplate } from "./ProjectTemplates.js";

export interface ProjectSession {
  readonly sessionId: string;
  readonly projectId: string;
  readonly store: BlueprintStoreType;
  readonly orchestrator: CanonicalOrchestrator;
  readonly history: CommandHistory;
  readonly createdAt: number;
  /** Metadata imutável persistida junto do documento, fora do estado mutável. */
  readonly metadata: ProjectMetadata;
}

export type ProjectRuntimeState = "synchronized" | "deferred" | "failed";

export interface ProjectStatus {
  readonly active: boolean;
  readonly projectSessionId?: string;
  readonly projectId?: string;
  readonly createdAt?: number;
  readonly commandSequence: string;
  readonly runtimeState: ProjectRuntimeState;
  readonly documentStateId?: string;
  readonly historyCursor?: string;
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
}

export interface PreparedProjectSession {
  readonly session: ProjectSession;
  readonly summary: ReplaySummary;
}

export interface ProjectActivationResult {
  readonly status: ProjectStatus;
  readonly summary: ReplaySummary;
}

export type SessionBlueprintEvent = BlueprintEvent & {
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
  readonly revision: string;
  readonly transactionId: string;
  readonly actor: CommandActor;
  readonly historyEntryId: string;
  readonly historyAction: "apply" | "undo" | "redo";
  readonly documentStateId: string;
  readonly historyCursor: string;
};

export interface ProjectSessionChangedEvent {
  readonly kind: "project/sessionChanged";
  readonly action: "activated" | "closed";
  readonly projectSessionId?: string;
  readonly projectId?: string;
  readonly previousProjectSessionId?: string;
  readonly commandSequence: string;
}

export interface SessionDispatchResult {
  readonly event: SessionBlueprintEvent;
  readonly projection: ProjectionResult | undefined;
  readonly commandSequence: bigint;
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly historyEntry: HistoryEntry;
}

export interface ProjectHistoryEntrySummary {
  readonly id: string;
  readonly label: string;
  readonly actor: CommandActor;
  readonly transactionId: string;
  readonly timestamp: number;
  readonly barrier?: boolean;
  readonly applied: boolean;
}

export interface ProjectHistoryStatus {
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel?: string;
  readonly redoLabel?: string;
  readonly entries: readonly ProjectHistoryEntrySummary[];
}

export interface SessionHistoryOperationResult {
  readonly status: ProjectStatus;
  readonly history: ProjectHistoryStatus;
  readonly entry: HistoryEntry;
  readonly events: readonly SessionBlueprintEvent[];
}

export interface ProjectSessionPort {
  readonly current: ProjectSession | undefined;
  readonly status: ProjectStatus;
  readCurrent(): ProjectSession | undefined;
  dispatch(
    command: BlueprintCommand,
    expectedProjectSessionId?: string,
    actor?: CommandActor,
  ): Promise<SessionDispatchResult>;
}

export interface ProjectSessionManagerOptions {
  readonly hooks: HookBus;
  readonly adapter: RuntimeAdapter;
  readonly now?: () => number;
  readonly createId?: () => string;
}

/** Eventos: `event` (SessionBlueprintEvent) e `sessionChanged` (controle). */
export class ProjectSessionManager extends EventEmitter implements ProjectSessionPort {
  private activeSession: ProjectSession | undefined;
  private readonly prepared = new WeakSet<ProjectSession>();
  private readonly runtimeStates = new Map<string, ProjectRuntimeState>();
  private tail: Promise<void> = Promise.resolve();
  private transitioning = false;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: ProjectSessionManagerOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  get current(): ProjectSession | undefined {
    return this.activeSession;
  }

  /** Porta de leitura das bordas; não expõe snapshot durante troca de runtime. */
  readCurrent(): ProjectSession | undefined {
    if (this.transitioning) {
      throw new ProjectSessionTransitionError(
        "Project session transition is in progress; retry the read after commit",
      );
    }
    return this.activeSession;
  }

  get status(): ProjectStatus {
    const session = this.activeSession;
    if (!session) {
      return Object.freeze({
        active: false,
        commandSequence: "0",
        runtimeState: "synchronized",
      });
    }
    return Object.freeze({
      active: true,
      projectSessionId: session.sessionId,
      projectId: session.projectId,
      createdAt: session.createdAt,
      commandSequence: session.history.lastSequence.toString(),
      runtimeState: this.runtimeStates.get(session.sessionId) ?? "synchronized",
      documentStateId: session.history.documentStateId,
      historyCursor: session.history.historyCursor,
      canUndo: session.history.status.canUndo,
      canRedo: session.history.status.canRedo,
    });
  }

  createEmptySession(
    projectId = this.createId(),
    metadata: ProjectMetadata = DEFAULT_PROJECT_METADATA,
  ): PreparedProjectSession {
    validateId(projectId, "projectId");
    return this.prepareSession(projectId, 0, metadata);
  }

  async createFromTemplate(
    templateId: string,
    projectId = this.createId(),
  ): Promise<PreparedProjectSession> {
    const template = getProjectTemplate(templateId);
    if (!template) throw new BlueprintDocumentError(`Unknown project template "${templateId}"`);
    return this.prepareFromDocument(template.create({ projectId }));
  }

  async prepareFromDocument(raw: unknown): Promise<PreparedProjectSession> {
    // parse → migrar → validar estruturalmente
    const parsed = parseBlueprintDocument(raw);
    const document = migrateBlueprintDocument(parsed);
    validateId(document.projectId, "projectId");
    const prepared = this.prepareSession(document.projectId, 0, document.metadata);

    // criar sessão temporária → replay completo → validações semânticas
    const summary = await replayDocument(
      document,
      prepared.session.store,
      prepared.session.orchestrator,
    );
    this.validateSemantics(prepared.session);
    return Object.freeze({ session: prepared.session, summary });
  }

  activate(prepared: PreparedProjectSession | ProjectSession): Promise<ProjectActivationResult> {
    const normalized = isPreparedWrapper(prepared)
      ? prepared
      : { session: prepared, summary: emptySummary(prepared.history.length) };
    return this.enqueue(() => this.withTransition(() => this.activateUnlocked(normalized)));
  }

  replaceAtomically(
    prepared: PreparedProjectSession,
    expectedProjectSessionId?: string,
    expectedCommandSequence?: string,
  ): Promise<ProjectActivationResult> {
    return this.enqueue(() => this.withTransition(async () => {
      this.assertExpectedRevision(
        expectedProjectSessionId,
        expectedCommandSequence,
        "replace",
      );
      return this.activateUnlocked(prepared);
    }));
  }

  close(
    expectedProjectSessionId?: string,
    expectedCommandSequence?: string,
  ): Promise<ProjectStatus> {
    return this.enqueue(() => this.withTransition(async () => {
      this.assertExpectedRevision(
        expectedProjectSessionId,
        expectedCommandSequence,
        "close",
      );
      const previous = this.activeSession;
      if (!previous) return this.status;

      try {
        await this.options.adapter.resetSession();
      } catch (closeError) {
        // Um reset pode falhar depois de alterar parcialmente o runtime. A
        // sessão continua publicada e restauramos sua projeção antes de
        // reportar a falha ao chamador.
        try {
          const reset = await this.options.adapter.resetSession();
          const results = await this.options.adapter.rehydrateFrom(
            previous.store,
            reset.runtimeSessionEpoch,
          );
          this.runtimeStates.set(previous.sessionId, runtimeStateOf(reset, results));
        } catch (rollbackError) {
          this.runtimeStates.set(previous.sessionId, "failed");
          throw new ProjectSessionRollbackError(closeError, rollbackError, "close");
        }
        throw closeError;
      }
      this.activeSession = undefined;
      this.publish("sessionChanged", Object.freeze({
        kind: "project/sessionChanged",
        action: "closed",
        projectSessionId: previous.sessionId,
        projectId: previous.projectId,
        previousProjectSessionId: previous.sessionId,
        commandSequence: previous.history.lastSequence.toString(),
      }) satisfies ProjectSessionChangedEvent);
      return this.status;
    }));
  }

  dispatch(
    command: BlueprintCommand,
    expectedProjectSessionId?: string,
    actor: CommandActor = "human",
  ): Promise<SessionDispatchResult> {
    return this.enqueue(() => this.withTransition(async () => {
      const session = this.requireCurrent();
      this.assertMutableSession(session, expectedProjectSessionId, "dispatch");
      const result = await session.orchestrator.dispatch(command, { actor });
      if (result.projection?.status === "deferred") {
        await this.repairDeferredRuntime(session);
      }
      const entry = result.historyEntry!;
      const sequence = result.commandSequence.toString();
      const event = Object.freeze({
        ...result.event,
        projectSessionId: session.sessionId,
        projectId: session.projectId,
        commandSequence: sequence,
        revision: sequence,
        transactionId: entry.transactionId,
        actor: entry.actor,
        historyEntryId: entry.id,
        historyAction: "apply",
        documentStateId: result.documentStateId,
        historyCursor: result.historyCursor,
      }) as SessionBlueprintEvent;
      this.publish("event", event);
      return { ...result, event, historyEntry: entry };
    }));
  }

  historyStatus(limit = 50): ProjectHistoryStatus {
    if (!Number.isInteger(limit) || limit < 0 || limit > 500) {
      throw new TypeError("history status limit must be an integer in [0, 500]");
    }
    return this.historyStatusOf(this.requireCurrent(), limit);
  }

  historyUndo(
    expectedProjectSessionId?: string,
    expectedHistoryCursor?: string,
    _actor: CommandActor = "human",
  ): Promise<SessionHistoryOperationResult> {
    return this.moveHistory("undo", expectedProjectSessionId, expectedHistoryCursor);
  }

  historyRedo(
    expectedProjectSessionId?: string,
    expectedHistoryCursor?: string,
    _actor: CommandActor = "human",
  ): Promise<SessionHistoryOperationResult> {
    return this.moveHistory("redo", expectedProjectSessionId, expectedHistoryCursor);
  }

  /** Chamado na conexão/reconexão da engine; lê a sessão ativa dentro do lock. */
  rehydrateCurrent(): Promise<ProjectStatus> {
    return this.enqueue(() => this.withTransition(async () => {
      const session = this.activeSession;
      try {
        const reset = await this.options.adapter.resetSession();
        if (!session) return this.status;
        const results = await this.options.adapter.rehydrateFrom(
          session.store,
          reset.runtimeSessionEpoch,
        );
        this.runtimeStates.set(session.sessionId, runtimeStateOf(reset, results));
        return this.status;
      } catch (error) {
        if (session) this.runtimeStates.set(session.sessionId, "failed");
        throw error;
      }
    }));
  }

  private moveHistory(
    direction: "undo" | "redo",
    expectedProjectSessionId?: string,
    expectedHistoryCursor?: string,
  ): Promise<SessionHistoryOperationResult> {
    return this.enqueue(() => this.withTransition(async () => {
      const session = this.requireCurrent();
      this.assertMutableSession(session, expectedProjectSessionId, direction);
      let moved;
      try {
        moved = direction === "undo"
          ? await session.orchestrator.undo(expectedHistoryCursor)
          : await session.orchestrator.redo(expectedHistoryCursor);
      } catch (error) {
        if (error instanceof HistoryConflictError) {
          throw new ProjectSessionConflictError(error.message);
        }
        throw error;
      }
      if (moved.results.some((result) => result.projection?.status === "deferred")) {
        await this.repairDeferredRuntime(session);
      }
      const events = moved.results.map((result) => {
        const sequence = result.commandSequence.toString();
        return Object.freeze({
          ...result.event,
          projectSessionId: session.sessionId,
          projectId: session.projectId,
          commandSequence: sequence,
          revision: sequence,
          transactionId: moved.entry.transactionId,
          actor: moved.entry.actor,
          historyEntryId: moved.entry.id,
          historyAction: direction,
          documentStateId: moved.documentStateId,
          historyCursor: moved.historyCursor,
        }) as SessionBlueprintEvent;
      });
      // Publicação só começa quando TODO o batch, cursor e runtime consequence
      // terminaram; falha de preflight nunca vaza evento parcial.
      for (const event of events) this.publish("event", event);
      return Object.freeze({
        status: this.status,
        history: this.historyStatusOf(session),
        entry: moved.entry,
        events: Object.freeze(events),
      });
    }));
  }

  private historyStatusOf(session: ProjectSession, limit = 50): ProjectHistoryStatus {
    const status = session.history.status;
    const past = [...session.history.list()].reverse().map((entry) => summarizeHistoryEntry(entry, true));
    const future = session.history.listFuture().map((entry) => summarizeHistoryEntry(entry, false));
    const entries = limit === 0 ? [] : [...past, ...future].slice(0, limit);
    return Object.freeze({
      projectSessionId: session.sessionId,
      projectId: session.projectId,
      commandSequence: status.commandSequence.toString(),
      documentStateId: status.documentStateId,
      historyCursor: status.historyCursor,
      canUndo: status.canUndo,
      canRedo: status.canRedo,
      ...(status.undoLabel !== undefined ? { undoLabel: status.undoLabel } : {}),
      ...(status.redoLabel !== undefined ? { redoLabel: status.redoLabel } : {}),
      entries: Object.freeze(entries),
    });
  }

  /**
   * Uma projeção pode falhar depois de uma primeira RPC destrutiva (por
   * exemplo remove seguido de define/add). O commit canônico continua válido;
   * quando a engine ainda está conectada, reset + replay integral tornam o
   * runtime novamente equivalente ao store antes de publicar o evento/ACK.
   * Falha na reparação permanece explicitamente deferred e nunca desfaz ou
   * esconde o commit já confirmado.
   */
  private async repairDeferredRuntime(session: ProjectSession): Promise<void> {
    this.runtimeStates.set(session.sessionId, "deferred");
    if (!this.options.adapter.isConnected) return;

    try {
      const reset = await this.options.adapter.resetSession();
      const results = await this.options.adapter.rehydrateFrom(
        session.store,
        reset.runtimeSessionEpoch,
      );
      this.runtimeStates.set(session.sessionId, runtimeStateOf(reset, results));
    } catch {
      // O estado canônico e o histórico já foram confirmados. Uma nova sonda
      // de reconexão/rehydrate tentará reparar novamente.
      this.runtimeStates.set(session.sessionId, "deferred");
    }
  }

  private assertMutableSession(
    session: ProjectSession,
    expectedProjectSessionId: string | undefined,
    operation: string,
  ): void {
    if (this.runtimeStates.get(session.sessionId) === "failed") {
      throw new ProjectSessionConflictError(
        "Project runtime is fail-closed after an incomplete rollback; rehydrate before mutation",
      );
    }
    if (
      expectedProjectSessionId !== undefined &&
      expectedProjectSessionId !== session.sessionId
    ) {
      throw new ProjectSessionConflictError(
        `Project session changed before ${operation} (expected ${expectedProjectSessionId}, got ${session.sessionId})`,
      );
    }
  }

  private prepareSession(
    projectId: string,
    applied: number,
    metadata: ProjectMetadata,
  ): PreparedProjectSession {
    const store = new BlueprintStore();
    const history = new CommandHistory(this.now);
    const session: ProjectSession = Object.freeze({
      sessionId: this.createId(),
      projectId,
      store,
      history,
      orchestrator: new CanonicalOrchestrator(store, this.options.hooks, this.options.adapter, history),
      createdAt: this.now(),
      metadata: cloneProjectMetadata(metadata),
    });
    this.prepared.add(session);
    return Object.freeze({ session, summary: emptySummary(applied) });
  }

  private async activateUnlocked(prepared: PreparedProjectSession): Promise<ProjectActivationResult> {
    const candidate = prepared.session;
    if (!this.prepared.has(candidate)) {
      throw new ProjectSessionConflictError("Project session was not prepared by this manager");
    }
    if (candidate === this.activeSession) {
      return { status: this.status, summary: prepared.summary };
    }

    // preparar projeção: o replay e a validação já produziram um snapshot
    // íntegro. A projeção externa só começa após esse ponto.
    this.validateSemantics(candidate);
    const previous = this.activeSession;
    let projectionResults: readonly ProjectionResult[] = [];
    let resetResult: RuntimeSessionResetResult;
    try {
      resetResult = await this.options.adapter.resetSession();
      projectionResults = await this.options.adapter.rehydrateFrom(
        candidate.store,
        resetResult.runtimeSessionEpoch,
      );
    } catch (activationError) {
      // Compensação: restaura o runtime anterior antes de expor qualquer troca.
      try {
        const rollbackReset = await this.options.adapter.resetSession();
        const rollbackResults = previous
          ? await this.options.adapter.rehydrateFrom(
              previous.store,
              rollbackReset.runtimeSessionEpoch,
            )
          : [];
        if (previous) {
          this.runtimeStates.set(
            previous.sessionId,
            runtimeStateOf(rollbackReset, rollbackResults),
          );
        }
      } catch (rollbackError) {
        if (previous) this.runtimeStates.set(previous.sessionId, "failed");
        throw new ProjectSessionRollbackError(activationError, rollbackError);
      }
      throw activationError;
    }

    this.activeSession = candidate;
    this.prepared.delete(candidate);
    this.runtimeStates.set(candidate.sessionId, runtimeStateOf(resetResult, projectionResults));
    const changed = Object.freeze({
      kind: "project/sessionChanged",
      action: "activated",
      projectSessionId: candidate.sessionId,
      projectId: candidate.projectId,
      ...(previous ? { previousProjectSessionId: previous.sessionId } : {}),
      commandSequence: candidate.history.lastSequence.toString(),
    }) satisfies ProjectSessionChangedEvent;
    this.publish("sessionChanged", changed);

    return {
      status: this.status,
      summary: summarize(prepared.summary.applied, projectionResults),
    };
  }

  private validateSemantics(session: ProjectSession): void {
    // O replay pelo BlueprintStore já executa validação referencial e de
    // domínio. Estas asserções fecham invariantes globais do documento.
    const knownLevels = new Set(session.store.listLevels().map((level) => level.levelId));
    for (const placement of session.store.listPlacements()) {
      if (!knownLevels.has(placement.levelId)) {
        throw new BlueprintDocumentError(
          `World placement references unknown level "${placement.levelId}"`,
        );
      }
    }
    if (session.history.length < 0) throw new Error("unreachable history invariant");
  }

  private requireCurrent(): ProjectSession {
    if (!this.activeSession) throw new ProjectNotOpenError();
    return this.activeSession;
  }

  private assertExpectedRevision(
    expectedSessionId: string | undefined,
    expectedCommandSequence: string | undefined,
    operation: string,
  ): void {
    const session = this.activeSession;
    const actualSessionId = session?.sessionId;
    if (expectedSessionId !== undefined && actualSessionId !== expectedSessionId) {
      throw new ProjectSessionConflictError(
        `Active project session changed before ${operation} ` +
          `(expected ${expectedSessionId}, got ${actualSessionId ?? "none"})`,
      );
    }
    // Sequência informada sem ID significa compare-and-swap explícito contra
    // a ausência de sessão. Isso permite que o primeiro Open/New também seja
    // protegido contra uma sessão remota que o cliente ainda não observou.
    if (
      expectedCommandSequence !== undefined &&
      expectedSessionId === undefined &&
      session !== undefined
    ) {
      throw new ProjectSessionConflictError(
        `Active project session appeared before ${operation} ` +
          `(expected none at sequence ${expectedCommandSequence}, got ${session.sessionId})`,
      );
    }
    const actualCommandSequence = session?.history.lastSequence.toString() ?? "0";
    if (
      expectedCommandSequence !== undefined &&
      actualCommandSequence !== expectedCommandSequence
    ) {
      throw new ProjectSessionConflictError(
        `Project command sequence changed before ${operation} ` +
          `(expected ${expectedCommandSequence}, got ${actualCommandSequence})`,
      );
    }
  }

  private async withTransition<T>(operation: () => Promise<T>): Promise<T> {
    this.transitioning = true;
    try {
      return await operation();
    } finally {
      this.transitioning = false;
    }
  }

  /** Observadores são pós-commit e nunca podem alterar o resultado da operação. */
  private publish(eventName: "event" | "sessionChanged", payload: unknown): void {
    for (const listener of this.rawListeners(eventName)) {
      try {
        Reflect.apply(listener, this, [payload]);
      } catch {
        // Falhas de observação são isoladas; a fonte canônica e o journal
        // confiável não podem ser revertidos por telemetria/clientes externos.
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function cloneProjectMetadata(metadata: ProjectMetadata): ProjectMetadata {
  validateProjectMetadata(metadata);
  return Object.freeze({
    name: metadata.name,
    referenceResolution: Object.freeze({
      width: metadata.referenceResolution.width,
      height: metadata.referenceResolution.height,
    }),
    spatial: Object.freeze({
      positionUnit: metadata.spatial.positionUnit,
      cellOrigin: metadata.spatial.cellOrigin,
      yAxis: metadata.spatial.yAxis,
      entityAnchor: metadata.spatial.entityAnchor,
    }),
  });
}

function summarizeHistoryEntry(
  entry: HistoryEntry,
  applied: boolean,
): ProjectHistoryEntrySummary {
  return Object.freeze({
    id: entry.id,
    label: entry.label,
    actor: entry.actor,
    transactionId: entry.transactionId,
    timestamp: entry.timestamp,
    ...(entry.barrier ? { barrier: true } : {}),
    applied,
  });
}

export class ProjectNotOpenError extends Error {
  constructor() {
    super("No project session is active");
    this.name = "ProjectNotOpenError";
  }
}

export class ProjectSessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectSessionConflictError";
  }
}

export class ProjectSessionTransitionError extends ProjectSessionConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ProjectSessionTransitionError";
  }
}

export class ProjectSessionRollbackError extends AggregateError {
  constructor(
    transitionError: unknown,
    rollbackError: unknown,
    transition: "activation" | "close" = "activation",
  ) {
    super(
      [transitionError, rollbackError],
      `Project ${transition} failed and the previous runtime could not be restored; runtime is fail-closed`,
    );
    this.name = "ProjectSessionRollbackError";
  }
}

function validateId(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new BlueprintDocumentError(`"${name}" must be a non-empty string with at most 256 characters`);
  }
}

function isPreparedWrapper(
  value: PreparedProjectSession | ProjectSession,
): value is PreparedProjectSession {
  return "session" in value;
}

function emptySummary(applied: number): ReplaySummary {
  return Object.freeze({ applied, projected: 0, deferred: 0, skipped: 0 });
}

function runtimeStateOf(
  reset: RuntimeSessionResetResult,
  results: readonly ProjectionResult[],
): ProjectRuntimeState {
  return reset.status === "deferred" || results.some((result) => result.status === "deferred")
    ? "deferred"
    : "synchronized";
}

function summarize(applied: number, results: readonly ProjectionResult[]): ReplaySummary {
  const count = (status: ProjectionResult["status"]): number =>
    results.filter((result) => result.status === status).length;
  return Object.freeze({
    applied,
    projected: count("projected"),
    deferred: count("deferred"),
    skipped: count("skipped"),
  });
}
