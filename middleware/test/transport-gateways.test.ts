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

function makeRig(): Rig {
  const store = new BlueprintStore();
  const hooks = new HookBus();
  const adapter = offlineAdapter();
  const orchestrator = new CanonicalOrchestrator(store, hooks, adapter);
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const governor = new ExperienceGovernor(profiles);
  const surface = new EditorSurface({ orchestrator, store, governor, adapter });
  const journal = new EventJournal();
  store.on("event", (event: BlueprintEvent) => journal.append(event.kind, event));
  return { surface, journal, store };
}

const silent = createLogger("test", { level: "silent" });
let pipeCounter = 0;

function graphqlRequest(
  socketPath: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string; extensions?: { code?: number } }> }> {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: "/graphql", method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

interface HotPathClient {
  Health(req: object, cb: (err: grpc.ServiceError | null, reply: { ok: boolean; last_event_seq: number }) => void): void;
  Dispatch(
    req: { kind: string; payload_json: string },
    cb: (err: grpc.ServiceError | null, reply: { event_json: string; projection_json: string }) => void,
  ): void;
  Query(req: { projection: string }, cb: (err: grpc.ServiceError | null, reply: { result_json: string }) => void): void;
  StreamEvents(req: { after_seq: number }): { on(ev: string, fn: (arg: unknown) => void): void; cancel(): void };
  close(): void;
}

function grpcClient(target: string): HotPathClient {
  const pkg = loadEditorProto() as unknown as {
    p7m: { editor: { v1: { EditorHotPath: new (t: string, c: grpc.ChannelCredentials) => HotPathClient } } };
  };
  return new pkg.p7m.editor.v1.EditorHotPath(target, grpc.credentials.createInsecure());
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

test("GraphQL: dispatch/query/eventsSince/templates/experience na mesma superfície canônica", async () => {
  const { surface, journal } = makeRig();
  const gateway = new GraphQlGateway({
    pipeName: `p7m-gql-${process.pid}-${pipeCounter++}`,
    surface,
    journal,
    log: silent,
  });
  await gateway.listen();
  try {
    const socketPath = gateway.endpoint.address;

    const health = await graphqlRequest(socketPath, "{ health { ok engineConnected lastEventSeq } }");
    assert.deepEqual(health.data?.["health"], { ok: true, engineConnected: false, lastEventSeq: 0 });

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

test("gRPC: dispatch/query unários + StreamEvents com catch-up e ao vivo", async () => {
  const { surface, journal } = makeRig();
  const gateway = new GrpcGateway({
    pipeName: `p7m-grpc-${process.pid}-${pipeCounter++}`,
    surface,
    journal,
    log: silent,
  });
  await gateway.listen();
  const client = grpcClient(gateway.endpoint.grpcTarget);
  try {
    const health = await new Promise<{ ok: boolean }>((resolve, reject) =>
      client.Health({}, (err, reply) => (err ? reject(err) : resolve(reply))),
    );
    assert.equal(health.ok, true);

    // catch-up: um evento ANTES do stream abrir
    await new Promise<void>((resolve, reject) =>
      client.Dispatch({ kind: "light/add", payload_json: JSON.stringify(LIGHT) }, (err, reply) => {
        if (err) return reject(err);
        assert.equal((JSON.parse(reply.event_json) as { kind: string }).kind, "lightAdded");
        assert.equal((JSON.parse(reply.projection_json) as { status: string }).status, "deferred");
        resolve();
      }),
    );

    const received: Array<{ seq: number; kind: string }> = [];
    const stream = client.StreamEvents({ after_seq: 0 });
    stream.on("error", () => {
      // CANCELLED esperado quando o teste encerra o stream
    });
    const gotTwo = new Promise<void>((resolve) => {
      stream.on("data", (raw) => {
        const e = raw as { seq: number; kind: string };
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
      { seq: 1, kind: "lightAdded" },
      { seq: 2, kind: "lightRemoved" },
    ]);
    stream.cancel();

    // query unária espelha a projeção do GraphQL/JSON-RPC
    const result = await new Promise<{ result_json: string }>((resolve, reject) =>
      client.Query({ projection: "lights" }, (err, reply) => (err ? reject(err) : resolve(reply))),
    );
    assert.deepEqual(JSON.parse(result.result_json), { lights: [] }); // removida acima

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
  const gql = new GraphQlGateway({ pipeName: pipe, surface: rig.surface, journal: rig.journal, log: silent });
  const hot = new GrpcGateway({ pipeName: pipe, surface: rig.surface, journal: rig.journal, log: silent });
  await gql.listen();
  await hot.listen();
  const client = grpcClient(hot.endpoint.grpcTarget);
  try {
    await graphqlRequest(
      gql.endpoint.address,
      `mutation ($p: JSON!) { dispatch(kind: entitydef_define, payload: $p) { event } }`,
      { p: { entityDefId: "player", archetypeId: "hero", fields: [] } },
    );
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
