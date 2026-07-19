/**
 * Cliente transport-neutral do editor. O cursor de eventos é composto por
 * instância do middleware + sequência decimal, e todo resync substitui um
 * snapshot completo antes de reabrir stream/polling.
 */

import { randomUUID } from "node:crypto";
import {
  TransportRouter,
  classifyTransportError,
  type ClassifiedError,
  type TransportName,
  type TransportRouterOptions,
} from "../core/transportRouter.js";
import { createLogger, type Logger } from "../core/logging.js";
import {
  GraphQlAuthenticationError,
  GraphQlDomainError,
  GraphQlTransport,
} from "./transport/GraphQlTransport.js";
import {
  GrpcTransport,
  type HotCursor,
  type HotEvent,
  type HotJournalStatus,
} from "./transport/GrpcTransport.js";
import type { ResolvedExperienceLike } from "../core/experienceGate.js";

export interface BlueprintEventPayload {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface DispatchOutcome {
  readonly event: BlueprintEventPayload;
  readonly projection?: { status: string; reason?: string };
}

export interface ProjectionSnapshot extends HotCursor {
  readonly firstAvailableSeq: string;
  readonly projections: Readonly<Record<string, unknown>>;
}

export interface ResynchronizationRecord {
  readonly reason: string;
  readonly atUnixMs: number;
  readonly previousMiddlewareInstanceId?: string;
  readonly middlewareInstanceId: string;
  readonly lastEventSeq: string;
}

export interface TransportReadiness {
  readonly middlewareActive: boolean;
  readonly graphqlActive: boolean;
  readonly grpcActive: boolean;
  readonly authenticationFailed: boolean;
  readonly graphqlAuthenticationFailed: boolean;
  readonly grpcAuthenticationFailed: boolean;
  readonly graphqlReason?: string;
  readonly grpcReason?: string;
}

export interface TechnicalTransportDiagnostics {
  readonly activeTransport: "gRPC" | "GraphQL fallback";
  readonly switchReason?: string;
  readonly nextProbeAtUnixMs?: number;
  readonly resynchronizationExecuted: boolean;
  readonly resynchronizationCount: number;
  readonly lastResynchronization?: ResynchronizationRecord;
  readonly cursor?: HotCursor & { firstAvailableSeq?: string };
  readonly readiness?: TransportReadiness;
  readonly fatalError?: string;
}

const EXPERIENCE_QUERY = `query ($family: String, $version: String) {
  experience(family: $family, version: $version) {
    family requestedVersion profileVersion displayName capabilities constraints
    decisions { feature enabled source reason }
    liveManifestConsidered
  }
}`;

const SNAPSHOT_QUERY = `query EditorSnapshot {
  snapshot { projections middlewareInstanceId firstAvailableSeq lastEventSeq }
}`;

const HEALTH_QUERY = `query EditorHealth {
  health { ok engineConnected middlewareInstanceId firstAvailableSeq lastEventSeq }
}`;

const EVENT_BATCH_QUERY = `query EventBatch($instance: String!, $after: String!) {
  eventBatch(middlewareInstanceId: $instance, afterSeq: $after) {
    middlewareInstanceId firstAvailableSeq lastEventSeq
    resyncRequired resyncReason
    events { seq kind payload }
  }
}`;

export interface EditorClientOptions {
  readonly requestTimeoutMs?: number;
  readonly eventPollMs?: number;
  readonly probeTickMs?: number;
  readonly resyncRetryMs?: number;
  readonly authToken?: string;
  readonly grpcEnabled?: boolean;
  readonly router?: TransportRouterOptions;
  readonly log?: Logger;
}

interface EventBatchWire {
  middlewareInstanceId: string;
  firstAvailableSeq: string;
  lastEventSeq: string;
  resyncRequired: boolean;
  resyncReason?: string | null;
  events: Array<{ seq: string; kind: string; payload: unknown }>;
}

export class EditorClient {
  private readonly router: TransportRouter;
  private readonly log: Logger;
  private readonly grpc: GrpcTransport;
  private readonly graphql: GraphQlTransport;
  private readonly eventListeners = new Set<(event: BlueprintEventPayload) => void>();
  private readonly resyncListeners = new Set<(snapshot: ProjectionSnapshot, record: ResynchronizationRecord) => void>();
  private readonly eventPollMs: number;
  private readonly probeTickMs: number;
  private readonly resyncRetryMs: number;
  private readonly grpcEnabled: boolean;

  private sessionId: string | undefined;
  private cursor: (HotCursor & { firstAvailableSeq?: string }) | undefined;
  private projectionState: ProjectionSnapshot | undefined;
  private cancelStream: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private resyncRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private resyncPromise: Promise<void> | undefined;
  private pollInFlight = false;
  private resynchronizationCount = 0;
  private lastResynchronization: ResynchronizationRecord | undefined;
  private lastReadiness: TransportReadiness | undefined;
  private fatalTransportError: string | undefined;
  private closed = false;

  constructor(pipeName: string, options: EditorClientOptions = {}) {
    this.log = options.log ?? createLogger("editor-client");
    const timeout = options.requestTimeoutMs ?? 10_000;
    this.grpc = new GrpcTransport(pipeName, this.log.child("grpc"), timeout, options.authToken);
    this.graphql = new GraphQlTransport(pipeName, this.log.child("graphql"), timeout, options.authToken);
    this.router = new TransportRouter(options.router);
    this.eventPollMs = options.eventPollMs ?? 500;
    this.probeTickMs = options.probeTickMs ?? 1_000;
    this.resyncRetryMs = options.resyncRetryMs ?? 1_000;
    this.grpcEnabled = options.grpcEnabled ?? process.env["P7M_GRPC_ENABLED"] !== "0";
  }

  get isConnected(): boolean {
    return this.sessionId !== undefined && !this.closed;
  }

  /** Único ponto público que expõe qual transport está ativo. */
  get technicalDiagnostics(): TechnicalTransportDiagnostics {
    const snapshot = this.router.snapshot;
    const transition = this.router.history.at(-1);
    return {
      activeTransport: snapshot.active === "grpc" ? "gRPC" : "GraphQL fallback",
      ...(transition ? { switchReason: transition.reason } : {}),
      ...(snapshot.nextProbeAtMs !== undefined ? { nextProbeAtUnixMs: snapshot.nextProbeAtMs } : {}),
      resynchronizationExecuted: this.resynchronizationCount > 0,
      resynchronizationCount: this.resynchronizationCount,
      ...(this.lastResynchronization ? { lastResynchronization: this.lastResynchronization } : {}),
      ...(this.cursor ? { cursor: { ...this.cursor } } : {}),
      ...(this.lastReadiness ? { readiness: this.lastReadiness } : {}),
      ...(this.fatalTransportError ? { fatalError: this.fatalTransportError } : {}),
    };
  }

  get latestProjectionSnapshot(): ProjectionSnapshot | undefined {
    return this.projectionState;
  }

  async probeReadiness(): Promise<TransportReadiness> {
    const [grpcResult, graphqlResult] = await Promise.allSettled([
      this.grpc.health(),
      this.graphql.execute<{ health: { ok: boolean } }>(HEALTH_QUERY),
    ]);
    const grpcError = grpcResult.status === "rejected" ? classifyTransportError(grpcResult.reason) : undefined;
    const graphqlError = graphqlResult.status === "rejected" ? classifyTransportError(graphqlResult.reason) : undefined;
    const grpcAuthenticationFailed = grpcError?.category === "authentication";
    const graphqlAuthenticationFailed = graphqlError?.category === "authentication";
    const readiness: TransportReadiness = {
      middlewareActive:
        grpcResult.status === "fulfilled" ||
        graphqlResult.status === "fulfilled" ||
        grpcAuthenticationFailed || graphqlAuthenticationFailed,
      grpcActive: grpcResult.status === "fulfilled" && grpcResult.value.ok,
      graphqlActive: graphqlResult.status === "fulfilled" && graphqlResult.value.health.ok,
      authenticationFailed: grpcAuthenticationFailed || graphqlAuthenticationFailed,
      grpcAuthenticationFailed,
      graphqlAuthenticationFailed,
      ...(grpcError ? { grpcReason: grpcError.reason } : {}),
      ...(graphqlError ? { graphqlReason: graphqlError.reason } : {}),
    };
    this.lastReadiness = readiness;
    return readiness;
  }

  async connect(): Promise<{ sessionId: string }> {
    if (this.closed) throw new Error("EditorClient is closed");
    if (this.sessionId) return { sessionId: this.sessionId };

    if (!this.grpcEnabled) {
      this.router.onTransportFailure("grpc", Date.now(), availability("disabled by feature flag"));
    } else {
      try {
        const health = await this.grpc.health();
        if (!health.ok) throw Object.assign(new Error("gRPC health returned not ready"), { code: 14 });
        this.log.info("gRPC transport reachable", { engineConnected: health.engineConnected });
      } catch (error) {
        const classified = classifyTransportError(error);
        if (classified.category !== "availability") {
          if (classified.category === "authentication") this.recordFatalTransportError(classified);
          throw this.normalizeError(error);
        }
        this.router.onTransportFailure("grpc", Date.now(), classified);
        this.log.warn("gRPC unavailable at connect; using GraphQL fallback", {
          reason: classified.reason,
        });
      }
    }

    // GraphQL é baseline completo: a conexão só fica pronta após snapshot
    // coerente, mesmo quando o caminho quente gRPC está disponível.
    await this.resynchronize("initial_connect", false);
    this.sessionId = randomUUID();
    this.startEventPump();
    this.startProbeLoop();
    return { sessionId: this.sessionId };
  }

  onBlueprintEvent(listener: (event: BlueprintEventPayload) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onResynchronized(
    listener: (snapshot: ProjectionSnapshot, record: ResynchronizationRecord) => void,
  ): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  dispatch(kind: string, payload: Record<string, unknown>): Promise<DispatchOutcome> {
    const requestId = randomUUID();
    return this.hotCall(
      async () => (await this.grpc.dispatch(kind, payload, requestId)) as DispatchOutcome,
      async () => {
        const data = await this.graphql.execute<{
          dispatch: { event: BlueprintEventPayload; projection: { status: string } | null };
        }>(
          `mutation ($kind: CommandKind!, $payload: JSON!, $requestId: String!) {
            dispatch(kind: $kind, payload: $payload, requestId: $requestId) {
              event projection { status reason detail }
            }
          }`,
          { kind: kind.replace("/", "_"), payload, requestId },
        );
        return {
          event: data.dispatch.event,
          ...(data.dispatch.projection ? { projection: data.dispatch.projection } : {}),
        } as DispatchOutcome;
      },
    );
  }

  query<T = unknown>(projection: string): Promise<T> {
    return this.hotCall(
      async () => (await this.grpc.query(projection)) as T,
      async () => {
        const data = await this.graphql.execute<{ projection: T }>(
          `query ($name: String!) { projection(name: $name) }`,
          { name: projection },
        );
        return data.projection;
      },
    );
  }

  resolveExperience(family?: string, version?: string): Promise<ResolvedExperienceLike> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{ experience: ResolvedExperienceLike }>(
        EXPERIENCE_QUERY,
        { family: family ?? null, version: version ?? null },
      );
      return data.experience;
    });
  }

  async saveDocument(): Promise<unknown> {
    const { document } = await this.query<{ document: unknown }>("document");
    return document;
  }

  loadDocument(document: unknown): Promise<{
    applied: number;
    projected: number;
    deferred: number;
    skipped: number;
  }> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{
        loadDocument: { applied: number; projected: number; deferred: number; skipped: number };
      }>(
        `mutation ($doc: JSON!) { loadDocument(document: $doc) { applied projected deferred skipped } }`,
        { doc: document },
      );
      return data.loadDocument;
    });
  }

  listProjectTemplates(): Promise<{
    templates: Array<{ id: string; label: string; description: string }>;
  }> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{
        templates: Array<{ id: string; label: string; description: string }>;
      }>("{ templates { id label description } }");
      return { templates: data.templates };
    });
  }

  newProjectFromTemplate(templateId: string): Promise<{
    templateId: string;
    name: string;
    applied: number;
    projected: number;
    deferred: number;
    skipped: number;
  }> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{
        newProjectFromTemplate: {
          templateId: string;
          name: string;
          applied: number;
          projected: number;
          deferred: number;
          skipped: number;
        };
      }>(
        `mutation ($id: String!) {
          newProjectFromTemplate(templateId: $id) {
            templateId name applied projected deferred skipped
          }
        }`,
        { id: templateId },
      );
      return data.newProjectFromTemplate;
    });
  }

  close(): void {
    this.closed = true;
    this.sessionId = undefined;
    this.stopEventPump();
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.resyncRetryTimer) clearTimeout(this.resyncRetryTimer);
    this.probeTimer = undefined;
    this.resyncRetryTimer = undefined;
    this.grpc.close();
  }

  private async hotCall<T>(viaGrpc: () => Promise<T>, viaGraphql: () => Promise<T>): Promise<T> {
    if (this.router.active === "grpc") {
      try {
        const result = await viaGrpc();
        this.router.onCallSuccess("grpc");
        return result;
      } catch (error) {
        const classified = classifyTransportError(error);
        if (classified.category !== "availability") {
          if (classified.category === "authentication") this.recordFatalTransportError(classified);
          throw this.normalizeError(error);
        }
        const decision = this.router.onTransportFailure("grpc", Date.now(), classified);
        const fallbackActive =
          decision === "fellBack" || this.router.snapshot.active === "graphql";
        this.log.warn("gRPC call failed", {
          reason: classified.reason,
          fellBack: fallbackActive,
        });
        if (decision === "fellBack") {
          this.onFellBack();
        } else if (!fallbackActive) {
          throw this.normalizeError(error);
        }
        // O stream pode ter feito a transição enquanto esta chamada gRPC
        // ainda estava em voo. Nesse caso `onTransportFailure` retorna
        // `stay` porque o router já está em fallback; a chamada corrente
        // ainda precisa continuar pelo baseline GraphQL.
      }
    }
    try {
      return await viaGraphql();
    } catch (error) {
      const classified = classifyTransportError(error);
      if (classified.category === "authentication") this.recordFatalTransportError(classified);
      throw this.normalizeError(error);
    }
  }

  private async coldCall<T>(viaGraphql: () => Promise<T>): Promise<T> {
    try {
      return await viaGraphql();
    } catch (error) {
      const classified = classifyTransportError(error);
      if (classified.category === "authentication") this.recordFatalTransportError(classified);
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): Error {
    if (error instanceof GraphQlAuthenticationError) return error;
    if (error instanceof GraphQlDomainError) {
      return new Error(error.code !== undefined ? `${error.message} (code ${error.code})` : error.message);
    }
    const candidate = error as { details?: string; message?: string };
    if (typeof candidate?.details === "string" && candidate.details.length > 0) {
      return new Error(candidate.details);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private startEventPump(): void {
    if (this.closed || !this.sessionId) return;
    if (this.router.active === "grpc") this.openStream();
    else this.startPolling();
  }

  private stopEventPump(): void {
    this.cancelStream?.();
    this.cancelStream = undefined;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private openStream(): void {
    const cursor = this.cursor;
    if (!cursor) {
      this.requestResync("missing_cursor");
      return;
    }
    this.cancelStream = this.grpc.streamEvents(
      cursor,
      (status) => this.handleStreamStatus(status),
      (event) => this.deliver(event),
      (error) => {
        const classified = classifyTransportError(error);
        if (classified.category !== "availability") {
          this.recordFatalTransportError(classified);
          return;
        }
        const decision = this.router.onTransportFailure("grpc", Date.now(), classified);
        this.log.warn("gRPC event stream lost", { reason: classified.reason });
        if (decision === "fellBack") this.onFellBack();
      },
    );
  }

  private handleStreamStatus(status: HotJournalStatus): void {
    const cursor = this.cursor;
    if (!cursor) {
      this.requestResync("missing_cursor");
      return;
    }
    if (status.resyncRequired) {
      this.requestResync(status.resyncReason ?? "server_resync_required");
      return;
    }
    if (status.middlewareInstanceId !== cursor.middlewareInstanceId) {
      this.requestResync("instance_changed");
      return;
    }
    const after = parseSequence(cursor.lastEventSeq);
    const first = parseSequence(status.firstAvailableSeq);
    const last = parseSequence(status.lastEventSeq);
    if (after === undefined || first === undefined || last === undefined || after > last || after + 1n < first) {
      this.requestResync("invalid_stream_window");
      return;
    }
    this.cursor = { ...cursor, firstAvailableSeq: status.firstAvailableSeq };
  }

  private startPolling(): void {
    this.schedulePoll(0);
  }

  private schedulePoll(delayMs: number): void {
    if (this.closed || this.router.active !== "graphql" || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.pollEvents();
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private async pollEvents(): Promise<void> {
    if (this.pollInFlight || this.closed || this.router.active !== "graphql") return;
    this.pollInFlight = true;
    try {
      if (this.resyncPromise) await this.resyncPromise;
      const cursor = this.cursor;
      if (!cursor) {
        await this.resynchronize("missing_cursor");
        return;
      }
      const data = await this.graphql.execute<{ eventBatch: EventBatchWire }>(EVENT_BATCH_QUERY, {
        instance: cursor.middlewareInstanceId,
        after: cursor.lastEventSeq,
      });
      const batch = data.eventBatch;
      if (batch.resyncRequired) {
        await this.resynchronize(batch.resyncReason ?? "server_resync_required");
        return;
      }
      if (batch.middlewareInstanceId !== cursor.middlewareInstanceId) {
        await this.resynchronize("instance_changed");
        return;
      }
      for (const event of batch.events) {
        if (!this.deliver(event)) return;
      }
      if (this.cursor?.lastEventSeq !== batch.lastEventSeq) {
        await this.resynchronize("poll_window_mismatch");
      } else if (this.cursor) {
        this.cursor = { ...this.cursor, firstAvailableSeq: batch.firstAvailableSeq };
      }
    } catch (error) {
      const classified = classifyTransportError(error);
      if (classified.category === "authentication") this.recordFatalTransportError(classified);
      else this.log.debug("event poll failed", { reason: classified.reason });
    } finally {
      this.pollInFlight = false;
      if (!this.fatalTransportError) this.schedulePoll(this.eventPollMs);
    }
  }

  private deliver(event: HotEvent): boolean {
    const cursor = this.cursor;
    const sequence = parseSequence(event.seq);
    const last = cursor ? parseSequence(cursor.lastEventSeq) : undefined;
    if (!cursor || sequence === undefined || last === undefined) {
      this.requestResync("invalid_event_cursor");
      return false;
    }
    if (sequence <= last) return true;
    if (sequence !== last + 1n) {
      this.requestResync("client_gap");
      return false;
    }
    this.cursor = { ...cursor, lastEventSeq: event.seq };
    for (const listener of this.eventListeners) {
      try {
        listener(event.payload as BlueprintEventPayload);
      } catch (error) {
        this.log.warn("blueprint event listener failed", { message: String(error) });
      }
    }
    return true;
  }

  private onFellBack(): void {
    this.stopEventPump();
    this.startPolling();
  }

  private startProbeLoop(): void {
    if (this.probeTimer || !this.grpcEnabled) return;
    this.probeTimer = setInterval(() => void this.probeGrpc(), this.probeTickMs);
    this.probeTimer.unref?.();
  }

  private async probeGrpc(): Promise<void> {
    const now = Date.now();
    if (!this.router.shouldProbe(now) || this.resyncPromise) return;
    try {
      const health = await this.grpc.health();
      if (!health.ok) {
        this.router.onProbeResult(false, Date.now());
        return;
      }
      if (!this.cursor || health.middlewareInstanceId !== this.cursor.middlewareInstanceId) {
        await this.resynchronize("instance_changed");
      }
      if (this.router.onProbeResult(true, Date.now()) === "promoted") {
        this.log.info("gRPC recovered; promoting", { lastEventSeq: this.cursor?.lastEventSeq });
        this.stopEventPump();
        this.openStream();
      }
    } catch (error) {
      const classified = classifyTransportError(error);
      if (classified.category === "availability") {
        this.router.onProbeResult(false, Date.now());
      } else {
        this.recordFatalTransportError(classified);
      }
    }
  }

  private requestResync(reason: string): void {
    void this.resynchronize(reason).catch((error) => {
      this.log.warn("projection resynchronization failed", { reason, message: String(error) });
      if (this.closed || this.resyncRetryTimer) return;
      this.resyncRetryTimer = setTimeout(() => {
        this.resyncRetryTimer = undefined;
        this.requestResync(reason);
      }, this.resyncRetryMs);
      this.resyncRetryTimer.unref?.();
    });
  }

  private resynchronize(reason: string, restartPump = true): Promise<void> {
    if (this.resyncPromise) return this.resyncPromise;
    const promise = this.performResynchronization(reason, restartPump).finally(() => {
      if (this.resyncPromise === promise) this.resyncPromise = undefined;
    });
    this.resyncPromise = promise;
    return promise;
  }

  private async performResynchronization(reason: string, restartPump: boolean): Promise<void> {
    const shouldRestart = restartPump && this.isConnected;
    if (shouldRestart) this.stopEventPump();
    const previousMiddlewareInstanceId = this.cursor?.middlewareInstanceId;
    const data = await this.graphql.execute<{ snapshot: ProjectionSnapshot }>(SNAPSHOT_QUERY);
    const snapshot = validateSnapshot(data.snapshot);
    this.projectionState = snapshot;
    this.cursor = {
      middlewareInstanceId: snapshot.middlewareInstanceId,
      firstAvailableSeq: snapshot.firstAvailableSeq,
      lastEventSeq: snapshot.lastEventSeq,
    };
    const record: ResynchronizationRecord = {
      reason,
      atUnixMs: Date.now(),
      ...(previousMiddlewareInstanceId ? { previousMiddlewareInstanceId } : {}),
      middlewareInstanceId: snapshot.middlewareInstanceId,
      lastEventSeq: snapshot.lastEventSeq,
    };
    this.resynchronizationCount++;
    this.lastResynchronization = record;
    this.log.info("projection snapshot applied", {
      reason,
      middlewareInstanceId: snapshot.middlewareInstanceId,
      lastEventSeq: snapshot.lastEventSeq,
    });
    for (const listener of this.resyncListeners) {
      try {
        listener(snapshot, record);
      } catch (error) {
        this.log.warn("resynchronization listener failed", { message: String(error) });
      }
    }
    if (shouldRestart && !this.closed) this.startEventPump();
  }

  private recordFatalTransportError(classified: ClassifiedError): void {
    this.fatalTransportError = classified.reason;
    this.stopEventPump();
    this.log.error("non-retryable transport failure", {
      category: classified.category,
      reason: classified.reason,
    });
  }
}

function availability(reason: string): ClassifiedError {
  return { category: "availability", transport: true, reason };
}

function parseSequence(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n && parsed <= (1n << 64n) - 1n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validateSnapshot(snapshot: ProjectionSnapshot): ProjectionSnapshot {
  if (
    !snapshot ||
    typeof snapshot.middlewareInstanceId !== "string" ||
    snapshot.middlewareInstanceId.length === 0 ||
    typeof snapshot.projections !== "object" ||
    snapshot.projections === null
  ) {
    throw new Error("invalid editor projection snapshot");
  }
  const first = parseSequence(snapshot.firstAvailableSeq);
  const last = parseSequence(snapshot.lastEventSeq);
  if (first === undefined || last === undefined || first > last + 1n) {
    throw new Error("invalid editor snapshot cursor bounds");
  }
  return Object.freeze({ ...snapshot, projections: Object.freeze({ ...snapshot.projections }) });
}
