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
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { EditorSurface } from "../src/canonical/EditorSurface.js";
import { COMMAND_KINDS } from "../src/canonical/commandShape.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { BlueprintStore, type BlueprintEvent } from "../src/domain/BlueprintStore.js";
import { GraphQlGateway, resolveSdlPath, graphqlKindToCanonical } from "../src/graphql/GraphQlGateway.js";
import { GrpcGateway, resolveProtoPath, loadEditorProto } from "../src/grpc/GrpcGateway.js";
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
  };
}

interface Rig {
  surface: EditorSurface;
  journal: EventJournal;
  store: BlueprintStore;
}

function makeRig(capacity = 512, middlewareInstanceId = "middleware-test"): Rig {
  const store = new BlueprintStore();
  const hooks = new HookBus();
  const adapter = offlineAdapter();
  const orchestrator = new CanonicalOrchestrator(store, hooks, adapter);
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const governor = new ExperienceGovernor(profiles);
  const surface = new EditorSurface({ orchestrator, store, governor, adapter });
  const journal = new EventJournal(capacity, middlewareInstanceId);
  store.on("event", (event: BlueprintEvent) => journal.append(event.kind, event));
  return { surface, journal, store };
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
        first_available_seq: string;
        last_event_seq: string;
      },
    ) => void,
  ): void;
  Dispatch(
    req: { kind: string; payload_json: string; request_id?: string },
    cb: (err: grpc.ServiceError | null, reply: { event_json: string; projection_json: string }) => void,
  ): void;
  Query(req: { projection: string }, cb: (err: grpc.ServiceError | null, reply: { result_json: string }) => void): void;
  Snapshot(
    req: object,
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
  StreamEvents(req: { after_seq: number }): { on(ev: string, fn: (arg: unknown) => void): void; cancel(): void };
  StreamEventsV2(req: {
    middleware_instance_id: string;
    after_seq: string;
  }): { on(ev: string, fn: (arg: unknown) => void): void; cancel(): void };
  close(): void;
}

function grpcClient(target: string): HotPathClient {
  const pkg = loadEditorProto() as unknown as {
    p7m: { editor: { v1: { EditorHotPath: new (t: string, c: grpc.ChannelCredentials) => HotPathClient } } };
  };
  const raw = new pkg.p7m.editor.v1.EditorHotPath(target, grpc.credentials.createInsecure());
  const authenticatedMethods = new Set([
    "Health", "Dispatch", "Query", "Snapshot", "StreamEvents", "StreamEventsV2",
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
  const rig = makeRig(8, "middleware-pure");
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
  assert.deepEqual(Object.keys(snapshot).sort(),
    ["camera", "document", "entities", "entityDefs", "levels", "lights", "meshes", "skeletons", "world"].sort());
  assert.equal(
    (snapshot.entityDefs["entityDefs"] as Array<{ entityDefId: string }>)[0]?.entityDefId,
    "coin",
  );
});

test("GraphQL: dispatch/query/eventsSince/templates/experience na mesma superfície canônica", async () => {
  const { surface, journal } = makeRig();
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

    // eventos por polling incremental (fallback): o dispatch acima é seq 1
    const events = await graphqlRequest(socketPath, `{ eventsSince(afterSeq: 0) { seq kind } }`);
    assert.deepEqual(events.data?.["eventsSince"], [{ seq: 1, kind: "lightAdded" }]);

    const batch = await graphqlRequest(
      socketPath,
      `query ($instance: String!, $after: String!) {
        eventBatch(middlewareInstanceId: $instance, afterSeq: $after) {
          middlewareInstanceId firstAvailableSeq lastEventSeq
          resyncRequired resyncReason events { seq kind }
        }
      }`,
      { instance: "middleware-test", after: "0" },
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
      `query { eventBatch(middlewareInstanceId: "old-process", afterSeq: "99") {
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
  const { surface, journal } = makeRig(2, "middleware-gap");
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
      eventBatch(middlewareInstanceId: "middleware-gap", afterSeq: $after) {
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

test("gRPC: dispatch/query unários + StreamEvents com catch-up e ao vivo", async () => {
  const { surface, journal } = makeRig();
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

    const received: Array<{ seq: string; kind: string }> = [];
    const stream = client.StreamEvents({ after_seq: 0 });
    stream.on("error", () => {
      // CANCELLED esperado quando o teste encerra o stream
    });
    const gotTwo = new Promise<void>((resolve) => {
      stream.on("data", (raw) => {
        const e = raw as { seq: string; kind: string };
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

test("paridade entre transports: mesma mutação via GraphQL aparece na query gRPC (superfície única)", async () => {
  const rig = makeRig();
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
  await gql.listen();
  await hot.listen();
  const client = grpcClient(hot.endpoint.grpcTarget);
  try {
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
    assert.equal(rig.journal.lastSeq, 1n, "retry cross-transport deve emitir um único evento");
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
    assert.equal(reused.code, grpc.status.INVALID_ARGUMENT);
    assert.match(reused.details, /different command/);

    const viaGrpc = await new Promise<{ result_json: string }>((resolve, reject) =>
      client.Query({ projection: "entityDefs" }, (err, reply) => (err ? reject(err) : resolve(reply))),
    );
    const defs = (JSON.parse(viaGrpc.result_json) as { entityDefs: Array<{ entityDefId: string }> }).entityDefs;
    assert.equal(defs[0]?.entityDefId, "player");
  } finally {
    client.close();
    hot.forceShutdown();
    await gql.close();
  }
});
