/**
 * Transporte gRPC do app — o caminho QUENTE e prioritário (ADR-017):
 * dispatch/query unários com deadline e STREAM de eventos com catch-up por
 * seq. O contrato (proto) e o endpoint vêm do pacote do middleware — uma
 * única fonte, zero duplicação. Sem Electron aqui.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  resolveTransportEndpoint,
  type TransportEndpoint,
} from "@p7m/middleware/dist/transport/endpoints.js";
import { resolveProtoPath } from "@p7m/middleware/dist/grpc/GrpcGateway.js";
import type { Logger } from "../../core/logging.js";

interface HotPathClient extends grpc.Client {
  Health(
    req: object,
    options: grpc.CallOptions,
    cb: (
      err: grpc.ServiceError | null,
      reply: { ok: boolean; engine_connected: boolean; last_event_seq: number },
    ) => void,
  ): void;
  Dispatch(
    req: { kind: string; payload_json: string },
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, reply: { event_json: string; projection_json: string }) => void,
  ): void;
  Query(
    req: { projection: string },
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, reply: { result_json: string }) => void,
  ): void;
  StreamEvents(req: { after_seq: number }): grpc.ClientReadableStream<{
    seq: number;
    kind: string;
    payload_json: string;
  }>;
}

export interface HotHealth {
  ok: boolean;
  engineConnected: boolean;
  lastEventSeq: number;
}

export interface HotEvent {
  seq: number;
  kind: string;
  payload: unknown;
}

export class GrpcTransport {
  readonly endpoint: TransportEndpoint;
  private readonly client: HotPathClient;

  constructor(
    pipeName: string,
    private readonly log: Logger,
    private readonly timeoutMs = 10_000,
  ) {
    this.endpoint = resolveTransportEndpoint(pipeName, "grpc");
    const definition = protoLoader.loadSync(resolveProtoPath(), {
      keepCase: true,
      longs: Number,
      defaults: true,
    });
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      p7m: { editor: { v1: { EditorHotPath: new (t: string, c: grpc.ChannelCredentials) => HotPathClient } } };
    };
    this.client = new pkg.p7m.editor.v1.EditorHotPath(
      this.endpoint.grpcTarget,
      grpc.credentials.createInsecure(),
    );
  }

  private deadline(): grpc.CallOptions {
    return { deadline: new Date(Date.now() + this.timeoutMs) };
  }

  health(): Promise<HotHealth> {
    return new Promise((resolve, reject) => {
      this.client.Health({}, this.deadline(), (err, reply) => {
        if (err) return reject(err);
        resolve({
          ok: reply.ok,
          engineConnected: reply.engine_connected,
          lastEventSeq: reply.last_event_seq,
        });
      });
    });
  }

  dispatch(kind: string, payload: unknown): Promise<{ event: unknown; projection?: unknown }> {
    this.log.trace("grpc dispatch", { kind });
    return new Promise((resolve, reject) => {
      this.client.Dispatch(
        { kind, payload_json: JSON.stringify(payload) },
        this.deadline(),
        (err, reply) => {
          if (err) return reject(err);
          resolve({
            event: JSON.parse(reply.event_json),
            ...(reply.projection_json ? { projection: JSON.parse(reply.projection_json) } : {}),
          });
        },
      );
    });
  }

  query(projection: string): Promise<unknown> {
    this.log.trace("grpc query", { projection });
    return new Promise((resolve, reject) => {
      this.client.Query({ projection }, this.deadline(), (err, reply) => {
        if (err) return reject(err);
        resolve(JSON.parse(reply.result_json));
      });
    });
  }

  /**
   * Abre o stream de eventos a partir de `afterSeq` (catch-up + ao vivo).
   * `onError` recebe o erro terminal do stream (para o router decidir o
   * fallback); cancelamentos locais não chamam `onError`.
   */
  streamEvents(
    afterSeq: number,
    onEvent: (event: HotEvent) => void,
    onError: (err: unknown) => void,
  ): () => void {
    const stream = this.client.StreamEvents({ after_seq: afterSeq });
    let cancelled = false;
    stream.on("data", (raw) => {
      onEvent({ seq: raw.seq, kind: raw.kind, payload: JSON.parse(raw.payload_json) });
    });
    stream.on("error", (err: grpc.ServiceError) => {
      if (cancelled || err.code === grpc.status.CANCELLED) return;
      onError(err);
    });
    return () => {
      cancelled = true;
      stream.cancel();
    };
  }

  close(): void {
    this.client.close();
  }
}
