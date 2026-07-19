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
import { resolveTransportEndpoint, type TransportEndpoint } from "../transport/endpoints.js";
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
}

export function loadEditorProto(protoPath = resolveProtoPath()): grpc.GrpcObject {
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: Number,
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

export class GrpcGateway {
  private readonly server: grpc.Server;
  readonly endpoint: TransportEndpoint;

  constructor(private readonly options: GrpcGatewayOptions) {
    this.endpoint = resolveTransportEndpoint(options.pipeName, "grpc");
    this.server = new grpc.Server();

    const pkg = loadEditorProto() as unknown as {
      p7m: { editor: { v1: { EditorHotPath: { service: grpc.ServiceDefinition } } } };
    };
    this.server.addService(pkg.p7m.editor.v1.EditorHotPath.service, {
      Health: this.health,
      Dispatch: this.dispatch,
      Query: this.query,
      StreamEvents: this.streamEvents,
    });
  }

  async listen(): Promise<void> {
    if (this.endpoint.family === "uds" && fs.existsSync(this.endpoint.address)) {
      fs.unlinkSync(this.endpoint.address);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.bindAsync(
        this.endpoint.grpcTarget,
        grpc.ServerCredentials.createInsecure(),
        (err) => (err ? reject(err) : resolve()),
      );
    });
    this.options.log.info("grpc gateway listening", { endpoint: this.endpoint.grpcTarget });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.tryShutdown(() => resolve());
    });
    if (this.endpoint.family === "uds" && fs.existsSync(this.endpoint.address)) {
      fs.unlinkSync(this.endpoint.address);
    }
  }

  /** Encerramento abrupto (usado pelo e2e para provar o fallback do cliente). */
  forceShutdown(): void {
    this.server.forceShutdown();
    if (this.endpoint.family === "uds" && fs.existsSync(this.endpoint.address)) {
      fs.unlinkSync(this.endpoint.address);
    }
  }

  private health: grpc.handleUnaryCall<unknown, unknown> = (_call, callback) => {
    callback(null, {
      ok: true,
      engine_connected: this.options.surface.isEngineConnected,
      last_event_seq: this.options.journal.lastSeq,
    });
  };

  private dispatch: grpc.handleUnaryCall<
    { kind?: string; payload_json?: string },
    { event_json: string; projection_json: string }
  > = (call, callback) => {
    const { kind, payload_json } = call.request;
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
        const result = await this.options.surface.dispatchByKind(kind ?? "", payload);
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
    try {
      const result = this.options.surface.query(call.request.projection ?? "");
      callback(null, { result_json: JSON.stringify(result) });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };

  private streamEvents: grpc.handleServerStreamingCall<
    { after_seq?: number },
    { seq: number; kind: string; payload_json: string }
  > = (call) => {
    const afterSeq = call.request.after_seq ?? 0;
    const write = (e: EventEnvelope): void => {
      call.write({ seq: e.seq, kind: e.kind, payload_json: JSON.stringify(e.payload) });
    };
    // catch-up dentro da janela do ring, depois ao vivo
    for (const envelope of this.options.journal.since(afterSeq)) write(envelope);
    const live = (envelope: EventEnvelope): void => write(envelope);
    this.options.journal.on("event", live);
    call.on("cancelled", () => this.options.journal.removeListener("event", live));
    call.on("close", () => this.options.journal.removeListener("event", live));
  };
}
