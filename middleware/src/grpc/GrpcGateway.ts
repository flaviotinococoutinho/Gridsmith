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
    const position = this.options.journal.position;
    callback(null, {
      ok: true,
      engine_connected: this.options.surface.isEngineConnected,
      middleware_instance_id: position.middlewareInstanceId,
      first_available_seq: position.firstAvailableSeq.toString(),
      last_event_seq: position.lastEventSeq.toString(),
    });
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
      const projections = this.options.surface.snapshot();
      const position = this.options.journal.position;
      callback(null, {
        projections_json: JSON.stringify(projections),
        middleware_instance_id: position.middlewareInstanceId,
        first_available_seq: position.firstAvailableSeq.toString(),
        last_event_seq: position.lastEventSeq.toString(),
      });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  private streamEvents: grpc.handleServerStreamingCall<
    { after_seq?: string | number },
    { seq: string; kind: string; payload_json: string }
  > = (call) => {
    if (!this.authenticated(call)) {
      call.destroy(authenticationError());
      return;
    }
    const afterSeq = call.request.after_seq ?? 0;
    const write = (e: EventEnvelope): void => {
      call.write({ seq: e.seq.toString(), kind: e.kind, payload_json: JSON.stringify(e.payload) });
    };
    // catch-up dentro da janela do ring, depois ao vivo
    for (const envelope of this.options.journal.since(afterSeq)) write(envelope);
    const live = (envelope: EventEnvelope): void => write(envelope);
    this.options.journal.on("event", live);
    call.on("cancelled", () => this.options.journal.removeListener("event", live));
    call.on("close", () => this.options.journal.removeListener("event", live));
  };

  private streamEventsV2: grpc.handleServerStreamingCall<
    { middleware_instance_id?: string; after_seq?: string | number },
    {
      status?: {
        middleware_instance_id: string;
        first_available_seq: string;
        last_event_seq: string;
        resync_required: boolean;
        resync_reason: string;
      };
      event?: { seq: string; kind: string; payload_json: string };
    }
  > = (call) => {
    if (!this.authenticated(call)) {
      call.destroy(authenticationError());
      return;
    }
    const result = this.options.journal.readSince(
      call.request.middleware_instance_id,
      call.request.after_seq,
    );
    // Frame de controle obrigatório: o cliente decide antes de aplicar eventos.
    call.write({
      status: {
        middleware_instance_id: result.middlewareInstanceId,
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

    const write = (envelope: EventEnvelope): void => {
      call.write({
        event: {
          seq: envelope.seq.toString(),
          kind: envelope.kind,
          payload_json: JSON.stringify(envelope.payload),
        },
      });
    };
    for (const envelope of result.events) write(envelope);
    const live = (envelope: EventEnvelope): void => write(envelope);
    this.options.journal.on("event", live);
    const cleanup = (): void => {
      this.options.journal.removeListener("event", live);
    };
    call.on("cancelled", cleanup);
    call.on("close", cleanup);
    call.on("error", cleanup);
  };
}
