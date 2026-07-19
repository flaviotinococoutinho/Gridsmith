/**
 * Cliente do editor (v2 — ADR-016/017): fala com o middleware pelos
 * TRANSPORTS DO APP, com política explícita e testável:
 *
 *  - caminho QUENTE (dispatch, query, eventos): gRPC prioritário; em falha
 *    DE TRANSPORTE, fallback imediato para GraphQL (polling incremental de
 *    eventos) e recovery por sondas com histerese — política pura em
 *    `core/transportRouter.ts`;
 *  - superfície COMPLETA (load, templates, experiência): GraphQL (baseline).
 *
 * A API pública é a mesma da v1 (main.ts e renderer não mudam). Sem Electron
 * aqui (portável a drivers headless — o e2e verify-transports usa esta
 * classe de verdade). Verbosidade via P7M_VERBOSITY (core/logging).
 */

import { randomUUID } from "node:crypto";
import {
  TransportRouter,
  classifyTransportError,
  type TransportName,
} from "../core/transportRouter.js";
import { createLogger, type Logger } from "../core/logging.js";
import { GraphQlTransport, GraphQlDomainError } from "./transport/GraphQlTransport.js";
import { GrpcTransport, type HotEvent } from "./transport/GrpcTransport.js";
import type { ResolvedExperienceLike } from "../core/experienceGate.js";

export interface BlueprintEventPayload {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface DispatchOutcome {
  readonly event: BlueprintEventPayload;
  readonly projection?: { status: string; reason?: string };
}

const EXPERIENCE_QUERY = `query ($family: String, $version: String) {
  experience(family: $family, version: $version) {
    family requestedVersion profileVersion displayName capabilities constraints
    decisions { feature enabled source reason }
    liveManifestConsidered
  }
}`;

export interface EditorClientOptions {
  readonly requestTimeoutMs?: number;
  /** Intervalo do polling de eventos no fallback GraphQL. */
  readonly eventPollMs?: number;
  /** Intervalo de checagem das sondas de recovery. */
  readonly probeTickMs?: number;
  readonly log?: Logger;
}

export class EditorClient {
  private readonly router = new TransportRouter();
  private readonly log: Logger;
  private readonly grpc: GrpcTransport;
  private readonly graphql: GraphQlTransport;
  private readonly eventListeners = new Set<(event: BlueprintEventPayload) => void>();
  private readonly eventPollMs: number;
  private readonly probeTickMs: number;

  private sessionId: string | undefined;
  private lastEventSeq = 0;
  private cancelStream: (() => void) | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(pipeName: string, options: EditorClientOptions = {}) {
    this.log = options.log ?? createLogger("editor-client");
    const timeout = options.requestTimeoutMs ?? 10_000;
    this.grpc = new GrpcTransport(pipeName, this.log.child("grpc"), timeout);
    this.graphql = new GraphQlTransport(pipeName, this.log.child("graphql"), timeout);
    this.eventPollMs = options.eventPollMs ?? 500;
    this.probeTickMs = options.probeTickMs ?? 1_000;
  }

  get isConnected(): boolean {
    return this.sessionId !== undefined && !this.closed;
  }

  /** Transporte ativo do caminho quente (diagnóstico/status bar). */
  get activeTransport(): TransportName {
    return this.router.active;
  }

  async connect(): Promise<{ sessionId: string }> {
    // prioriza o gRPC; indisponível → fallback imediato (política do router)
    try {
      const health = await this.grpc.health();
      this.lastEventSeq = health.lastEventSeq;
      this.log.info("connected via grpc", { engineConnected: health.engineConnected });
    } catch (err) {
      const classified = classifyTransportError(err);
      if (!classified.transport) throw this.normalizeError(err);
      this.router.onTransportFailure("grpc", Date.now(), classified.reason);
      this.log.warn("grpc unavailable at connect; using graphql fallback", {
        reason: classified.reason,
      });
      const data = await this.graphql.execute<{ health: { lastEventSeq: number } }>(
        "{ health { ok engineConnected lastEventSeq } }",
      );
      this.lastEventSeq = data.health.lastEventSeq;
    }
    this.sessionId = randomUUID();
    this.startEventPump();
    this.startProbeLoop();
    return { sessionId: this.sessionId };
  }

  /** Assina o broadcast de eventos do Blueprint. Retorna a função de remoção. */
  onBlueprintEvent(listener: (event: BlueprintEventPayload) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // ---------------- caminho quente (gRPC → fallback GraphQL) ----------------

  dispatch(kind: string, payload: Record<string, unknown>): Promise<DispatchOutcome> {
    return this.hotCall(
      async () => (await this.grpc.dispatch(kind, payload)) as DispatchOutcome,
      async () => {
        const data = await this.graphql.execute<{
          dispatch: { event: BlueprintEventPayload; projection: { status: string } | null };
        }>(
          `mutation ($kind: CommandKind!, $payload: JSON!) {
            dispatch(kind: $kind, payload: $payload) { event projection { status reason detail } }
          }`,
          { kind: kind.replace("/", "_"), payload },
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

  // ------------- superfície completa (GraphQL — baseline do app) -------------

  resolveExperience(family?: string, version?: string): Promise<ResolvedExperienceLike> {
    return this.coldCall(async () => {
      const data = await this.graphql.execute<{ experience: ResolvedExperienceLike }>(
        EXPERIENCE_QUERY,
        { family: family ?? null, version: version ?? null },
      );
      return data.experience;
    });
  }

  /** Snapshot completo do projeto (Save/Save As escrevem isto em disco). */
  async saveDocument(): Promise<unknown> {
    const { document } = await this.query<{ document: unknown }>("document");
    return document;
  }

  /**
   * Reproduz um documento salvo pelo caminho canônico (Open). Exige
   * blueprint vazio — "novo projeto" é estado explícito do ciclo de vida.
   */
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

  /** Templates disponíveis para o fluxo "Novo projeto". */
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

  /**
   * Cria um projeto novo a partir de um template (ex.: "platformer-2d"),
   * reproduzido pelo caminho canônico. Exige blueprint vazio — "novo projeto"
   * é estado explícito do ciclo de vida.
   */
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
          newProjectFromTemplate(templateId: $id) { templateId name applied projected deferred skipped }
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
    this.probeTimer = undefined;
    this.grpc.close();
  }

  // ------------------------------ internos ------------------------------

  /** Caminho quente: transporte ativo; falha DE TRANSPORTE no gRPC → fallback + retry. */
  private async hotCall<T>(viaGrpc: () => Promise<T>, viaGraphql: () => Promise<T>): Promise<T> {
    if (this.router.active === "grpc") {
      try {
        const result = await viaGrpc();
        this.router.onCallSuccess("grpc");
        return result;
      } catch (err) {
        const classified = classifyTransportError(err);
        if (!classified.transport) throw this.normalizeError(err);
        const decision = this.router.onTransportFailure("grpc", Date.now(), classified.reason);
        this.log.warn("grpc call failed; routing to graphql", {
          reason: classified.reason,
          fellBack: decision === "fellBack",
        });
        if (decision === "fellBack") this.onFellBack();
      }
    }
    try {
      return await viaGraphql();
    } catch (err) {
      throw this.normalizeError(err);
    }
  }

  private async coldCall<T>(viaGraphql: () => Promise<T>): Promise<T> {
    try {
      return await viaGraphql();
    } catch (err) {
      throw this.normalizeError(err);
    }
  }

  private normalizeError(err: unknown): Error {
    if (err instanceof GraphQlDomainError) {
      return new Error(err.code !== undefined ? `${err.message} (code ${err.code})` : err.message);
    }
    const e = err as { details?: string; message?: string };
    if (typeof e?.details === "string" && e.details.length > 0) return new Error(e.details);
    return err instanceof Error ? err : new Error(String(err));
  }

  // eventos: stream gRPC no primário; polling GraphQL incremental no fallback
  private startEventPump(): void {
    if (this.closed) return;
    if (this.router.active === "grpc") this.openStream();
    else this.startPolling();
  }

  private stopEventPump(): void {
    this.cancelStream?.();
    this.cancelStream = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private openStream(): void {
    this.cancelStream = this.grpc.streamEvents(
      this.lastEventSeq,
      (event) => this.deliver(event),
      (err) => {
        const classified = classifyTransportError(err);
        const decision = this.router.onTransportFailure(
          "grpc",
          Date.now(),
          `event stream: ${classified.reason}`,
        );
        this.log.warn("event stream lost", { reason: classified.reason });
        if (decision === "fellBack") this.onFellBack();
      },
    );
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.graphql
        .execute<{ eventsSince: Array<{ seq: number; kind: string; payload: unknown }> }>(
          `query ($after: Int!) { eventsSince(afterSeq: $after) { seq kind payload } }`,
          { after: this.lastEventSeq },
        )
        .then((data) => {
          for (const e of data.eventsSince) {
            this.deliver({ seq: e.seq, kind: e.kind, payload: e.payload });
          }
        })
        .catch((err: Error) => this.log.debug("event poll failed", { message: err.message }));
    }, this.eventPollMs);
    this.pollTimer.unref?.();
  }

  private deliver(event: HotEvent): void {
    if (event.seq <= this.lastEventSeq && event.seq !== 0) return; // dedup stream/polling
    if (event.seq > 0) this.lastEventSeq = event.seq;
    for (const listener of this.eventListeners) {
      listener(event.payload as BlueprintEventPayload);
    }
  }

  private onFellBack(): void {
    this.stopEventPump();
    this.startPolling();
  }

  private startProbeLoop(): void {
    if (this.probeTimer) return;
    this.probeTimer = setInterval(() => {
      const now = Date.now();
      if (!this.router.shouldProbe(now)) return;
      void this.grpc
        .health()
        .then(() => {
          if (this.router.onProbeResult(true, Date.now()) === "promoted") {
            this.log.info("grpc recovered; promoting back", { lastEventSeq: this.lastEventSeq });
            this.stopEventPump();
            this.openStream();
          }
        })
        .catch(() => this.router.onProbeResult(false, Date.now()));
    }, this.probeTickMs);
    this.probeTimer.unref?.();
  }
}
