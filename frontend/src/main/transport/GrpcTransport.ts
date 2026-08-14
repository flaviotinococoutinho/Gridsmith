/**
 * Transporte gRPC do caminho quente. Cursores são compostos por instância do
 * middleware + sessão de projeto + sequência decimal; nenhum uint64 cruza a
 * borda como Number e um cursor de A nunca pode consumir eventos de B.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  resolveTransportEndpoint,
  type TransportEndpoint,
} from "@gridsmith/middleware/dist/transport/endpoints.js";
import {
  bearerAuthorization,
  loadTransportAuthToken,
} from "@gridsmith/middleware/dist/transport/auth.js";
import { resolveProtoPath } from "@gridsmith/middleware/dist/grpc/GrpcGateway.js";
import type { Logger } from "../../core/logging.js";

interface RawJournalStatus {
  middleware_instance_id: string;
  project_session_id: string;
  project_id: string;
  command_sequence: string;
  first_available_seq: string;
  last_event_seq: string;
  resync_required: boolean;
  resync_reason: string;
}

interface RawEvent {
  seq: string;
  kind: string;
  project_session_id: string;
  project_id: string;
  command_sequence: string;
  payload_json: string;
  has_projection?: boolean;
  projection_status?: string;
  projection_reason?: string;
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
        project_session_id: string;
        project_id: string;
        command_sequence: string;
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
        project_session_id: string;
        project_id: string;
        command_sequence: string;
        first_available_seq: string;
        last_event_seq: string;
      },
    ) => void,
  ): void;
  StreamEventsV2(
    req: { middleware_instance_id: string; project_session_id: string; after_seq: string },
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<{ status?: RawJournalStatus; event?: RawEvent }>;
}

export interface HotCursor {
  readonly middlewareInstanceId: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
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

export interface EventProjection {
  readonly status: string;
  readonly reason?: string;
}

export interface HotEvent {
  readonly seq: string;
  readonly kind: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
  readonly payload: unknown;
  /** Ausente em eventos de controle e quando não há adapter de runtime. */
  readonly projection?: EventProjection;
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
      gridsmith: {
        editor: {
          v1: {
            EditorHotPath: new (target: string, credentials: grpc.ChannelCredentials) => HotPathClient;
          };
        };
      };
    };
    this.client = new pkg.gridsmith.editor.v1.EditorHotPath(
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
          projectSessionId: reply.project_session_id,
          projectId: reply.project_id,
          commandSequence: reply.command_sequence,
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
          projectSessionId: reply.project_session_id,
          projectId: reply.project_id,
          commandSequence: reply.command_sequence,
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
        project_session_id: cursor.projectSessionId,
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
          projectSessionId: frame.status.project_session_id,
          projectId: frame.status.project_id,
          commandSequence: frame.status.command_sequence,
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
      const raw = frame.event;
      onEvent({
        seq: raw.seq,
        kind: raw.kind,
        projectSessionId: raw.project_session_id,
        projectId: raw.project_id,
        commandSequence: raw.command_sequence,
        payload: JSON.parse(raw.payload_json),
        ...(raw.has_projection
          ? {
              projection: {
                status: raw.projection_status ?? "",
                ...(raw.projection_reason ? { reason: raw.projection_reason } : {}),
              },
            }
          : {}),
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
