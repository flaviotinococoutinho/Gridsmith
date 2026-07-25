/**
 * Gateway gRPC do editor — o caminho QUENTE e PRIORITÁRIO do app (ADR-017).
 *
 * Fachada fina: o serviço p7m.editor.v1.EditorHotPath vem de
 * contracts/grpc/p7m_editor.proto (carregado em runtime via proto-loader;
 * cópia em dist/ verificada por teste de paridade) e todo RPC delega na
 * EditorSurface. Eventos saem por SERVER STREAMING com catch-up via
 * EventJournal (`after_seq`) — o cliente nunca perde eventos dentro da
 * janela do ring ao reconectar.
 *
 * Erros: JsonRpcError → status INVALID_ARGUMENT (com o código estável em
 * details); demais → INTERNAL.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { EditorSurface } from "../canonical/EditorSurface.js";
import type { EventJournal, EventEnvelope } from "../transport/EventJournal.js";
import {
  normalizeEndpointListenError,
  prepareTransportEndpoint,
  removeOwnedUnixSocket,
  resolveTransportEndpoint,
  restrictUnixSocketPermissions,
  type TransportEndpoint,
} from "../transport/endpoints.js";
import {
  bearerTokenMatches,
  validateTransportAuthToken,
} from "../transport/auth.js";
import { JsonRpcError } from "../protocol/jsonrpc.js";
import type { Logger } from "../util/log.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * Proto: em dist/ (cópia do build — o que um pacote instala) ou, rodando de
 * src/ via tsx, direto da fonte contracts/ do repositório.
 */
export const PROTO_CANDIDATE_PATHS = [
  path.join(dirname, "../contracts/grpc/p7m_editor.proto"),
  path.join(dirname, "../../../contracts/grpc/p7m_editor.proto"),
] as const;

export function resolveProtoPath(): string {
  const found = PROTO_CANDIDATE_PATHS.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `p7m_editor.proto not found (tried: ${PROTO_CANDIDATE_PATHS.join(", ")}) — run "npm run build"`,
    );
  }
  return found;
}

export interface GrpcGatewayOptions {
  pipeName: string;
  surface: EditorSurface;
  journal: EventJournal;
  log: Logger;
  authToken: string;
}

export function loadEditorProto(protoPath = resolveProtoPath()): grpc.GrpcObject {
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    // uint64 nunca cruza a borda como Number (perda acima de 2^53).
    longs: String,
    defaults: true,
  });
  return grpc.loadPackageDefinition(definition);
}

interface ProjectStatusLike {
  readonly active: boolean;
  readonly projectSessionId?: string;
  readonly projectId?: string;
  readonly commandSequence: string | number | bigint;
  readonly createdAt?: number;
  readonly runtimeState: "synchronized" | "deferred" | "failed";
}

function serializeProjectStatus(status: ProjectStatusLike): Record<string, unknown> {
  return {
    active: status.active,
    project_session_id: status.projectSessionId ?? "",
    project_id: status.projectId ?? "",
    command_sequence: status.commandSequence.toString(),
    created_at_unix_ms: status.createdAt?.toString() ?? "0",
    runtime_state: status.runtimeState,
  };
}

function serializeProjectOperation(result: {
  status: ProjectStatusLike;
  summary?: { applied: number; projected: number; deferred: number; skipped: number };
}): Record<string, unknown> {
  return {
    status: serializeProjectStatus(result.status),
    ...(result.summary ? { summary: result.summary } : {}),
  };
}

function serializeEvent(event: EventEnvelope): {
  seq: string;
  project_session_id: string;
  project_id: string;
  command_sequence: string;
  kind: string;
  payload_json: string;
  has_projection: boolean;
  projection_status: string;
  projection_reason: string;
} {
  return {
    seq: event.seq.toString(),
    project_session_id: event.projectSessionId,
    project_id: event.projectId,
    command_sequence: event.commandSequence.toString(),
    kind: event.kind,
    payload_json: JSON.stringify(event.payload),
    // proto3 não tem campo opcional sem wrapper: has_projection separa
    // "sem projeção" de "projetado".
    has_projection: event.projection !== undefined,
    projection_status: event.projection?.status ?? "",
    projection_reason: event.projection?.reason ?? "",
  };
}

function toGrpcError(err: unknown): grpc.ServiceError {
  if (err instanceof JsonRpcError) {
    const e = new Error(err.message) as grpc.ServiceError;
    e.code = grpc.status.INVALID_ARGUMENT;
    e.details = `${err.message} (code ${err.code})`;
    return e;
  }
  const e = new Error(err instanceof Error ? err.message : String(err)) as grpc.ServiceError;
  e.code = grpc.status.INTERNAL;
  return e;
}

function authenticationError(): grpc.ServiceError {
  const error = new Error("authentication failed") as grpc.ServiceError;
  error.code = grpc.status.UNAUTHENTICATED;
  error.details = "authentication failed";
  return error;
}

export class GrpcGateway {
  private readonly server: grpc.Server;
  readonly endpoint: TransportEndpoint;

  constructor(private readonly options: GrpcGatewayOptions) {
    validateTransportAuthToken(options.authToken);
    this.endpoint = resolveTransportEndpoint(options.pipeName, "grpc");
    this.server = new grpc.Server();

    const pkg = loadEditorProto() as unknown as {
      p7m: { editor: { v1: { EditorHotPath: { service: grpc.ServiceDefinition } } } };
    };
    this.server.addService(pkg.p7m.editor.v1.EditorHotPath.service, {
      Health: this.health,
      Dispatch: this.dispatch,
      Query: this.query,
      Snapshot: this.snapshot,
      ProjectCreate: this.projectCreate,
      ProjectOpenDocument: this.projectOpenDocument,
      ProjectClose: this.projectClose,
      ProjectStatus: this.projectStatus,
      StreamEvents: this.streamEvents,
      StreamEventsV2: this.streamEventsV2,
    });
  }

  async listen(): Promise<void> {
    await prepareTransportEndpoint(this.endpoint);
    try {
      await new Promise<void>((resolve, reject) => {
        this.server.bindAsync(
          this.endpoint.grpcTarget,
          grpc.ServerCredentials.createInsecure(),
          (err) => (err ? reject(err) : resolve()),
        );
      });
      restrictUnixSocketPermissions(this.endpoint);
    } catch (error) {
      throw normalizeEndpointListenError(this.endpoint, error);
    }
    this.options.log.info("grpc gateway listening", { endpoint: this.endpoint.grpcTarget });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.tryShutdown(() => resolve());
    });
    removeOwnedUnixSocket(this.endpoint);
  }

  /** Encerramento abrupto (usado pelo e2e para provar o fallback do cliente). */
  forceShutdown(): void {
    this.server.forceShutdown();
    removeOwnedUnixSocket(this.endpoint);
  }

  private authenticated(call: { metadata: grpc.Metadata }): boolean {
    const values = call.metadata.get("authorization");
    const header = values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
    return bearerTokenMatches(header, this.options.authToken);
  }

  private health: grpc.handleUnaryCall<unknown, unknown> = (call, callback) => {
    if (!this.authenticated(call)) return callback(authenticationError());
    try {
      const status = this.options.surface.projectStatus();
      const position = this.options.journal.position;
      callback(null, {
        ok: true,
        engine_connected: this.options.surface.isEngineConnected,
        middleware_instance_id: position.middlewareInstanceId,
        project_session_id: position.projectSessionId,
        project_id: position.projectId,
        command_sequence: position.commandSequence.toString(),
        first_available_seq: position.firstAvailableSeq.toString(),
        last_event_seq: position.lastEventSeq.toString(),
        project_status: serializeProjectStatus(status),
      });
    } catch (error) {
      callback(toGrpcError(error));
    }
  };

  private dispatch: grpc.handleUnaryCall<
    { kind?: string; payload_json?: string; request_id?: string },
    { event_json: string; projection_json: string }
  > = (call, callback) => {
    if (!this.authenticated(call)) return callback(authenticationError());
    const { kind, payload_json, request_id } = call.request;
    this.options.log.debug("grpc dispatch", { kind });
    void (async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(payload_json ?? "");
      } catch {
        const e = new Error(`"payload_json" must be valid JSON`) as grpc.ServiceError;
        e.code = grpc.status.INVALID_ARGUMENT;
        callback(e);
        return;
      }
      try {
        const result = await this.options.surface.dispatchByKind(
          kind ?? "",
          payload,
          request_id || undefined,
        );
        callback(null, {
          event_json: JSON.stringify(result.event),
          projection_json: result.projection ? JSON.stringify(result.projection) : "",
        });
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  };

  private query: grpc.handleUnaryCall<{ projection?: string }, { result_json: string }> = (
    call,
    callback,
  ) => {
    if (!this.authenticated(call)) return callback(authenticationError());
    try {
      const result = this.options.surface.query(call.request.projection ?? "");
      callback(null, { result_json: JSON.stringify(result) });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  private snapshot: grpc.handleUnaryCall<unknown, unknown> = (call, callback) => {
    if (!this.authenticated(call)) return callback(authenticationError());
    try {
      // As duas leituras são síncronas, portanto formam um ponto coerente no
      // event loop: projeções completas + cursor do último evento nelas contido.
      const snapshot = this.options.surface.snapshot();
      const position = this.options.journal.position;
      callback(null, {
        projections_json: JSON.stringify(snapshot.projections),
        middleware_instance_id: position.middlewareInstanceId,
        project_session_id: position.projectSessionId,
        project_id: position.projectId,
        command_sequence: position.commandSequence.toString(),
        first_available_seq: position.firstAvailableSeq.toString(),
        last_event_seq: position.lastEventSeq.toString(),
        project_status: serializeProjectStatus(snapshot.status),
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  private projectCreate: grpc.handleUnaryCall<
    {
      project_id?: string;
      template_id?: string;
      expected_project_session_id?: string;
    },
    unknown
  > = (call, callback) => {
    if (!this.authenticated(call)) return callback(authenticationError());
    void (async () => {
      try {
        const result = await this.options.surface.projectCreate(
          call.request.project_id || undefined,
          call.request.template_id || undefined,
          call.request.expected_project_session_id || undefined,
        );
        callback(null, serializeProjectOperation(result));
      } catch (err) {
        callback(toGrpcError(err));
      }
    })();
  };

  private projectOpenDocument: grpc.handleUnaryCall<
    { document_json?: string; expected_project_session_id?: string },
    unknown
  > = (call, callback) => {
    if (!this.authenticated(call)) return callback(authenticationError());
    let document: unknown;
    try {
      document = JSON.parse(call.request.document_json ?? "");
    } catch {
      const error = new Error(`"document_json" must be valid JSON`) as grpc.ServiceError;
      error.code = grpc.status.INVALID_ARGUMENT;
      callback(error);
      return;
    }
    void this.options.surface.projectOpenDocument(
      document,
      call.request.expected_project_session_id || undefined,
    ).then(
      (result) => callback(null, serializeProjectOperation(result)),
      (error: unknown) => callback(toGrpcError(error)),
    );
  };

  private projectClose: grpc.handleUnaryCall<
    { expected_project_session_id?: string },
    unknown
  > = (call, callback) => {
    if (!this.authenticated(call)) return callback(authenticationError());
    void this.options.surface.projectClose(
      call.request.expected_project_session_id || undefined,
    ).then(
      (status) => callback(null, serializeProjectStatus(status)),
      (error: unknown) => callback(toGrpcError(error)),
    );
  };

  private projectStatus: grpc.handleUnaryCall<unknown, unknown> = (call, callback) => {
    if (!this.authenticated(call)) return callback(authenticationError());
    try {
      callback(null, serializeProjectStatus(this.options.surface.projectStatus()));
    } catch (error) {
      callback(toGrpcError(error));
    }
  };

  private streamEvents: grpc.handleServerStreamingCall<
    { after_seq?: string | number },
    { seq: string; kind: string; payload_json: string }
  > = (call) => {
    if (!this.authenticated(call)) {
      // Em server-streaming, `destroy(error)` pode fechar o stream sem enviar
      // um status final ao cliente grpc-js. Emitir `error` é a API que termina
      // a chamada com o código tipado e impede consumidores presos.
      call.emit("error", authenticationError());
      return;
    }
    const error = new Error(
      "StreamEvents is unsafe without project_session_id; use StreamEventsV2",
    ) as grpc.ServiceError;
    error.code = grpc.status.FAILED_PRECONDITION;
    error.details = error.message;
    call.emit("error", error);
  };

  private streamEventsV2: grpc.handleServerStreamingCall<
    { middleware_instance_id?: string; project_session_id?: string; after_seq?: string | number },
    {
      status?: {
        middleware_instance_id: string;
        project_session_id: string;
        project_id: string;
        command_sequence: string;
        first_available_seq: string;
        last_event_seq: string;
        resync_required: boolean;
        resync_reason: string;
      };
      event?: {
        seq: string;
        project_session_id: string;
        project_id: string;
        command_sequence: string;
        kind: string;
        payload_json: string;
      };
    }
  > = (call) => {
    if (!this.authenticated(call)) {
      call.emit("error", authenticationError());
      return;
    }
    const result = this.options.journal.readSince(
      call.request.middleware_instance_id,
      call.request.project_session_id,
      call.request.after_seq,
    );
    // Frame de controle obrigatório: o cliente decide antes de aplicar eventos.
    call.write({
      status: {
        middleware_instance_id: result.middlewareInstanceId,
        project_session_id: result.projectSessionId,
        project_id: result.projectId,
        command_sequence: result.commandSequence.toString(),
        first_available_seq: result.firstAvailableSeq.toString(),
        last_event_seq: result.lastEventSeq.toString(),
        resync_required: result.resyncRequired,
        resync_reason: result.resyncReason ?? "",
      },
    });
    if (result.resyncRequired) {
      call.end();
      return;
    }

    let finished = false;
    const finishForPartitionChange = (): void => {
      if (finished) return;
      const position = this.options.journal.position;
      if (position.projectSessionId === result.projectSessionId) return;
      finished = true;
      call.write({
        status: {
          middleware_instance_id: position.middlewareInstanceId,
          project_session_id: position.projectSessionId,
          project_id: position.projectId,
          command_sequence: position.commandSequence.toString(),
          first_available_seq: position.firstAvailableSeq.toString(),
          last_event_seq: position.lastEventSeq.toString(),
          resync_required: true,
          resync_reason: "project_session_changed",
        },
      });
      call.end();
    };
    const write = (envelope: EventEnvelope): void => {
      if (envelope.projectSessionId !== result.projectSessionId) {
        finishForPartitionChange();
        return;
      }
      if (finished) return;
      call.write({ event: serializeEvent(envelope) });
    };
    for (const envelope of result.events) write(envelope);
    const live = (envelope: EventEnvelope): void => write(envelope);
    this.options.journal.on("event", live);
    this.options.journal.on("partitionChanged", finishForPartitionChange);
    const cleanup = (): void => {
      this.options.journal.removeListener("event", live);
      this.options.journal.removeListener("partitionChanged", finishForPartitionChange);
    };
    call.on("cancelled", cleanup);
    call.on("close", cleanup);
    call.on("error", cleanup);
  };
}
