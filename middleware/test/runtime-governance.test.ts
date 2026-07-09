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

    // domínio editorial: runtime não tem spawn tables ainda → skipped com razão
    const placed = await orchestrator.dispatch({
      kind: "entity/place",
      entity: { entityId: "chest-1", entityDefId: "chest", position: [5, 5], fields: {} },
    });
    assert.equal(placed.projection?.status, "skipped");
    assert.match(placed.projection?.reason ?? "", /phase 4/);
    assert.equal(calls.length, 0); // nada foi enviado à engine

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
