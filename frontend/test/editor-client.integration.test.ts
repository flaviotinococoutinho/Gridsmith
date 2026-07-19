/**
 * Integração do EditorClient v2 contra os TRANSPORTS REAIS do middleware
 * (gRPC quente + GraphQL baseline — ADR-016/017):
 *  - conexão prioriza gRPC (health) e recebe eventos por stream;
 *  - dispatch/query/experience/templates com a MESMA superfície canônica;
 *  - FALLBACK provado: derruba o gRPC no meio da sessão → as chamadas e os
 *    eventos continuam via GraphQL (polling incremental, sem perder seq);
 *  - RECOVERY provado: gRPC volta → sondas com histerese repromovem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EnginePipeServer } from "@p7m/middleware/dist/ipc/EnginePipeServer.js";
import { BlueprintStore } from "@p7m/middleware/dist/domain/BlueprintStore.js";
import { CapabilityRegistry } from "@p7m/middleware/dist/domain/CapabilityRegistry.js";
import { CanonicalOrchestrator } from "@p7m/middleware/dist/canonical/CanonicalOrchestrator.js";
import { EditorSurface } from "@p7m/middleware/dist/canonical/EditorSurface.js";
import { HookBus } from "@p7m/middleware/dist/canonical/HookBus.js";
import { GraphQlGateway } from "@p7m/middleware/dist/graphql/GraphQlGateway.js";
import { GrpcGateway } from "@p7m/middleware/dist/grpc/GrpcGateway.js";
import { EventJournal } from "@p7m/middleware/dist/transport/EventJournal.js";
import { ExperienceGovernor } from "@p7m/middleware/dist/runtime/ExperienceGovernor.js";
import { MonoGameAdapter } from "@p7m/middleware/dist/runtime/MonoGameAdapter.js";
import { RuntimeProfileRegistry } from "@p7m/middleware/dist/runtime/RuntimeProfile.js";
import { MONOGAME_PROFILES } from "@p7m/middleware/dist/runtime/profiles/monogame.js";
import { createLogger as createMiddlewareLogger } from "@p7m/middleware/dist/util/log.js";
import { EditorClient } from "../src/main/EditorClient.js";
import { createLogger } from "../src/core/logging.js";
import { ExperienceGate } from "../src/core/experienceGate.js";

const silentMw = createMiddlewareLogger("test", { level: "silent" });
const silentFe = createLogger("test", { level: "silent" });

interface Rig {
  pipeName: string;
  engineServer: EnginePipeServer;
  graphql: GraphQlGateway;
  grpc: GrpcGateway;
  surface: EditorSurface;
  journal: EventJournal;
  close(): Promise<void>;
}

async function makeRig(tag: string): Promise<Rig> {
  const pipeName = `p7m-fe-${tag}-${process.pid}-${Date.now() % 100000}`;
  const engineServer = new EnginePipeServer({ pipeName, requestTimeoutMs: 2000 });
  const capabilities = new CapabilityRegistry(engineServer);
  const adapter = new MonoGameAdapter(engineServer, capabilities);
  const store = new BlueprintStore();
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const surface = new EditorSurface({
    orchestrator: new CanonicalOrchestrator(store, new HookBus(), adapter),
    store,
    governor: new ExperienceGovernor(profiles, capabilities),
    adapter,
  });
  const journal = new EventJournal();
  store.on("event", (event: { kind: string }) => journal.append(event.kind, event));

  const graphql = new GraphQlGateway({ pipeName, surface, journal, log: silentMw });
  const grpc = new GrpcGateway({ pipeName, surface, journal, log: silentMw });
  await engineServer.listen();
  await graphql.listen();
  await grpc.listen();
  return {
    pipeName,
    engineServer,
    graphql,
    grpc,
    surface,
    journal,
    close: async () => {
      grpc.forceShutdown();
      await graphql.close();
      await engineServer.close();
    },
  };
}

test("EditorClient v2: conecta via gRPC, despacha, consulta, recebe eventos por stream e alimenta o gate", async () => {
  const rig = await makeRig("hot");
  const client = new EditorClient(rig.pipeName, { requestTimeoutMs: 2000, log: silentFe });
  try {
    const { sessionId } = await client.connect();
    assert.ok(sessionId.length > 0);
    assert.equal(client.isConnected, true);
    assert.equal(client.activeTransport, "grpc");

    const received: string[] = [];
    client.onBlueprintEvent((event) => received.push(event.kind));

    // dispatch pelo caminho canônico (engine offline → deferred, AST aceita)
    const outcome = await client.dispatch("entitydef/define", {
      entityDefId: "coin",
      fields: [{ name: "value", type: "int", default: 1 }],
    });
    assert.equal(outcome.event.kind, "entityDefDefined");
    assert.equal(outcome.projection?.status, "deferred");

    const defs = await client.query<{ entityDefs: Array<{ entityDefId: string }> }>("entityDefs");
    assert.equal(defs.entityDefs[0]?.entityDefId, "coin");

    // evento chegou pelo STREAM gRPC
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(received, ["entityDefDefined"]);

    // experiência governada (GraphQL baseline) alimenta o gate da UI
    const experience = await client.resolveExperience("monogame", "3.8.2");
    const gate = new ExperienceGate(experience);
    assert.equal(gate.panel("shader-editor").enabled, true);
    assert.equal(gate.panel("level-editor").enabled, false); // requiresSubsystem sem engine
    assert.match(gate.panel("level-editor").reason, /no engine connected/);
  } finally {
    client.close();
    await rig.close();
  }
});

test("EditorClient v2: template Plataforma 2D pela superfície GraphQL", async () => {
  const rig = await makeRig("tpl");
  const client = new EditorClient(rig.pipeName, { requestTimeoutMs: 2000, log: silentFe });
  try {
    await client.connect();

    const { templates } = await client.listProjectTemplates();
    assert.ok(templates.some((t) => t.id === "platformer-2d"));

    const summary = await client.newProjectFromTemplate("platformer-2d");
    assert.equal(summary.templateId, "platformer-2d");
    assert.equal(summary.applied, 6);

    const levels = await client.query<{ levels: Array<{ levelId: string }> }>("levels");
    assert.equal(levels.levels[0]?.levelId, "level-1");
  } finally {
    client.close();
    await rig.close();
  }
});

test("fallback ao vivo: gRPC cai no meio da sessão → chamadas e eventos seguem via GraphQL; recovery repromove", async () => {
  const rig = await makeRig("fb");
  const client = new EditorClient(rig.pipeName, {
    requestTimeoutMs: 2000,
    eventPollMs: 50,
    probeTickMs: 50,
    log: silentFe,
  });
  try {
    await client.connect();
    assert.equal(client.activeTransport, "grpc");

    const received: string[] = [];
    client.onBlueprintEvent((event) => received.push(event.kind));

    await client.dispatch("light/add", {
      lightId: "sun",
      type: "point",
      position: [0, 0],
      color: [1, 1, 1],
      intensity: 1,
      radius: 64,
    });

    // ---- derruba o gRPC no meio da sessão ----
    rig.grpc.forceShutdown();

    // a PRÓXIMA chamada quente falha no transporte e cai para o GraphQL
    const viaFallback = await client.dispatch("light/remove", { lightId: "sun" });
    assert.equal(viaFallback.event.kind, "lightRemoved");
    assert.equal(client.activeTransport, "graphql");

    // eventos seguem chegando (polling incremental, sem perder o seq 2)
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(received, ["lightAdded", "lightRemoved"]);

    // erro de DOMÍNIO no fallback NÃO derruba nada e carrega o código estável
    await assert.rejects(client.query("projecao-inexistente"), /-32602|must be one of/);
    assert.equal(client.activeTransport, "graphql");

    // ---- gRPC volta: sondas com histerese repromovem ----
    const revived = new GrpcGateway({
      pipeName: rig.pipeName,
      surface: rig.surface,
      journal: rig.journal,
      log: silentMw,
    });
    await revived.listen();
    try {
      const deadline = Date.now() + 15_000;
      while (client.activeTransport !== "grpc" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(client.activeTransport, "grpc", "recovery deve repromover ao gRPC");

      // e o caminho quente volta a funcionar no primário
      const back = await client.query<{ lights: unknown[] }>("lights");
      assert.deepEqual(back.lights, []);
    } finally {
      revived.forceShutdown();
    }
  } finally {
    client.close();
    await rig.close();
  }
});
