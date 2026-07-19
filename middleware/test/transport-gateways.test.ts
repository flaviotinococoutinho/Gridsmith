/**
 * Integração dos transports do app (ADR-016/017): sobe os gateways GraphQL e
 * gRPC REAIS sobre UDS, com a EditorSurface sobre um orquestrador de verdade
 * (sem engine → projeção deferred), e prova:
 *  - paridade de superfície entre os transports (dispatch/query/experience);
 *  - eventos: catch-up + ao vivo no stream gRPC e polling incremental no
 *    GraphQL (eventsSince), lendo o MESMO EventJournal;
 *  - paridade dos contratos: SDL/proto copiados == contracts/ (fonte) e
 *    enum GraphQL == COMMAND_KINDS;
 *  - erros com código estável cruzando os dois transports.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EditorSurface } from "../src/canonical/EditorSurface.js";
import {
  ProjectSessionManager,
  type ProjectSessionChangedEvent,
  type SessionBlueprintEvent,
} from "../src/canonical/ProjectSessionManager.js";
import { COMMAND_KINDS } from "../src/canonical/commandShape.js";
import { HookBus } from "../src/canonical/HookBus.js";
import type { BlueprintStore } from "../src/domain/BlueprintStore.js";
import { GraphQlGateway, resolveSdlPath, graphqlKindToCanonical } from "../src/graphql/GraphQlGateway.js";
import { GrpcGateway, resolveProtoPath, loadEditorProto } from "../src/grpc/GrpcGateway.js";
import { EditorGateway } from "../src/ipc/EditorGateway.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { createMcpServer } from "../src/mcp/McpFacade.js";
import {
  JsonRpcError,
  PROTOCOL_VERSION,
  RpcErrorCode,
} from "../src/protocol/jsonrpc.js";
import { EventJournal } from "../src/transport/EventJournal.js";
import {
  bearerAuthorization,
  generateTransportAuthToken,
} from "../src/transport/auth.js";
import { ExperienceGovernor } from "../src/runtime/ExperienceGovernor.js";
import { RuntimeProfileRegistry } from "../src/runtime/RuntimeProfile.js";
import { MONOGAME_PROFILES } from "../src/runtime/profiles/monogame.js";
import type { RuntimeAdapter } from "../src/runtime/RuntimeAdapter.js";
import { createLogger } from "../src/util/log.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function offlineAdapter(): RuntimeAdapter {
  return {
    family: "monogame",
    isConnected: false,
    identify: () => undefined,
    project: async (event) => ({
      event: event.kind,
      status: "deferred",
      reason: "no engine session connected",
    }),
    resetSession: async () => ({
      status: "deferred",
      runtimeSessionEpoch: 0,
      reason: "no engine session connected",
    }),
    rehydrateFrom: async () => [],
  };
}

interface Rig {
  surface: EditorSurface;
  journal: EventJournal;
  store: BlueprintStore;
  sessions: ProjectSessionManager;
}

async function makeRig(capacity = 512, middlewareInstanceId = "middleware-test"): Promise<Rig> {
  const hooks = new HookBus();
  const adapter = offlineAdapter();
  const sessions = new ProjectSessionManager({ hooks, adapter });
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const governor = new ExperienceGovernor(profiles);
  const surface = new EditorSurface({ sessions, governor, adapter });
  const journal = new EventJournal(capacity, middlewareInstanceId);
  await sessions.activate(sessions.createEmptySession("transport-test-project"));
  const status = sessions.status;
  journal.activateSession(status.projectSessionId!, status.projectId!, status.commandSequence);
  sessions.on("event", (event: SessionBlueprintEvent) => {
    journal.appendForSession(
      event.projectSessionId,
      event.projectId,
      event.commandSequence,
      event.kind,
      event,
    );
  });
  sessions.on("sessionChanged", (event: ProjectSessionChangedEvent) => {
    if (event.action === "activated") {
      journal.activateSession(event.projectSessionId!, event.projectId!, event.commandSequence);
      journal.appendForSession(
        event.projectSessionId!,
        event.projectId!,
        event.commandSequence,
        event.kind,
        event,
      );
      return;
    }
    const previous = journal.position;
    journal.appendForSession(
      previous.projectSessionId,
      previous.projectId,
      previous.commandSequence,
      event.kind,
      event,
    );
    journal.deactivateSession();
  });
  return { surface, journal, store: sessions.current!.store, sessions };
}

const silent = createLogger("test", { level: "silent" });
const AUTH_TOKEN = generateTransportAuthToken();
let pipeCounter = 0;

function graphqlRequest(
  socketPath: string,
  query: string,
  variables?: Record<string, unknown>,
  authToken = AUTH_TOKEN,
): Promise<{
  statusCode: number;
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; extensions?: { code?: number } }>;
}> {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/graphql",
        method: "POST",
        headers: {
          authorization: bearerAuthorization(authToken),
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({
          statusCode: res.statusCode ?? 0,
          ...JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

interface HotPathClient {
  Health(
    req: object,
    cb: (
      err: grpc.ServiceError | null,
      reply: {
        ok: boolean;
        middleware_instance_id: string;
        project_session_id: string;
        project_id: string;
        first_available_seq: string;
        last_event_seq: string;
      },
    ) => void,
  ): void;
  Dispatch(
    req: { kind: string; payload_json: string; request_id?: string },
    cb: (err: grpc.ServiceError | null, reply: {
      event_json: string;
      projection_json: string;
      command_sequence: string;
      transaction_id: string;
      document_state_id: string;
      history_cursor: string;
      history_entry_id: string;
      history_entry: Record<string, unknown>;
    }) => void,
  ): void;
  Query(req: { projection: string }, cb: (err: grpc.ServiceError | null, reply: { result_json: string }) => void): void;
  Snapshot(
    req: object,
    cb: (
      err: grpc.ServiceError | null,
      reply: {
        projections_json: string;
        middleware_instance_id: string;
        project_session_id: string;
        project_id: string;
        first_available_seq: string;
        last_event_seq: string;
      },
    ) => void,
  ): void;
  StreamEvents(req: { after_seq: number }): { on(ev: string, fn: (arg: unknown) => void): void; cancel(): void };
  StreamEventsV2(req: {
    middleware_instance_id: string;
    project_session_id: string;
    after_seq: string;
  }): { on(ev: string, fn: (arg: unknown) => void): void; cancel(): void };
  ProjectCreate(
    req: {
      project_id?: string;
      template_id?: string;
      expected_project_session_id?: string;
      expected_command_sequence?: string;
    },
    cb: (err: grpc.ServiceError | null, reply: Record<string, unknown>) => void,
  ): void;
  ProjectOpenDocument(
    req: {
      document_json: string;
      expected_project_session_id?: string;
      expected_command_sequence?: string;
    },
    cb: (err: grpc.ServiceError | null, reply: Record<string, unknown>) => void,
  ): void;
  ProjectClose(
    req: { expected_project_session_id?: string; expected_command_sequence?: string },
    cb: (err: grpc.ServiceError | null, reply: Record<string, unknown>) => void,
  ): void;
  ProjectStatus(
    req: object,
    cb: (err: grpc.ServiceError | null, reply: Record<string, unknown>) => void,
  ): void;
  HistoryStatus(
    req: { limit?: number },
    cb: (err: grpc.ServiceError | null, reply: Record<string, unknown>) => void,
  ): void;
  Undo(
    req: {
      request_id?: string;
      expected_project_session_id?: string;
      history_cursor?: string;
    },
    cb: (err: grpc.ServiceError | null, reply: Record<string, unknown>) => void,
  ): void;
  Redo(
    req: {
      request_id?: string;
      expected_project_session_id?: string;
      history_cursor?: string;
    },
    cb: (err: grpc.ServiceError | null, reply: Record<string, unknown>) => void,
  ): void;
  close(): void;
}

function grpcClient(target: string): HotPathClient {
  const pkg = loadEditorProto() as unknown as {
    p7m: { editor: { v1: { EditorHotPath: new (t: string, c: grpc.ChannelCredentials) => HotPathClient } } };
  };
  const raw = new pkg.p7m.editor.v1.EditorHotPath(target, grpc.credentials.createInsecure());
  const authenticatedMethods = new Set([
    "Health", "Dispatch", "Query", "Snapshot", "StreamEvents", "StreamEventsV2",
    "ProjectCreate", "ProjectOpenDocument", "ProjectClose", "ProjectStatus",
    "HistoryStatus", "Undo", "Redo",
  ]);
  return new Proxy(raw as object, {
    get(targetClient, property, receiver) {
      const value = Reflect.get(targetClient, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (!authenticatedMethods.has(String(property))) return value.bind(targetClient);
      return (...args: unknown[]) => {
        const metadata = new grpc.Metadata();
        metadata.set("authorization", bearerAuthorization(AUTH_TOKEN));
        return Reflect.apply(value, targetClient, [args[0], metadata, ...args.slice(1)]);
      };
    },
  }) as HotPathClient;
}

const LIGHT = { lightId: "sun", type: "point", position: [0, 0], color: [1, 1, 1], intensity: 1, radius: 64 };

test("paridade de contrato: cópias em dist/ idênticas à fonte em contracts/ e enum == COMMAND_KINDS", () => {
  const sdlSource = fs.readFileSync(path.join(REPO, "contracts/graphql/editor.schema.graphql"), "utf8");
  const sdlDist = fs.readFileSync(
    path.join(REPO, "middleware/dist/contracts/graphql/editor.schema.graphql"),
    "utf8",
  );
  assert.equal(sdlDist, sdlSource, "dist SDL must be byte-identical to contracts/ (run npm run build)");

  const protoSource = fs.readFileSync(path.join(REPO, "contracts/grpc/p7m_editor.proto"), "utf8");
  const protoDist = fs.readFileSync(
    path.join(REPO, "middleware/dist/contracts/grpc/p7m_editor.proto"),
    "utf8",
  );
  assert.equal(protoDist, protoSource, "dist proto must be byte-identical to contracts/");
  // resolução em runtime encontra ALGUM contrato nos dois modos (src via tsx / dist)
  assert.ok(fs.existsSync(resolveSdlPath()));
  assert.ok(fs.existsSync(resolveProtoPath()));

  // enum CommandKind do SDL (com _) espelha COMMAND_KINDS (com /)
  const enumBlock = /enum CommandKind \{([^}]+)\}/.exec(sdlSource)?.[1] ?? "";
  const enumValues = enumBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith('"'));
  assert.deepEqual(
    enumValues.map(graphqlKindToCanonical).sort(),
    [...COMMAND_KINDS].sort(),
    "GraphQL CommandKind enum must mirror COMMAND_KINDS",
  );
});

test("EditorSurface: snapshot completo e requestId impedem dispatch duplicado", async () => {
  const rig = await makeRig(8, "middleware-pure");
  const payload = { entityDefId: "coin", fields: [{ name: "value", type: "int", default: 1 }] };

  const first = rig.surface.dispatchByKind("entitydef/define", payload, "request-1");
  const concurrentRetry = rig.surface.dispatchByKind("entitydef/define", payload, "request-1");
  const [firstResult, retryResult] = await Promise.all([first, concurrentRetry]);
  assert.equal(firstResult, retryResult);
  assert.equal(rig.journal.lastSeq, 1n);

  const completedRetry = await rig.surface.dispatchByKind("entitydef/define", payload, "request-1");
  assert.equal(completedRetry, firstResult);
  assert.equal(rig.journal.lastSeq, 1n);
  await assert.rejects(
    rig.surface.dispatchByKind(
      "entitydef/define",
      { ...payload, entityDefId: "other" },
      "request-1",
    ),
    /different command/,
  );

  const snapshot = rig.surface.snapshot();
  assert.deepEqual(Object.keys(snapshot.projections).sort(),
    ["camera", "document", "entities", "entityDefs", "levels", "lights", "meshes", "skeletons", "world"].sort());
  assert.equal(
    (snapshot.projections.entityDefs["entityDefs"] as Array<{ entityDefId: string }>)[0]?.entityDefId,
    "coin",
  );
  assert.equal(snapshot.status.projectSessionId, rig.sessions.current?.sessionId);

  const sessionA = rig.sessions.current!.sessionId;
  await rig.sessions.replaceAtomically(
    rig.sessions.createEmptySession("transport-test-project-b"),
    sessionA,
  );
  await assert.rejects(
    rig.surface.dispatchByKind("entitydef/define", payload, "request-1"),
    (error: unknown) => {
      assert.ok(error instanceof JsonRpcError);
      assert.equal(error.code, RpcErrorCode.ProjectSessionConflict);
      assert.match(error.message, /belongs to project session.*active session/);
      return true;
    },
  );
  assert.deepEqual(
    rig.sessions.current!.store.listEntityDefs(),
    [],
    "a retry from session A must never be applied to session B",
  );
  assert.equal(rig.sessions.current!.history.lastSequence, 0n);
});

test("EditorSurface: materialização exige identidade e opções completas", async () => {
  const { surface } = await makeRig();

  assert.throws(
    () => surface.materializeProjectTemplate("platformer-2d", {}),
    /projectId must be non-empty/,
  );
  const document = surface.materializeProjectTemplate("platformer-2d", {
    projectId: "materialized-once",
    name: "Materializado",
    referenceResolution: { width: 1280, height: 720 },
    tileSize: 16,
  }) as { projectId: string; metadata: { name: string } };
  assert.equal(document.projectId, "materialized-once");
  assert.equal(document.metadata.name, "Materializado");
});

test("histórico global: historyStatus respeita a barreira de transição da sessão", async () => {
  let blockReset = false;
  let announceReset!: () => void;
  let releaseReset!: () => void;
  const resetEntered = new Promise<void>((resolve) => { announceReset = resolve; });
  const resetReleased = new Promise<void>((resolve) => { releaseReset = resolve; });
  const adapter: RuntimeAdapter = {
    ...offlineAdapter(),
    resetSession: async () => {
      if (blockReset) {
        announceReset();
        await resetReleased;
      }
      return {
        status: "deferred",
        runtimeSessionEpoch: 0,
        reason: "no engine session connected",
      };
    },
  };
  const sessions = new ProjectSessionManager({ hooks: new HookBus(), adapter });
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const surface = new EditorSurface({
    sessions,
    governor: new ExperienceGovernor(profiles),
    adapter,
  });
  await sessions.activate(sessions.createEmptySession("history-a"));
  const sessionA = sessions.current!.sessionId;
  blockReset = true;
  const replacing = sessions.replaceAtomically(
    sessions.createEmptySession("history-b"),
    sessionA,
  );
  await resetEntered;
  assert.throws(
    () => surface.historyStatus(0),
    /transition is in progress/,
    "cursor de B não pode aparecer antes do commit do runtime",
  );
  releaseReset();
  await replacing;
  assert.equal(surface.historyStatus(0).projectId, "history-b");
});

test("histórico global: retry idempotente de undo não move o cursor duas vezes", async () => {
  const rig = await makeRig();
  await rig.surface.dispatchByKind("camera/configure", {
    frequency: 3,
    transactionId: "camera-gesture",
    metadata: { actor: "agent", label: "Alterar câmera" },
  }, "camera-dispatch", "human");
  const before = rig.surface.historyStatus(0);
  const options = {
    requestId: "surface-undo-retry",
    expectedProjectSessionId: before.projectSessionId,
    historyCursor: before.historyCursor,
  };
  const first = rig.surface.historyUndo(options, "human");
  const concurrentRetry = rig.surface.historyUndo(options, "human");
  const [firstAck, retryAck] = await Promise.all([first, concurrentRetry]);
  assert.equal(firstAck, retryAck);
  assert.deepEqual(rig.store.cameraSettings, {});
  assert.equal(firstAck.history.canRedo, true);
  assert.equal(firstAck.events[0]?.historyAction, "undo");

  const completedRetry = await rig.surface.historyUndo(options, "human");
  assert.equal(completedRetry, firstAck);
  assert.deepEqual(rig.store.cameraSettings, {});
  assert.equal(rig.journal.lastSeq, 2n, "apply + um único undo");
  await assert.rejects(
    rig.surface.historyRedo({ ...options }, "human"),
    /different command/,
    "o mesmo requestId não pode ser reutilizado para a operação oposta",
  );
});

test("GraphQL: dispatch/query/eventBatch/templates/experience na mesma superfície canônica", async () => {
  const { surface, journal } = await makeRig();
  const gateway = new GraphQlGateway({
    pipeName: `p7m-gql-${process.pid}-${pipeCounter++}`,
    surface,
    journal,
    log: silent,
    authToken: AUTH_TOKEN,
  });
  await gateway.listen();
  try {
    const socketPath = gateway.endpoint.address;

    const health = await graphqlRequest(
      socketPath,
      "{ health { ok engineConnected middlewareInstanceId firstAvailableSeq lastEventSeq } }",
    );
    assert.deepEqual(health.data?.["health"], {
      ok: true,
      engineConnected: false,
      middlewareInstanceId: "middleware-test",
      firstAvailableSeq: "1",
      lastEventSeq: "0",
    });

    const unauthorized = await graphqlRequest(
      socketPath,
      "{ health { ok } }",
      undefined,
      generateTransportAuthToken(),
    );
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.data, undefined);

    const dispatched = await graphqlRequest(
      socketPath,
      `mutation ($p: JSON!) { dispatch(kind: light_add, payload: $p) { event projection { status reason } } }`,
      { p: LIGHT },
    );
    const dispatch = dispatched.data?.["dispatch"] as {
      event: { kind: string };
      projection: { status: string };
    };
    assert.equal(dispatch.event.kind, "lightAdded");
    assert.equal(dispatch.projection.status, "deferred"); // sem engine

    const queried = await graphqlRequest(socketPath, `{ projection(name: "lights") }`);
    const lights = (queried.data?.["projection"] as { lights: Array<{ lightId: string }> }).lights;
    assert.equal(lights[0]?.lightId, "sun");

    // O cursor legado não identifica sessão e falha explicitamente.
    const events = await graphqlRequest(socketPath, `{ eventsSince(afterSeq: 0) { seq kind } }`);
    assert.equal(events.errors?.[0]?.extensions?.code, -32602);
    assert.match(events.errors?.[0]?.message ?? "", /unsafe without projectSessionId/);

    const batch = await graphqlRequest(
      socketPath,
      `query ($instance: String!, $session: String!, $after: String!) {
        eventBatch(middlewareInstanceId: $instance, projectSessionId: $session, afterSeq: $after) {
          middlewareInstanceId firstAvailableSeq lastEventSeq
          resyncRequired resyncReason events { seq kind }
        }
      }`,
      {
        instance: "middleware-test",
        session: journal.position.projectSessionId,
        after: "0",
      },
    );
    assert.deepEqual(batch.data?.["eventBatch"], {
      middlewareInstanceId: "middleware-test",
      firstAvailableSeq: "1",
      lastEventSeq: "1",
      resyncRequired: false,
      resyncReason: null,
      events: [{ seq: "1", kind: "lightAdded" }],
    });

    const changed = await graphqlRequest(
      socketPath,
      `query { eventBatch(
        middlewareInstanceId: "old-process",
        projectSessionId: "${journal.position.projectSessionId}",
        afterSeq: "99"
      ) {
        resyncRequired resyncReason events { seq }
      } }`,
    );
    assert.deepEqual(changed.data?.["eventBatch"], {
      resyncRequired: true,
      resyncReason: "instance_changed",
      events: [],
    });

    const snapshot = await graphqlRequest(
      socketPath,
      `{ snapshot { middlewareInstanceId firstAvailableSeq lastEventSeq projections } }`,
    );
    const snap = snapshot.data?.["snapshot"] as {
      middlewareInstanceId: string;
      lastEventSeq: string;
      projections: Record<string, unknown>;
    };
    assert.equal(snap.middlewareInstanceId, "middleware-test");
    assert.equal(snap.lastEventSeq, "1");
    assert.deepEqual(Object.keys(snap.projections).sort(),
      ["camera", "document", "entities", "entityDefs", "levels", "lights", "meshes", "skeletons", "world"].sort());
    assert.equal(
      ((snap.projections["lights"] as { lights: Array<{ lightId: string }> }).lights[0]?.lightId),
      "sun",
    );

    const templates = await graphqlRequest(socketPath, "{ templates { id label } }");
    assert.ok(
      (templates.data?.["templates"] as Array<{ id: string }>).some((t) => t.id === "platformer-2d"),
    );

    const materialized = await graphqlRequest(
      socketPath,
      `query ProjectTemplateDocument(
        $templateId: String!
        $options: ProjectTemplateOptionsInput!
      ) {
        projectTemplateDocument(templateId: $templateId, options: $options)
      }`,
      {
        templateId: "platformer-2d",
        options: {
          projectId: "graphql-materialized",
          name: "Materializado via GraphQL",
          referenceResolution: { width: 1280, height: 720 },
          tileSize: 16,
        },
      },
    );
    assert.equal(materialized.errors, undefined);
    assert.equal(
      (materialized.data?.["projectTemplateDocument"] as { projectId: string }).projectId,
      "graphql-materialized",
    );

    const experience = await graphqlRequest(
      socketPath,
      `{ experience(family: "monogame", version: "3.8.2") { profileVersion liveManifestConsidered } }`,
    );
    assert.equal(
      (experience.data?.["experience"] as { profileVersion: string }).profileVersion,
      "3.8.2",
    );

    // erro com código estável na extensão (InvalidParams -32602)
    const bad = await graphqlRequest(socketPath, `{ projection(name: "nope") }`);
    assert.equal(bad.errors?.[0]?.extensions?.code, -32602);
  } finally {
    await gateway.close();
  }
});

test("GraphQL eventBatch: gap/cursor futuro são explícitos e nunca retornam cauda parcial", async () => {
  const { surface, journal } = await makeRig(2, "middleware-gap");
  journal.append("a", { kind: "a" });
  journal.append("b", { kind: "b" });
  journal.append("c", { kind: "c" });
  const gateway = new GraphQlGateway({
    pipeName: `p7m-gql-gap-${process.pid}-${pipeCounter++}`,
    surface,
    journal,
    log: silent,
    authToken: AUTH_TOKEN,
  });
  await gateway.listen();
  try {
    const query = `query ($after: String!) {
      eventBatch(
        middlewareInstanceId: "middleware-gap",
        projectSessionId: "${journal.position.projectSessionId}",
        afterSeq: $after
      ) {
        firstAvailableSeq lastEventSeq resyncRequired resyncReason events { seq }
      }
    }`;
    const gap = await graphqlRequest(gateway.endpoint.address, query, { after: "0" });
    assert.deepEqual(gap.data?.["eventBatch"], {
      firstAvailableSeq: "2",
      lastEventSeq: "3",
      resyncRequired: true,
      resyncReason: "journal_gap",
      events: [],
    });
    const ahead = await graphqlRequest(gateway.endpoint.address, query, { after: "9" });
    assert.deepEqual(ahead.data?.["eventBatch"], {
      firstAvailableSeq: "2",
      lastEventSeq: "3",
      resyncRequired: true,
      resyncReason: "cursor_ahead",
      events: [],
    });
    const invalid = await graphqlRequest(gateway.endpoint.address, query, { after: "01" });
    assert.equal(
      (invalid.data?.["eventBatch"] as { resyncReason: string }).resyncReason,
      "invalid_cursor",
    );
  } finally {
    await gateway.close();
  }
});

test("gRPC: dispatch/query unários + StreamEventsV2 session-aware com catch-up e ao vivo", async () => {
  const { surface, journal } = await makeRig();
  const gateway = new GrpcGateway({
    pipeName: `p7m-grpc-${process.pid}-${pipeCounter++}`,
    surface,
    journal,
    log: silent,
    authToken: AUTH_TOKEN,
  });
  await gateway.listen();
  const client = grpcClient(gateway.endpoint.grpcTarget);
  try {
    const health = await new Promise<{
      ok: boolean;
      middleware_instance_id: string;
      first_available_seq: string;
      last_event_seq: string;
    }>((resolve, reject) =>
      client.Health({}, (err, reply) => (err ? reject(err) : resolve(reply))),
    );
    assert.equal(health.ok, true);
    assert.equal(health.middleware_instance_id, "middleware-test");
    assert.equal(health.first_available_seq, "1");
    assert.equal(health.last_event_seq, "0");

    // catch-up: um evento ANTES do stream abrir
    await new Promise<void>((resolve, reject) =>
      client.Dispatch({ kind: "light/add", payload_json: JSON.stringify(LIGHT) }, (err, reply) => {
        if (err) return reject(err);
        assert.equal((JSON.parse(reply.event_json) as { kind: string }).kind, "lightAdded");
        assert.equal((JSON.parse(reply.projection_json) as { status: string }).status, "deferred");
        resolve();
      }),
    );

    const legacyFailure = await new Promise<grpc.ServiceError>((resolve) => {
      const legacy = client.StreamEvents({ after_seq: 0 });
      legacy.on("error", (error) => resolve(error as grpc.ServiceError));
    });
    assert.equal(legacyFailure.code, grpc.status.FAILED_PRECONDITION);

    const received: Array<{ seq: string; kind: string }> = [];
    const stream = client.StreamEventsV2({
      middleware_instance_id: journal.position.middlewareInstanceId,
      project_session_id: journal.position.projectSessionId,
      after_seq: "0",
    });
    stream.on("error", () => {
      // CANCELLED esperado quando o teste encerra o stream
    });
    const gotTwo = new Promise<void>((resolve) => {
      stream.on("data", (raw) => {
        const frame = raw as { event?: { seq: string; kind: string } };
        if (!frame.event) return;
        const e = frame.event;
        received.push({ seq: e.seq, kind: e.kind });
        if (received.length === 2) resolve();
      });
    });

    // ao vivo: segundo evento com o stream aberto
    await new Promise<void>((resolve, reject) =>
      client.Dispatch(
        { kind: "light/remove", payload_json: JSON.stringify({ lightId: "sun" }) },
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    await gotTwo;
    assert.deepEqual(received, [
      { seq: "1", kind: "lightAdded" },
      { seq: "2", kind: "lightRemoved" },
    ]);
    stream.cancel();

    // query unária espelha a projeção do GraphQL/JSON-RPC
    const result = await new Promise<{ result_json: string }>((resolve, reject) =>
      client.Query({ projection: "lights" }, (err, reply) => (err ? reject(err) : resolve(reply))),
    );
    assert.deepEqual(JSON.parse(result.result_json), { lights: [] }); // removida acima

    const snapshot = await new Promise<{
      projections_json: string;
      middleware_instance_id: string;
      first_available_seq: string;
      last_event_seq: string;
    }>((resolve, reject) =>
      client.Snapshot({}, (snapshotError, reply) =>
        snapshotError ? reject(snapshotError) : resolve(reply)),
    );
    assert.equal(snapshot.middleware_instance_id, "middleware-test");
    assert.equal(snapshot.last_event_seq, "2");
    const projections = JSON.parse(snapshot.projections_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(projections).sort(),
      ["camera", "document", "entities", "entityDefs", "levels", "lights", "meshes", "skeletons", "world"].sort());

    const status = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const v2 = client.StreamEventsV2({
        middleware_instance_id: "middleware-test",
        project_session_id: journal.position.projectSessionId,
        after_seq: "2",
      });
      v2.on("error", reject);
      v2.on("data", (raw) => {
        const frame = raw as { status?: Record<string, unknown> };
        if (frame.status) {
          resolve(frame.status);
          v2.cancel();
        }
      });
    });
    assert.equal(status["resync_required"], false);
    assert.equal(status["last_event_seq"], "2");

    // Estoura a janela e prova que o V2 envia apenas controle de resync, sem
    // entregar a cauda parcial disponível no ring.
    for (let i = 0; i < 513; i++) journal.append("synthetic", { kind: "synthetic", i });
    const gapFrames = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const frames: Array<Record<string, unknown>> = [];
      const v2 = client.StreamEventsV2({
        middleware_instance_id: "middleware-test",
        project_session_id: journal.position.projectSessionId,
        after_seq: "0",
      });
      v2.on("data", (raw) => frames.push(raw as Record<string, unknown>));
      v2.on("error", reject);
      v2.on("end", () => resolve(frames));
    });
    assert.equal(gapFrames.length, 1, "gap não pode entregar eventos parciais");
    const gapStatus = gapFrames[0]?.["status"] as Record<string, unknown>;
    assert.equal(gapStatus["resync_required"], true);
    assert.equal(gapStatus["resync_reason"], "journal_gap");

    // erro tipado: kind inválido -> INVALID_ARGUMENT com código estável nos details
    const err = await new Promise<grpc.ServiceError>((resolve) =>
      client.Dispatch({ kind: "nope/nope", payload_json: "{}" }, (e) => resolve(e!)),
    );
    assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
    assert.match(err.details, /-32602/);
  } finally {
    client.close();
    gateway.forceShutdown();
  }
});

test("histórico global: GraphQL e gRPC compartilham ACK, cursor, undo/redo e idempotência", async () => {
  const rig = await makeRig();
  const pipe = `p7m-history-${process.pid}-${pipeCounter++}`;
  const gql = new GraphQlGateway({
    pipeName: pipe,
    surface: rig.surface,
    journal: rig.journal,
    log: silent,
    authToken: AUTH_TOKEN,
  });
  const hot = new GrpcGateway({
    pipeName: pipe,
    surface: rig.surface,
    journal: rig.journal,
    log: silent,
    authToken: AUTH_TOKEN,
  });
  await gql.listen();
  await hot.listen();
  const client = grpcClient(hot.endpoint.grpcTarget);
  try {
    const level = {
      levelId: "level-1",
      width: 3,
      height: 1,
      tileSize: 16,
      seed: 7,
      intGrid: [0, 0, 0],
      rules: [],
      palette: [],
    };
    const defined = await graphqlRequest(
      gql.endpoint.address,
      `mutation ($payload: JSON!) {
        dispatch(kind: level_define, payload: $payload, requestId: "define-level") {
          commandSequence transactionId documentStateId historyCursor
          historyEntry { id label actor transactionId barrier }
        }
      }`,
      { payload: level },
    );
    assert.equal(defined.errors, undefined);
    const defineAck = defined.data?.["dispatch"] as {
      commandSequence: string;
      historyCursor: string;
      historyEntry: { actor: string };
    };
    assert.equal(defineAck.commandSequence, "1");
    assert.equal(defineAck.historyEntry.actor, "human");
    assert.ok(defineAck.historyCursor);

    const patchAck = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.Dispatch({
        kind: "level/patch",
        request_id: "paint-line",
        payload_json: JSON.stringify({
          levelId: "level-1",
          changes: [
            { index: 0, before: 0, after: 1 },
            { index: 1, before: 0, after: 1 },
            { index: 2, before: 0, after: 1 },
          ],
          transactionId: "gesture-line-1",
          // Tentativa do payload de escolher proveniência: a borda gRPC
          // obrigatoriamente substitui por human.
          metadata: { actor: "agent", label: "Pintar linha" },
        }),
      }, (error, reply) => error ? reject(error) : resolve(reply)),
    );
    assert.equal(patchAck["command_sequence"], "2");
    assert.equal(patchAck["transaction_id"], "gesture-line-1");
    assert.ok(patchAck["document_state_id"]);
    assert.ok(patchAck["history_cursor"]);
    assert.equal(
      (patchAck["history_entry"] as Record<string, unknown>)["actor"],
      "human",
    );

    const graphStatus = await graphqlRequest(
      gql.endpoint.address,
      `{ historyStatus(limit: 10) {
        projectSessionId commandSequence documentStateId historyCursor
        canUndo canRedo undoLabel
        entries { label actor transactionId applied }
      } }`,
    );
    const beforeUndo = graphStatus.data?.["historyStatus"] as {
      projectSessionId: string;
      historyCursor: string;
      canUndo: boolean;
      canRedo: boolean;
      undoLabel: string;
      entries: Array<{ label: string; actor: string; applied: boolean }>;
    };
    assert.equal(beforeUndo.canUndo, true);
    assert.equal(beforeUndo.canRedo, false);
    assert.equal(beforeUndo.undoLabel, "Pintar linha");
    assert.deepEqual(beforeUndo.entries[0], {
      label: "Pintar linha",
      actor: "human",
      transactionId: "gesture-line-1",
      applied: true,
    });

    const undone = await graphqlRequest(
      gql.endpoint.address,
      `mutation ($session: String!, $cursor: String!) {
        undo(
          requestId: "undo-cross-transport"
          expectedProjectSessionId: $session
          historyCursor: $cursor
        ) {
          commandSequence transactionId documentStateId historyCursor events
          entry { id label actor transactionId }
          history { canUndo canRedo redoLabel historyCursor }
        }
      }`,
      { session: beforeUndo.projectSessionId, cursor: beforeUndo.historyCursor },
    );
    assert.equal(undone.errors, undefined);
    const undoAck = undone.data?.["undo"] as {
      commandSequence: string;
      transactionId: string;
      historyCursor: string;
      events: Array<{ historyAction: string; actor: string }>;
      history: { canRedo: boolean; redoLabel: string };
    };
    assert.equal(undoAck.commandSequence, "3");
    assert.equal(undoAck.transactionId, "gesture-line-1");
    assert.equal(undoAck.history.canRedo, true);
    assert.equal(undoAck.history.redoLabel, "Pintar linha");
    assert.equal(undoAck.events[0]?.historyAction, "undo");
    assert.equal(undoAck.events[0]?.actor, "human");
    assert.deepEqual(rig.store.listLevels()[0]?.intGrid, [0, 0, 0]);

    const seqAfterUndo = rig.journal.lastSeq;
    const grpcRetry = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.Undo({
        request_id: "undo-cross-transport",
        expected_project_session_id: beforeUndo.projectSessionId,
        history_cursor: beforeUndo.historyCursor,
      }, (error, reply) => error ? reject(error) : resolve(reply)),
    );
    assert.equal(grpcRetry["command_sequence"], undoAck.commandSequence);
    assert.equal(rig.journal.lastSeq, seqAfterUndo, "retry não pode executar um segundo undo");

    const grpcStatus = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.HistoryStatus({ limit: 10 }, (error, reply) =>
        error ? reject(error) : resolve(reply)),
    );
    assert.equal(grpcStatus["history_cursor"], undoAck.historyCursor);
    assert.equal(grpcStatus["can_redo"], true);

    const redone = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.Redo({
        request_id: "redo-cross-transport",
        expected_project_session_id: beforeUndo.projectSessionId,
        history_cursor: undoAck.historyCursor,
      }, (error, reply) => error ? reject(error) : resolve(reply)),
    );
    assert.equal(redone["command_sequence"], "4");
    const redoEvent = JSON.parse(
      (redone["events_json"] as string[])[0]!,
    ) as Record<string, unknown>;
    assert.equal(redoEvent["historyAction"], "redo");

    const graphProjection = await graphqlRequest(
      gql.endpoint.address,
      `{ projection(name: "levels") }`,
    );
    const levels = (graphProjection.data?.["projection"] as {
      levels: Array<{ intGrid: number[] }>;
    }).levels;
    assert.deepEqual(levels[0]?.intGrid, [1, 1, 1]);

    await rig.surface.projectClose(beforeUndo.projectSessionId, "4");
    const inactive = await graphqlRequest(
      gql.endpoint.address,
      `{ health { documentStateId historyCursor }
         projectStatus { active documentStateId historyCursor canUndo canRedo }
         snapshot {
           status { active documentStateId historyCursor canUndo canRedo }
           documentStateId historyCursor
           history { projectSessionId projectId documentStateId historyCursor entries { id } }
         }
       }`,
    );
    assert.equal(inactive.errors, undefined, "campos non-null devem ter shape mesmo sem projeto");
    assert.deepEqual(inactive.data?.["projectStatus"], {
      active: false,
      documentStateId: "",
      historyCursor: "",
      canUndo: false,
      canRedo: false,
    });
    const inactiveSnapshot = inactive.data?.["snapshot"] as {
      status: { active: boolean };
      history: { entries: unknown[] };
    };
    assert.equal(inactiveSnapshot.status.active, false);
    assert.deepEqual(inactiveSnapshot.history.entries, []);

    const inactiveGrpc = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.ProjectStatus({}, (error, reply) => error ? reject(error) : resolve(reply)),
    );
    assert.equal(inactiveGrpc["active"], false);
    assert.equal(inactiveGrpc["document_state_id"], "");
    assert.equal(inactiveGrpc["history_cursor"], "");
    assert.equal(inactiveGrpc["can_undo"], false);
    assert.equal(inactiveGrpc["can_redo"], false);
  } finally {
    client.close();
    hot.forceShutdown();
    await gql.close();
  }
});

test("histórico global: MCP usa a mesma sessão e fixa proveniência agent", async () => {
  const rig = await makeRig();
  const server = createMcpServer(
    {} as never,
    { currentSession: undefined } as never,
    undefined,
    { surface: rig.surface } as never,
  );
  const client = new McpClient({ name: "history-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await client.callTool({ name, arguments: args });
    const textBlock = result.content[0] as { type: string; text?: string } | undefined;
    assert.equal(textBlock?.type, "text");
    return JSON.parse(textBlock?.text ?? "{}") as Record<string, unknown>;
  };
  try {
    await call("blueprint_command", {
      kind: "level/define",
      payload: {
        levelId: "mcp-level",
        width: 1,
        height: 1,
        tileSize: 16,
        seed: 1,
        intGrid: [0],
        rules: [],
        palette: [],
      },
    });
    const patch = await call("blueprint_command", {
      kind: "level/patch",
      payload: {
        levelId: "mcp-level",
        changes: [{ index: 0, before: 0, after: 2 }],
        transactionId: "mcp-gesture",
        metadata: { actor: "human", label: "Pintura do agente" },
      },
    });
    assert.equal(
      (patch["historyEntry"] as Record<string, unknown>)["actor"],
      "agent",
    );

    const status = await call("history_status", { limit: 10 });
    assert.equal(status["canUndo"], true);
    assert.equal(status["undoLabel"], "Pintura do agente");
    const undone = await call("history_undo", {
      expectedProjectSessionId: status["projectSessionId"],
      historyCursor: status["historyCursor"],
    });
    assert.deepEqual(rig.store.listLevels()[0]?.intGrid, [0]);
    assert.equal((undone["entry"] as Record<string, unknown>)["actor"], "agent");
    const undoEvent = (undone["events"] as Array<Record<string, unknown>>)[0]!;
    assert.equal(undoEvent["historyAction"], "undo");
    assert.equal(undoEvent["actor"], "agent");

    const undoHistory = undone["history"] as Record<string, unknown>;
    const redone = await call("history_redo", {
      expectedProjectSessionId: status["projectSessionId"],
      historyCursor: undoHistory["historyCursor"],
    });
    assert.deepEqual(rig.store.listLevels()[0]?.intGrid, [2]);
    assert.equal(
      ((redone["events"] as Array<Record<string, unknown>>)[0]!)["historyAction"],
      "redo",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("sessão de projeto: paridade GraphQL, gRPC e gateway legado sobre a mesma sessão", async () => {
  const rig = await makeRig();
  const pipe = `p7m-both-${process.pid}-${pipeCounter++}`;
  const gql = new GraphQlGateway({
    pipeName: pipe,
    surface: rig.surface,
    journal: rig.journal,
    log: silent,
    authToken: AUTH_TOKEN,
  });
  const hot = new GrpcGateway({
    pipeName: pipe,
    surface: rig.surface,
    journal: rig.journal,
    log: silent,
    authToken: AUTH_TOKEN,
  });
  const legacy = new EditorGateway({
    pipeName: pipe,
    surface: rig.surface,
    journal: rig.journal,
    authToken: AUTH_TOKEN,
  });
  await gql.listen();
  await hot.listen();
  await legacy.listen();
  const client = grpcClient(hot.endpoint.grpcTarget);
  const socket = net.connect(legacy.pipePath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const legacyClient = new JsonRpcPeer(socket, {
    label: "transport-parity-legacy",
    requestTimeoutMs: 2_000,
  });
  await legacyClient.request("editor/handshake", {
    clientName: "transport-parity",
    protocolVersion: PROTOCOL_VERSION,
    authToken: AUTH_TOKEN,
  });
  try {
    const created = await graphqlRequest(
      gql.endpoint.address,
      `mutation ($expected: String!) {
        projectCreate(
          projectId: "shared-project"
          expectedProjectSessionId: $expected
        ) {
          status { active projectSessionId projectId commandSequence runtimeState }
          summary { applied }
          templateId name
        }
      }`,
      { expected: rig.sessions.status.projectSessionId },
    );
    const createdStatus = (created.data?.["projectCreate"] as {
      status: { projectSessionId: string; projectId: string };
    }).status;
    assert.equal(createdStatus.projectId, "shared-project");

    const grpcStatus = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.ProjectStatus({}, (error, reply) => error ? reject(error) : resolve(reply)),
    );
    assert.equal(grpcStatus["project_session_id"], createdStatus.projectSessionId);
    assert.equal(grpcStatus["project_id"], "shared-project");
    const legacyStatus = await legacyClient.request("project/status", {}) as {
      projectSessionId: string;
      projectId: string;
    };
    assert.equal(legacyStatus.projectSessionId, createdStatus.projectSessionId);
    assert.equal(legacyStatus.projectId, "shared-project");

    const definition = { entityDefId: "player", archetypeId: "hero", fields: [] };
    await graphqlRequest(
      gql.endpoint.address,
      `mutation ($p: JSON!) {
        dispatch(kind: entitydef_define, payload: $p, requestId: "same-dispatch") { event }
      }`,
      { p: definition },
    );

    // Simula resposta gRPC perdida e retry no GraphQL (ou vice-versa): o mesmo
    // requestId cruza transports sem reaplicar o comando/evento.
    await new Promise<void>((resolve, reject) =>
      client.Dispatch(
        {
          kind: "entitydef/define",
          payload_json: JSON.stringify(definition),
          request_id: "same-dispatch",
        },
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    const seqAfterFirstDispatch = rig.journal.lastSeq;
    assert.equal(seqAfterFirstDispatch, 2n, "troca de sessão + primeiro comando");
    const reused = await new Promise<grpc.ServiceError>((resolve) =>
      client.Dispatch(
        {
          kind: "entitydef/define",
          payload_json: JSON.stringify({ ...definition, entityDefId: "enemy" }),
          request_id: "same-dispatch",
        },
        (err) => resolve(err!),
      ),
    );
    assert.equal(rig.journal.lastSeq, seqAfterFirstDispatch, "retry não deve emitir evento");
    assert.equal(reused.code, grpc.status.INVALID_ARGUMENT);
    assert.match(reused.details, /different command/);

    const staleClose = await graphqlRequest(
      gql.endpoint.address,
      `mutation ($session: String!) {
        projectClose(
          expectedProjectSessionId: $session
          expectedCommandSequence: "0"
        ) { active }
      }`,
      { session: createdStatus.projectSessionId },
    );
    assert.equal(staleClose.errors?.[0]?.extensions?.code, RpcErrorCode.ProjectSessionConflict);
    assert.match(staleClose.errors?.[0]?.message ?? "", /command sequence changed before close/);
    assert.equal(rig.sessions.status.active, true);

    const viaGrpc = await new Promise<{ result_json: string }>((resolve, reject) =>
      client.Query({ projection: "entityDefs" }, (err, reply) => (err ? reject(err) : resolve(reply))),
    );
    const defs = (JSON.parse(viaGrpc.result_json) as { entityDefs: Array<{ entityDefId: string }> }).entityDefs;
    assert.equal(defs[0]?.entityDefId, "player");

    // Open pelo gRPC substitui a sessão observada imediatamente pelas outras
    // duas bordas e não reaproveita o store anterior.
    const opened = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.ProjectOpenDocument(
        {
          document_json: JSON.stringify({
            schemaVersion: 2,
            projectId: "opened-via-grpc",
            skeletons: [],
            meshes: [],
            camera: {},
            lights: [],
            entityDefs: [{ entityDefId: "from-grpc-open", fields: [] }],
            entities: [],
            levels: [],
            placements: [],
          }),
          expected_project_session_id: createdStatus.projectSessionId,
        },
        (error, reply) => error ? reject(error) : resolve(reply),
      ),
    );
    const openedStatus = opened["status"] as Record<string, unknown>;
    assert.equal(openedStatus["project_id"], "opened-via-grpc");
    const graphQlAfterOpen = await graphqlRequest(
      gql.endpoint.address,
      `{ projectStatus { projectSessionId projectId } projection(name: "entityDefs") }`,
    );
    assert.equal(
      (graphQlAfterOpen.data?.["projectStatus"] as { projectId: string }).projectId,
      "opened-via-grpc",
    );
    assert.deepEqual(
      (graphQlAfterOpen.data?.["projection"] as { entityDefs: unknown[] }).entityDefs,
      [{ entityDefId: "from-grpc-open", fields: [] }],
    );
    const legacyDefinitions = await legacyClient.request("blueprint/query", {
      projection: "entityDefs",
    }) as { entityDefs: unknown[] };
    assert.deepEqual(
      legacyDefinitions.entityDefs,
      [{ entityDefId: "from-grpc-open", fields: [] }],
    );

    // Create pelo legado e close pelo gRPC completam a paridade das operações
    // de aplicação e provam que status é único nas três bordas.
    const legacyCreated = await legacyClient.request("project/create", {
      projectId: "created-via-legacy",
      expectedProjectSessionId: openedStatus["project_session_id"],
    }) as { status: { projectSessionId: string; projectId: string } };
    const graphQlAfterLegacyCreate = await graphqlRequest(
      gql.endpoint.address,
      `{ projectStatus { projectSessionId projectId active } }`,
    );
    assert.equal(
      (graphQlAfterLegacyCreate.data?.["projectStatus"] as { projectSessionId: string }).projectSessionId,
      legacyCreated.status.projectSessionId,
    );
    const grpcAfterLegacyCreate = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.ProjectStatus({}, (error, reply) => error ? reject(error) : resolve(reply)),
    );
    assert.equal(grpcAfterLegacyCreate["project_id"], "created-via-legacy");

    const grpcTemplateCreated = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.ProjectCreate(
        {
          project_id: "template-via-grpc",
          template_id: "platformer-2d",
          expected_project_session_id: legacyCreated.status.projectSessionId,
          expected_command_sequence: "0",
        },
        (error, reply) => error ? reject(error) : resolve(reply),
      ),
    );
    assert.equal(grpcTemplateCreated["template_id"], "platformer-2d");
    assert.equal(grpcTemplateCreated["name"], "Plataforma 2D");
    const grpcTemplateStatus = grpcTemplateCreated["status"] as Record<string, unknown>;

    const closed = await new Promise<Record<string, unknown>>((resolve, reject) =>
      client.ProjectClose(
        {
          expected_project_session_id: grpcTemplateStatus["project_session_id"] as string,
          expected_command_sequence: grpcTemplateStatus["command_sequence"] as string,
        },
        (error, reply) => error ? reject(error) : resolve(reply),
      ),
    );
    assert.equal(closed["active"], false);
    const graphQlClosed = await graphqlRequest(
      gql.endpoint.address,
      `{ projectStatus { active projectSessionId projectId } }`,
    );
    assert.equal((graphQlClosed.data?.["projectStatus"] as { active: boolean }).active, false);
    assert.equal(
      ((await legacyClient.request("project/status", {})) as { active: boolean }).active,
      false,
    );
  } finally {
    legacyClient.close();
    client.close();
    await legacy.close();
    hot.forceShutdown();
    await gql.close();
  }
});
