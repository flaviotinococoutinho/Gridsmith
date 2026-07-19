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
} from "@p7m/middleware/dist/transport/endpoints.js";
import {
  bearerAuthorization,
  loadTransportAuthToken,
} from "@p7m/middleware/dist/transport/auth.js";
import { resolveProtoPath } from "@p7m/middleware/dist/grpc/GrpcGateway.js";
import type { Logger } from "../../core/logging.js";
import type {
  DispatchOutcome,
  HistoryEntryPayload,
  HistoryOperationResult,
  HistoryStatusPayload,
} from "../../core/editorCommands.js";

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
  transaction_id: string;
  document_state_id: string;
  history_entry_id: string;
  actor: "human" | "agent" | "pipeline" | "";
  history_cursor: string;
  history_action: "apply" | "undo" | "redo" | "";
  payload_json: string;
}

interface RawHistoryEntry {
  id: string;
  label: string;
  forward_json: string[];
  inverse_json: string[];
  actor: "human" | "agent" | "pipeline";
  transaction_id: string;
  timestamp_unix_ms: string;
  barrier: boolean;
  applied: boolean;
}

interface RawHistoryStatus {
  project_session_id: string;
  project_id: string;
  can_undo: boolean;
  can_redo: boolean;
  undo_label: string;
  redo_label: string;
  document_state_id: string;
  history_cursor: string;
  command_sequence: string;
  entries: RawHistoryEntry[];
}

interface RawProjectStatus {
  active: boolean;
  project_session_id: string;
  project_id: string;
  command_sequence: string;
  created_at_unix_ms: string;
  runtime_state: string;
  document_state_id: string;
  history_cursor: string;
  can_undo: boolean;
  can_redo: boolean;
}

interface RawHistoryOperation {
  status: RawProjectStatus;
  history: RawHistoryStatus;
  entry: RawHistoryEntry;
  events_json: string[];
  command_sequence: string;
  transaction_id: string;
  document_state_id: string;
  history_cursor: string;
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
        document_state_id: string;
        history_cursor: string;
      },
    ) => void,
  ): void;
  Dispatch(
    req: { kind: string; payload_json: string; request_id: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, reply: {
      event_json: string;
      projection_json: string;
      command_sequence: string;
      transaction_id: string;
      document_state_id: string;
      history_cursor: string;
      history_entry?: RawHistoryEntry;
    }) => void,
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
        document_state_id: string;
        history_cursor: string;
      },
    ) => void,
  ): void;
  Undo(
    req: { request_id: string; expected_project_session_id: string; history_cursor: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, reply: RawHistoryOperation) => void,
  ): void;
  Redo(
    req: { request_id: string; expected_project_session_id: string; history_cursor: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, reply: RawHistoryOperation) => void,
  ): void;
  HistoryStatus(
    req: { limit: number },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (err: grpc.ServiceError | null, reply: RawHistoryStatus) => void,
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
  readonly documentStateId: string;
  readonly historyCursor: string;
}

export interface HotJournalStatus extends HotCursor {
  readonly firstAvailableSeq: string;
  readonly resyncRequired: boolean;
  readonly resyncReason?: string;
}

export interface HotSnapshot extends HotCursor {
  readonly firstAvailableSeq: string;
  readonly documentStateId: string;
  readonly historyCursor: string;
  readonly projections: Readonly<Record<string, unknown>>;
}

export interface HotEvent {
  readonly seq: string;
  readonly kind: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
  readonly transactionId?: string;
  readonly documentStateId?: string;
  readonly historyEntryId?: string;
  readonly actor?: "human" | "agent" | "pipeline";
  readonly historyCursor?: string;
  readonly historyAction?: "apply" | "undo" | "redo";
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
          projectSessionId: reply.project_session_id,
          projectId: reply.project_id,
          commandSequence: reply.command_sequence,
          firstAvailableSeq: reply.first_available_seq,
          lastEventSeq: reply.last_event_seq,
          documentStateId: reply.document_state_id,
          historyCursor: reply.history_cursor,
        });
      });
    });
  }

  dispatch(
    kind: string,
    payload: unknown,
    requestId: string,
  ): Promise<DispatchOutcome> {
    this.log.trace("grpc dispatch", { kind });
    return new Promise((resolve, reject) => {
      this.client.Dispatch(
        { kind, payload_json: JSON.stringify(payload), request_id: requestId },
        this.metadata(),
        this.deadline(),
        (err, reply) => {
          if (err) return reject(err);
          const projection = reply.projection_json
            ? JSON.parse(reply.projection_json) as NonNullable<DispatchOutcome["projection"]>
            : undefined;
          resolve({
            event: JSON.parse(reply.event_json) as DispatchOutcome["event"],
            ...(projection ? { projection } : {}),
            documentStateId: reply.document_state_id,
            historyCursor: reply.history_cursor,
            ...(reply.history_entry?.id
              ? { historyEntry: historyEntry(reply.history_entry, false) }
              : {}),
          });
        },
      );
    });
  }

  undo(
    requestId: string,
    expectedProjectSessionId: string,
    historyCursor: string,
  ): Promise<HistoryOperationResult> {
    return this.historyMutation("Undo", requestId, expectedProjectSessionId, historyCursor);
  }

  redo(
    requestId: string,
    expectedProjectSessionId: string,
    historyCursor: string,
  ): Promise<HistoryOperationResult> {
    return this.historyMutation("Redo", requestId, expectedProjectSessionId, historyCursor);
  }

  historyStatus(limit = 100): Promise<HistoryStatusPayload> {
    return new Promise((resolve, reject) => {
      this.client.HistoryStatus({ limit }, this.metadata(), this.deadline(), (err, reply) => {
        if (err) return reject(err);
        resolve(historyStatus(reply));
      });
    });
  }

  private historyMutation(
    method: "Undo" | "Redo",
    requestId: string,
    expectedProjectSessionId: string,
    cursor: string,
  ): Promise<HistoryOperationResult> {
    return new Promise((resolve, reject) => {
      this.client[method](
        {
          request_id: requestId,
          expected_project_session_id: expectedProjectSessionId,
          history_cursor: cursor,
        },
        this.metadata(),
        this.deadline(),
        (err, reply) => {
          if (err) return reject(err);
          resolve({
            status: projectStatus(reply.status),
            history: historyStatus(reply.history),
            entry: historyEntry(reply.entry, false),
            events: reply.events_json.map((event) => JSON.parse(event) as HistoryOperationResult["events"][number]),
            commandSequence: reply.command_sequence,
            transactionId: reply.transaction_id,
            documentStateId: reply.document_state_id,
            historyCursor: reply.history_cursor,
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
          documentStateId: reply.document_state_id,
          historyCursor: reply.history_cursor,
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
      onEvent({
        seq: frame.event.seq,
        kind: frame.event.kind,
        projectSessionId: frame.event.project_session_id,
        projectId: frame.event.project_id,
        commandSequence: frame.event.command_sequence,
        ...(frame.event.transaction_id ? { transactionId: frame.event.transaction_id } : {}),
        ...(frame.event.document_state_id ? { documentStateId: frame.event.document_state_id } : {}),
        ...(frame.event.history_entry_id ? { historyEntryId: frame.event.history_entry_id } : {}),
        ...(frame.event.actor ? { actor: frame.event.actor } : {}),
        ...(frame.event.history_cursor ? { historyCursor: frame.event.history_cursor } : {}),
        ...(frame.event.history_action ? { historyAction: frame.event.history_action } : {}),
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

function historyEntry(raw: RawHistoryEntry, summary: boolean): HistoryEntryPayload {
  return {
    id: raw.id,
    label: raw.label,
    actor: raw.actor,
    transactionId: raw.transaction_id,
    timestamp: raw.timestamp_unix_ms,
    barrier: raw.barrier,
    ...(summary ? { applied: raw.applied } : {}),
    ...(!summary
      ? {
          forward: raw.forward_json.map((value) => JSON.parse(value) as unknown),
          inverse: raw.inverse_json.map((value) => JSON.parse(value) as unknown),
        }
      : {}),
  };
}

function historyStatus(raw: RawHistoryStatus): HistoryStatusPayload {
  return {
    projectSessionId: raw.project_session_id,
    projectId: raw.project_id,
    commandSequence: raw.command_sequence,
    documentStateId: raw.document_state_id,
    historyCursor: raw.history_cursor,
    canUndo: raw.can_undo,
    canRedo: raw.can_redo,
    ...(raw.undo_label ? { undoLabel: raw.undo_label } : {}),
    ...(raw.redo_label ? { redoLabel: raw.redo_label } : {}),
    entries: raw.entries.map((entry) => historyEntry(entry, true)),
  };
}

function projectStatus(raw: RawProjectStatus): HistoryOperationResult["status"] {
  return {
    active: raw.active,
    ...(raw.project_session_id ? { projectSessionId: raw.project_session_id } : {}),
    ...(raw.project_id ? { projectId: raw.project_id } : {}),
    commandSequence: raw.command_sequence,
    documentStateId: raw.document_state_id,
    historyCursor: raw.history_cursor,
    canUndo: raw.can_undo,
    canRedo: raw.can_redo,
  };
}
