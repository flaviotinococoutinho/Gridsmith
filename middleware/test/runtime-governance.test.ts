import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import {
  RuntimeProfileRegistry,
  UnknownRuntimeError,
  compareVersions,
} from "../src/runtime/RuntimeProfile.js";
import { MONOGAME_3_8, MONOGAME_3_8_2, MONOGAME_PROFILES } from "../src/runtime/profiles/monogame.js";
import { ExperienceGovernor } from "../src/runtime/ExperienceGovernor.js";
import { MonoGameAdapter } from "../src/runtime/MonoGameAdapter.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { BlueprintStore, type BlueprintCommand } from "../src/domain/BlueprintStore.js";
import { CapabilityRegistry, type EngineManifest } from "../src/domain/CapabilityRegistry.js";
import { EnginePipeServer } from "../src/ipc/EnginePipeServer.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { PROTOCOL_VERSION } from "../src/protocol/jsonrpc.js";

function makeRegistry(): RuntimeProfileRegistry {
  const registry = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) registry.register(profile);
  return registry;
}

// ---------- Perfis versionados ----------

test("resolução de perfil: exato, descendente e erros tipados", () => {
  const registry = makeRegistry();

  assert.equal(registry.resolve("monogame", "3.8.2"), MONOGAME_3_8_2);
  // 3.8.1 não tem perfil próprio → cai no 3.8.0 (compatibilidade descendente)
  assert.equal(registry.resolve("monogame", "3.8.1"), MONOGAME_3_8);
  // versão futura usa o perfil mais recente conhecido
  assert.equal(registry.resolve("monogame", "4.0.0"), MONOGAME_3_8_2);

  assert.throws(() => registry.resolve("godot", "4.2.0"), UnknownRuntimeError);
  assert.throws(() => registry.resolve("monogame", "3.7.0"), /predates the oldest/);
});

test("perfis publicados são imutáveis (re-registro rejeitado) e versões ordenadas", () => {
  const registry = makeRegistry();
  assert.throws(() => registry.register(MONOGAME_3_8), /immutable/);
  assert.deepEqual(registry.versionsOf("monogame"), ["3.8.0", "3.8.2"]);
  assert.equal(compareVersions("3.10.0", "3.9.9") > 0, true); // comparação numérica, não lexicográfica
});

// ---------- Governança da experiência ----------

const LIVE_MANIFEST: EngineManifest = {
  engine: {
    name: "P7m.Engine.Runtime",
    version: "0.1.0",
    protocolVersion: "1.0",
    runtime: { family: "monogame", version: "3.8.2" },
  },
  subsystems: {
    lighting: { status: "available" },
    level: { status: "available" },
    camera: { status: "available" },
    assets: { status: "planned", phase: 4 },
  },
};

function governorWith(manifest?: EngineManifest): ExperienceGovernor {
  const fake = manifest
    ? ({ manifest } as unknown as CapabilityRegistry)
    : undefined;
  return new ExperienceGovernor(makeRegistry(), fake);
}

function decision(governor: ExperienceGovernor, version: string, feature: string) {
  return governor.resolve("monogame", version).decisions.find((d) => d.feature === feature)!;
}

test("a versão do perfil governa a experiência: 3.8.0 sem preview, 3.8.2 com", () => {
  const governor = governorWith(LIVE_MANIFEST);

  const old = decision(governor, "3.8.0", "preview.embedded");
  assert.equal(old.enabled, false);
  assert.match(old.reason, /3\.8\.2/);

  const current = decision(governor, "3.8.2", "preview.embedded");
  assert.equal(current.enabled, true);

  // recursos por capability: MGCB habilitado nas duas versões
  assert.equal(decision(governor, "3.8.0", "assets.mgcb-compile").enabled, true);
  assert.equal(decision(governor, "3.8.2", "assets.mgcb-compile").enabled, true);
});

test("manifesto vivo participa: subsistema available habilita, ausente desabilita", () => {
  const governor = governorWith(LIVE_MANIFEST);
  const level = decision(governor, "3.8.2", "level.intgrid-editor");
  assert.equal(level.enabled, true);
  assert.equal(level.source, "live-manifest");

  const withoutLevel = governorWith({
    ...LIVE_MANIFEST,
    subsystems: { ...LIVE_MANIFEST.subsystems, level: { status: "planned", phase: 4 } },
  });
  const disabled = decision(withoutLevel, "3.8.2", "level.intgrid-editor");
  assert.equal(disabled.enabled, false);
  assert.match(disabled.reason, /planned/);
});

test("sem engine conectada, regras com requiresSubsystem são fail-safe (desabilitadas)", () => {
  const governor = governorWith(undefined);
  const resolved = governor.resolve("monogame", "3.8.2");
  assert.equal(resolved.liveManifestConsidered, false);

  const lighting = resolved.decisions.find((d) => d.feature === "lighting.deferred-pipeline")!;
  assert.equal(lighting.enabled, false);
  assert.match(lighting.reason, /no engine connected/);

  // recursos que dependem só de capability seguem habilitados
  const hlsl = resolved.decisions.find((d) => d.feature === "shaders.hlsl-editing")!;
  assert.equal(hlsl.enabled, true);
});

// ---------- Adapter + Orquestrador ----------

let pipeCounter = 0;
async function connectFakeEngine(server: EnginePipeServer, calls: Array<{ method: string; params: unknown }>) {
  const socket = net.connect(server.pipePath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const peer = new JsonRpcPeer(socket, { label: "fake-engine", requestTimeoutMs: 2000 });
  let nextLightId = 700;
  peer.registerMethod("engine/describe", () => LIVE_MANIFEST);
  peer.registerMethod("engine/reset_session", (params) => {
    calls.push({ method: "engine/reset_session", params });
    return { status: "reset" };
  });
  peer.registerMethod("camera/configure", (params) => {
    calls.push({ method: "camera/configure", params });
    return params;
  });
  peer.registerMethod("lighting/add", (params) => {
    calls.push({ method: "lighting/add", params });
    return { lightId: nextLightId++ };
  });
  peer.registerMethod("lighting/remove", (params) => {
    calls.push({ method: "lighting/remove", params });
    return { removed: true };
  });
  peer.registerMethod("entity/spawn", (params) => {
    calls.push({ method: "entity/spawn", params });
    return { entityId: (params as { entityId: string }).entityId, status: "spawned" };
  });
  peer.registerMethod("entity/despawn", (params) => {
    calls.push({ method: "entity/despawn", params });
    return { despawned: (params as { entityId: string }).entityId };
  });
  peer.registerMethod("entity/move", (params) => {
    calls.push({ method: "entity/move", params });
    return { entityId: (params as { entityId: string }).entityId, status: "moved" };
  });
  await peer.request("engine/handshake", {
    clientName: "P7m.Engine.Runtime",
    clientVersion: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
  });
  return peer;
}

test("orquestrador: filters → AST → actions → projeção no adapter MonoGame", async () => {
  const server = new EnginePipeServer({ pipeName: `p7m-canon-${process.pid}-${pipeCounter++}`, requestTimeoutMs: 2000 });
  const capabilities = new CapabilityRegistry(server);
  const adapter = new MonoGameAdapter(server, capabilities);
  const store = new BlueprintStore();
  const hooks = new HookBus();
  const orchestrator = new CanonicalOrchestrator(store, hooks, adapter);
  await server.listen();

  try {
    const calls: Array<{ method: string; params: unknown }> = [];
    const engine = await connectFakeEngine(server, calls);
    await new Promise((r) => setTimeout(r, 50)); // describe assíncrono

    // filter intercepta o comando: clamping de intensidade por plugin
    hooks.addFilter("command:light/add", (cmd) => {
      const c = cmd as BlueprintCommand & { kind: "light/add" };
      return { ...c, light: { ...c.light, intensity: Math.min(c.light.intensity, 8) } };
    });
    const observed: string[] = [];
    hooks.addAction("event:lightAdded", () => {
      observed.push("lightAdded");
    });

    const result = await orchestrator.dispatch({
      kind: "light/add",
      light: { lightId: "sun", type: "point", position: [0, 0], color: [1, 1, 1], intensity: 99, radius: 100 },
    });

    assert.equal(result.event.kind, "lightAdded");
    assert.equal(result.projection?.status, "projected");
    assert.deepEqual(observed, ["lightAdded"]);
    // o filter valeu: a engine recebeu 8, e o AST guardou 8
    assert.equal((calls[0]?.params as { intensity: number }).intensity, 8);
    assert.equal(store.getLight("sun")?.intensity, 8);

    // identidade do runtime vivo alimenta a resolução de perfil
    assert.deepEqual(adapter.identify()?.family, "monogame");
    assert.equal(adapter.identify()?.version, "3.8.2");

    // remoção usa o id remapeado da engine
    const removal = await orchestrator.dispatch({ kind: "light/remove", lightId: "sun" });
    assert.equal(removal.projection?.status, "projected");
    assert.deepEqual(calls[1], { method: "lighting/remove", params: { lightId: 700 } });

    engine.close();
  } finally {
    await server.close();
  }
});

test("eventos sem suporte no runtime são pulados com razão; sem sessão, deferred", async () => {
  const server = new EnginePipeServer({ pipeName: `p7m-canon-${process.pid}-${pipeCounter++}`, requestTimeoutMs: 2000 });
  const capabilities = new CapabilityRegistry(server);
  const adapter = new MonoGameAdapter(server, capabilities);
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), adapter);
  await server.listen();

  try {
    // SEM engine conectada: projeção deferred, mas o AST aceita o comando
    const offline = await orchestrator.dispatch({
      kind: "entitydef/define",
      definition: { entityDefId: "chest", fields: [{ name: "gold", type: "int", default: 10 }] },
    });
    assert.equal(offline.projection?.status, "deferred");
    assert.ok(store.getEntityDef("chest"));

    const calls: Array<{ method: string; params: unknown }> = [];
    const engine = await connectFakeEngine(server, calls);
    await new Promise((r) => setTimeout(r, 50));

    // definição SEM archetypeId: entidade é editorial → skipped com razão
    // acionável (o painel de diagnósticos mostra como corrigir)
    const placed = await orchestrator.dispatch({
      kind: "entity/place",
      entity: { entityId: "chest-1", entityDefId: "chest", position: [5, 5], fields: {} },
    });
    assert.equal(placed.projection?.status, "skipped");
    assert.match(placed.projection?.reason ?? "", /archetypeId/);
    assert.equal(calls.length, 0); // nada foi enviado à engine

    engine.close();
  } finally {
    await server.close();
  }
});

test("reset de runtime desconectado é deferred com razão e reidratação não finge sucesso", async () => {
  const server = new EnginePipeServer({
    pipeName: `p7m-canon-${process.pid}-${pipeCounter++}`,
    requestTimeoutMs: 2000,
  });
  const adapter = new MonoGameAdapter(server, new CapabilityRegistry(server));
  const store = new BlueprintStore();
  store.apply({ kind: "camera/configure", settings: { frequency: 3 } });
  store.apply({
    kind: "entitydef/define",
    definition: { entityDefId: "marker", fields: [] },
  });

  const reset = await adapter.resetSession();
  assert.equal(reset.status, "deferred");
  assert.equal(reset.runtimeSessionEpoch, 0);
  assert.match(reset.reason, /no engine session connected/);

  const results = await adapter.rehydrateFrom(store, reset.runtimeSessionEpoch);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    event: "cameraConfigured",
    status: "deferred",
    reason: "no engine session connected",
  });
});

test("reset conectado precede a reidratação e invalida ids locais da sessão anterior", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  let nextLightId = 700;
  const server = {
    currentRuntimeSessionEpoch: 1,
    currentSession: {
      runtimeSessionEpoch: 1,
      peer: {
        request: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          if (method === "lighting/add") return { lightId: nextLightId++ };
          if (method === "engine/reset_session") return { status: "reset" };
          if (method === "lighting/remove") return { removed: true };
          throw new Error(`unexpected fake-engine method: ${method}`);
        },
      },
    },
    on: () => server,
  } as unknown as EnginePipeServer;
  const adapter = new MonoGameAdapter(server, {} as CapabilityRegistry);

  const previous = new BlueprintStore();
  const previousOrchestrator = new CanonicalOrchestrator(previous, new HookBus(), adapter);
  await previousOrchestrator.dispatch({
    kind: "light/add",
    light: {
      lightId: "key",
      type: "point",
      position: [0, 0],
      color: [1, 1, 1],
      intensity: 1,
      radius: 10,
    },
  });

  const reset = await adapter.resetSession();
  assert.equal(reset.status, "reset");

  const active = new BlueprintStore();
  active.apply({
    kind: "light/add",
    light: {
      lightId: "key",
      type: "point",
      position: [1, 2],
      color: [1, 1, 1],
      intensity: 2,
      radius: 20,
    },
  });
  const rehydrated = await adapter.rehydrateFrom(active, reset.runtimeSessionEpoch);
  assert.equal(rehydrated.length, 1);
  assert.equal(rehydrated[0]?.status, "projected");

  const activeOrchestrator = new CanonicalOrchestrator(active, new HookBus(), adapter);
  await activeOrchestrator.dispatch({ kind: "light/remove", lightId: "key" });

  assert.deepEqual(
    calls.map((call) => call.method),
    ["lighting/add", "engine/reset_session", "lighting/add", "lighting/remove"],
  );
  assert.deepEqual(calls.at(-1)?.params, { lightId: 701 });
});

test("rehydrateFrom mantém peer/epoch pinados e não envia a continuação para engine supersessora", async () => {
  let releaseFirstProjection!: () => void;
  const firstProjectionBlocked = new Promise<void>((resolve) => {
    releaseFirstProjection = resolve;
  });
  let projectionStarted!: () => void;
  const enteredFirstProjection = new Promise<void>((resolve) => {
    projectionStarted = resolve;
  });
  const callsB: string[] = [];
  const callsC: string[] = [];
  let epoch = 1;
  const sessionB = {
    runtimeSessionEpoch: 1,
    peer: {
      request: async (method: string): Promise<unknown> => {
        callsB.push(method);
        if (method === "engine/reset_session") return { status: "reset" };
        if (method === "lighting/add") {
          projectionStarted();
          await firstProjectionBlocked;
          return { lightId: 1 };
        }
        throw new Error(`unexpected engine B method: ${method}`);
      },
    },
  };
  const sessionC = {
    runtimeSessionEpoch: 2,
    peer: {
      request: async (method: string): Promise<unknown> => {
        callsC.push(method);
        return method === "lighting/add" ? { lightId: 2 } : { status: "reset" };
      },
    },
  };
  let currentSession = sessionB;
  const server = {
    get currentRuntimeSessionEpoch() {
      return epoch;
    },
    get currentSession() {
      return currentSession;
    },
    on: () => server,
  } as unknown as EnginePipeServer;
  const adapter = new MonoGameAdapter(server, {} as CapabilityRegistry);
  const store = new BlueprintStore();
  for (const id of ["one", "two"]) {
    store.apply({
      kind: "light/add",
      light: {
        lightId: id,
        type: "point",
        position: [0, 0],
        color: [1, 1, 1],
        intensity: 1,
        radius: 10,
      },
    });
  }

  const reset = await adapter.resetSession();
  const rehydrating = adapter.rehydrateFrom(store, reset.runtimeSessionEpoch);
  await enteredFirstProjection;
  epoch = 2;
  currentSession = sessionC;
  releaseFirstProjection();

  await assert.rejects(rehydrating, /expected epoch 1, got 2/);
  assert.deepEqual(callsB, ["engine/reset_session", "lighting/add"]);
  assert.deepEqual(callsC, [], "engine C must receive only a fresh reset+full replay");
});

test("spawn table (P0.6): definição com archetypeId spawna ator; remoção despawna", async () => {
  const server = new EnginePipeServer({ pipeName: `p7m-canon-${process.pid}-${pipeCounter++}`, requestTimeoutMs: 2000 });
  const capabilities = new CapabilityRegistry(server);
  const adapter = new MonoGameAdapter(server, capabilities);
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), adapter);
  await server.listen();

  try {
    const calls: Array<{ method: string; params: unknown }> = [];
    const engine = await connectFakeEngine(server, calls);
    await new Promise((r) => setTimeout(r, 50));

    await orchestrator.dispatch({
      kind: "entitydef/define",
      definition: { entityDefId: "player", archetypeId: "hero", fields: [] },
    });

    // placement projeta entity/spawn com o entityId canônico (referência estável)
    const placed = await orchestrator.dispatch({
      kind: "entity/place",
      entity: { entityId: "player-1", entityDefId: "player", position: [48, 336], fields: {} },
    });
    assert.equal(placed.projection?.status, "projected");
    assert.deepEqual(calls[0], {
      method: "entity/spawn",
      params: { entityId: "player-1", archetypeId: "hero", position: [48, 336] },
    });

    // arrastar no editor: entity/move reposiciona o ator vivo (sem respawn)
    const moved = await orchestrator.dispatch({ kind: "entity/move", entityId: "player-1", position: [96, 320] });
    assert.equal(moved.event.kind, "entityMoved");
    assert.equal(moved.projection?.status, "projected");
    assert.deepEqual(calls[1], { method: "entity/move", params: { entityId: "player-1", position: [96, 320] } });
    assert.deepEqual(store.getEntity("player-1")?.position, [96, 320]);

    // remoção de ator spawnado projeta entity/despawn
    const removed = await orchestrator.dispatch({ kind: "entity/remove", entityId: "player-1" });
    assert.equal(removed.projection?.status, "projected");
    assert.deepEqual(calls[2], { method: "entity/despawn", params: { entityId: "player-1" } });

    // remoção de entidade nunca spawnada é skipped com razão (sem chamada à engine)
    await orchestrator.dispatch({
      kind: "entitydef/define",
      definition: { entityDefId: "marker", fields: [] },
    });
    await orchestrator.dispatch({
      kind: "entity/place",
      entity: { entityId: "marker-1", entityDefId: "marker", position: [0, 0], fields: {} },
    });
    // mover entidade sem archetype também é skipped (sem chamada à engine)
    const movedEditorial = await orchestrator.dispatch({ kind: "entity/move", entityId: "marker-1", position: [3, 3] });
    assert.equal(movedEditorial.projection?.status, "skipped");
    assert.match(movedEditorial.projection?.reason ?? "", /archetypeId/);
    assert.deepEqual(store.getEntity("marker-1")?.position, [3, 3]); // o AST aceitou

    const skipped = await orchestrator.dispatch({ kind: "entity/remove", entityId: "marker-1" });
    assert.equal(skipped.projection?.status, "skipped");
    assert.match(skipped.projection?.reason ?? "", /never spawned/);
    assert.equal(calls.length, 3);

    engine.close();
  } finally {
    await server.close();
  }
});

test("reidratação projeta entidades spawnáveis depois dos níveis", async () => {
  const server = new EnginePipeServer({ pipeName: `p7m-canon-${process.pid}-${pipeCounter++}`, requestTimeoutMs: 2000 });
  const adapter = new MonoGameAdapter(server, new CapabilityRegistry(server));
  const store = new BlueprintStore();
  await server.listen();

  try {
    // Blueprint preenchido OFFLINE (engine caída): só o AST aceita
    store.apply({
      kind: "entitydef/define",
      definition: { entityDefId: "player", archetypeId: "hero", fields: [] },
    });
    store.apply({
      kind: "entity/place",
      entity: { entityId: "player-1", entityDefId: "player", position: [10, 20], fields: {} },
    });
    store.apply({
      kind: "entitydef/define",
      definition: { entityDefId: "marker", fields: [] },
    });
    store.apply({
      kind: "entity/place",
      entity: { entityId: "marker-1", entityDefId: "marker", position: [0, 0], fields: {} },
    });

    const calls: Array<{ method: string; params: unknown }> = [];
    const engine = await connectFakeEngine(server, calls);
    await new Promise((r) => setTimeout(r, 50));

    const results = await adapter.rehydrateFrom(store);
    const spawns = calls.filter((c) => c.method === "entity/spawn");
    assert.equal(spawns.length, 1); // só a definição com archetypeId spawna
    assert.deepEqual(spawns[0]!.params, { entityId: "player-1", archetypeId: "hero", position: [10, 20] });
    // a instância sem archetype aparece como skipped com razão acionável
    const skipped = results.filter((r) => r.status === "skipped");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!.reason ?? "", /archetypeId/);

    engine.close();
  } finally {
    await server.close();
  }
});

test("filter que corrompe o kind do comando é rejeitado", async () => {
  const hooks = new HookBus();
  hooks.addFilter("command:entity/remove", () => ({ kind: "light/remove", lightId: "x" }));
  const orchestrator = new CanonicalOrchestrator(new BlueprintStore(), hooks);
  await assert.rejects(
    orchestrator.dispatch({ kind: "entity/remove", entityId: "e" }),
    /must preserve the command kind/,
  );
});
