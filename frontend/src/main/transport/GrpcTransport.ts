/**
 * Transporte gRPC do caminho quente. Cursores são compostos por instância +
 * sequência decimal; nenhum uint64 cruza a borda como Number.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  resolveTransportEndpoint,
  type TransportEndpoint,
} from "@p7m/middleware/dist/transport/endpoints.js";
import {
  bearerAuthorization,
  loadTransportAuthToken,
} from "@p7m/middleware/dist/transport/auth.js";
import { resolveProtoPath } from "@p7m/middleware/dist/grpc/GrpcGateway.js";
import type { Logger } from "../../core/logging.js";

interface RawJournalStatus {
  middleware_instance_id: string;
  first_available_seq: string;
  last_event_seq: string;
  resync_required: boolean;
  resync_reason: string;
}

interface RawEvent {
  seq: string;
  kind: string;
  payload_json: string;
}

interface HotPathClient extends grpc.Client {
  Health(
    req: object,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (
      err: grpc.ServiceError | null,
      reply: {
        ok: boolean;
        engine_connected: boolean;
        middleware_instance_id: string;
        first_available_seq: string;
        last_event_seq: string;
      },
    ) => void,
  ): void;
  Dispatch(
    req: { kind: string; payload_json: string; request_id: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, reply: { event_json: string; projection_json: string }) => void,
  ): void;
  Query(
    req: { projection: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, reply: { result_json: string }) => void,
  ): void;
  Snapshot(
    req: object,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (
      err: grpc.ServiceError | null,
      reply: {
        projections_json: string;
        middleware_instance_id: string;
        first_available_seq: string;
        last_event_seq: string;
      },
    ) => void,
  ): void;
  StreamEventsV2(
    req: { middleware_instance_id: string; after_seq: string },
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<{ status?: RawJournalStatus; event?: RawEvent }>;
}

export interface HotCursor {
  readonly middlewareInstanceId: string;
  readonly lastEventSeq: string;
}

export interface HotHealth extends HotCursor {
  readonly ok: boolean;
  readonly engineConnected: boolean;
  readonly firstAvailableSeq: string;
}

export interface HotJournalStatus extends HotCursor {
  readonly firstAvailableSeq: string;
  readonly resyncRequired: boolean;
  readonly resyncReason?: string;
}

export interface HotSnapshot extends HotCursor {
  readonly firstAvailableSeq: string;
  readonly projections: Readonly<Record<string, unknown>>;
}

export interface HotEvent {
  readonly seq: string;
  readonly kind: string;
  readonly payload: unknown;
}

export class GrpcTransport {
  readonly endpoint: TransportEndpoint;
  private readonly client: HotPathClient;

  constructor(
    pipeName: string,
    private readonly log: Logger,
    private readonly timeoutMs = 10_000,
    private readonly authToken = loadTransportAuthToken(),
  ) {
    this.endpoint = resolveTransportEndpoint(pipeName, "grpc");
    const definition = protoLoader.loadSync(resolveProtoPath(), {
      keepCase: true,
      longs: String,
      defaults: true,
    });
    const pkg = grpc.loadPackageDefinition(definition) as unknown as {
      p7m: {
        editor: {
          v1: {
            EditorHotPath: new (target: string, credentials: grpc.ChannelCredentials) => HotPathClient;
          };
        };
      };
    };
    this.client = new pkg.p7m.editor.v1.EditorHotPath(
      this.endpoint.grpcTarget,
      grpc.credentials.createInsecure(),
    );
  }

  private deadline(): grpc.CallOptions {
    return { deadline: new Date(Date.now() + this.timeoutMs) };
  }

  private metadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    metadata.set("authorization", bearerAuthorization(this.authToken));
    return metadata;
  }

  health(): Promise<HotHealth> {
    return new Promise((resolve, reject) => {
      this.client.Health({}, this.metadata(), this.deadline(), (err, reply) => {
        if (err) return reject(err);
        resolve({
          ok: reply.ok,
          engineConnected: reply.engine_connected,
          middlewareInstanceId: reply.middleware_instance_id,
          firstAvailableSeq: reply.first_available_seq,
          lastEventSeq: reply.last_event_seq,
        });
      });
    });
  }

  dispatch(
    kind: string,
    payload: unknown,
    requestId: string,
  ): Promise<{ event: unknown; projection?: unknown }> {
    this.log.trace("grpc dispatch", { kind });
    return new Promise((resolve, reject) => {
      this.client.Dispatch(
        { kind, payload_json: JSON.stringify(payload), request_id: requestId },
        this.metadata(),
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
      this.client.Query({ projection }, this.metadata(), this.deadline(), (err, reply) => {
        if (err) return reject(err);
        resolve(JSON.parse(reply.result_json));
      });
    });
  }

  snapshot(): Promise<HotSnapshot> {
    return new Promise((resolve, reject) => {
      this.client.Snapshot({}, this.metadata(), this.deadline(), (err, reply) => {
        if (err) return reject(err);
        resolve({
          projections: JSON.parse(reply.projections_json) as Record<string, unknown>,
          middlewareInstanceId: reply.middleware_instance_id,
          firstAvailableSeq: reply.first_available_seq,
          lastEventSeq: reply.last_event_seq,
        });
      });
    });
  }

  /** Abre o stream v2; o servidor sempre envia status antes de eventos. */
  streamEvents(
    cursor: HotCursor,
    onStatus: (status: HotJournalStatus) => void,
    onEvent: (event: HotEvent) => void,
    onError: (err: unknown) => void,
  ): () => void {
    const stream = this.client.StreamEventsV2(
      {
        middleware_instance_id: cursor.middlewareInstanceId,
        after_seq: cursor.lastEventSeq,
      },
      this.metadata(),
    );
    let cancelled = false;
    let statusSeen = false;
    stream.on("data", (frame) => {
      if (frame.status) {
        statusSeen = true;
        onStatus({
          middlewareInstanceId: frame.status.middleware_instance_id,
          firstAvailableSeq: frame.status.first_available_seq,
          lastEventSeq: frame.status.last_event_seq,
          resyncRequired: frame.status.resync_required,
          ...(frame.status.resync_reason ? { resyncReason: frame.status.resync_reason } : {}),
        });
        return;
      }
      if (!frame.event) return;
      if (!statusSeen) {
        onError(new Error("gRPC event stream emitted data before cursor status"));
        return;
      }
      onEvent({
        seq: frame.event.seq,
        kind: frame.event.kind,
        payload: JSON.parse(frame.event.payload_json),
      });
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
