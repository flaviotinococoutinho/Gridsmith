import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { EnginePipeServer } from "../src/ipc/EnginePipeServer.js";
import { BlueprintStore, type LightSpec } from "../src/domain/BlueprintStore.js";
import { CapabilityRegistry } from "../src/domain/CapabilityRegistry.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { MonoGameAdapter } from "../src/runtime/MonoGameAdapter.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../src/protocol/jsonrpc.js";

let pipeCounter = 0;
function uniquePipeName(): string {
  return `p7m-test-cam-${process.pid}-${pipeCounter++}`;
}

interface FakeEngineState {
  nextLightId: number;
  added: Array<{ engineId: number; params: Record<string, unknown> }>;
  removed: number[];
  cameraConfigs: unknown[];
}

/** Engine falsa que implementa os handlers de câmera/iluminação da Fase 3. */
async function connectFakeEngine(
  server: EnginePipeServer,
  state: FakeEngineState,
): Promise<JsonRpcPeer> {
  const socket = net.connect(server.pipePath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const peer = new JsonRpcPeer(socket, { label: "fake-engine", requestTimeoutMs: 2000 });
  peer.registerMethod("camera/configure", (params) => {
    state.cameraConfigs.push(params);
    return params;
  });
  peer.registerMethod("lighting/add", (params) => {
    const engineId = state.nextLightId++;
    state.added.push({ engineId, params: params as Record<string, unknown> });
    return { lightId: engineId };
  });
  peer.registerMethod("lighting/remove", (params) => {
    const { lightId } = params as { lightId: number };
    state.removed.push(lightId);
    return { removed: lightId };
  });
  await peer.request("engine/handshake", {
    clientName: "P7m.Engine.Runtime",
    clientVersion: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
  });
  return peer;
}

function makeLight(id: string): LightSpec {
  return {
    lightId: id,
    type: "point",
    position: [10, 20],
    height: 50,
    color: [1, 0.5, 0.25],
    intensity: 2,
    radius: 100,
  };
}

interface Stack {
  server: EnginePipeServer;
  store: BlueprintStore;
  orchestrator: CanonicalOrchestrator;
  adapter: MonoGameAdapter;
  state: FakeEngineState;
}

async function withStack(fn: (stack: Stack) => Promise<void>): Promise<void> {
  const server = new EnginePipeServer({ pipeName: uniquePipeName(), requestTimeoutMs: 2000 });
  const store = new BlueprintStore();
  const adapter = new MonoGameAdapter(server, new CapabilityRegistry(server));
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), adapter);
  const state: FakeEngineState = { nextLightId: 100, added: [], removed: [], cameraConfigs: [] };
  await server.listen();
  try {
    await fn({ server, store, orchestrator, adapter, state });
  } finally {
    await server.close();
  }
}

test("camera/configure acumula merges no AST e projeta a config na engine", async () => {
  await withStack(async ({ server, store, orchestrator, state }) => {
    const engine = await connectFakeEngine(server, state);
    await orchestrator.dispatch({ kind: "camera/configure", settings: { frequency: 3 } });
    await orchestrator.dispatch({ kind: "camera/configure", settings: { damping: 0.5 } });

    // o AST acumula; a engine recebe a config consolidada em cada projeção
    assert.deepEqual(store.cameraSettings, { frequency: 3, damping: 0.5 });
    assert.deepEqual(state.cameraConfigs.at(-1), { frequency: 3, damping: 0.5 });
    engine.close();
  });
});

test("undo de camera/configure substitui a config da engine e remove campos posteriores", async () => {
  await withStack(async ({ server, store, orchestrator, state }) => {
    const engine = await connectFakeEngine(server, state);
    await orchestrator.dispatch({ kind: "camera/configure", settings: { frequency: 3 } });
    const changed = await orchestrator.dispatch({ kind: "camera/configure", settings: { damping: 0.5 } });

    await orchestrator.undo(changed.historyCursor);

    assert.deepEqual(store.cameraSettings, { frequency: 3 });
    assert.deepEqual(state.cameraConfigs.at(-1), { frequency: 3, replace: true });
    engine.close();
  });
});

test("configuração inválida de câmera é rejeitada pelo AST", async () => {
  await withStack(async ({ orchestrator }) => {
    await assert.rejects(
      orchestrator.dispatch({ kind: "camera/configure", settings: { frequency: -2 } }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );
  });
});

test("light/add registra no AST, projeta na engine e mapeia o id", async () => {
  await withStack(async ({ server, store, orchestrator, state }) => {
    const engine = await connectFakeEngine(server, state);
    const result = await orchestrator.dispatch({ kind: "light/add", light: makeLight("torch") });

    assert.equal(result.projection?.status, "projected");
    assert.equal(store.getLight("torch")?.intensity, 2);
    assert.equal(state.added[0]?.params["type"], "point");
    // o id do blueprint NÃO vaza para a engine
    assert.equal(state.added[0]?.params["lightId"], undefined);
    engine.close();
  });
});

test("luz duplicada e specs inválidas são rejeitadas antes de chegar à engine", async () => {
  await withStack(async ({ server, orchestrator, state }) => {
    const engine = await connectFakeEngine(server, state);
    await orchestrator.dispatch({ kind: "light/add", light: makeLight("dup") });
    await assert.rejects(
      orchestrator.dispatch({ kind: "light/add", light: makeLight("dup") }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.DuplicateId,
    );
    await assert.rejects(
      orchestrator.dispatch({ kind: "light/add", light: { ...makeLight("bad-spot"), type: "spot" } }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );
    assert.equal(state.added.length, 1); // só a primeira chegou à engine
    engine.close();
  });
});

test("light/remove usa o id mapeado da engine", async () => {
  await withStack(async ({ server, store, orchestrator, state }) => {
    const engine = await connectFakeEngine(server, state);
    await orchestrator.dispatch({ kind: "light/add", light: makeLight("lamp") });
    await orchestrator.dispatch({ kind: "light/remove", lightId: "lamp" });

    assert.deepEqual(state.removed, [100]);
    assert.equal(store.getLight("lamp"), undefined);
    engine.close();
  });
});

test("reconexão reidrata câmera e luzes com ids remapeados (adapter)", async () => {
  await withStack(async ({ server, store, orchestrator, adapter, state }) => {
    // mesma fiação do composition root: adapter reidrata em cada sessão nova
    server.on("session", () => void adapter.rehydrateFrom(store));

    const first = await connectFakeEngine(server, state);
    await orchestrator.dispatch({
      kind: "camera/configure",
      settings: { frequency: 4, anticipationSeconds: 0.5 },
    });
    await orchestrator.dispatch({ kind: "light/add", light: makeLight("torch") });
    first.close();
    await new Promise((r) => setTimeout(r, 50));

    // engine "reiniciada": ids novos a partir de 500
    state.nextLightId = 500;
    const second = await connectFakeEngine(server, state);
    await new Promise((r) => setTimeout(r, 100)); // reidratação assíncrona

    // a câmera foi reconfigurada e a luz re-adicionada na sessão nova
    assert.deepEqual(state.cameraConfigs.at(-1), { frequency: 4, anticipationSeconds: 0.5 });
    assert.equal(state.added.length, 2);
    assert.equal(state.added.at(-1)?.engineId, 500);

    // remoção pós-reconexão usa o id REMAPEADO
    await orchestrator.dispatch({ kind: "light/remove", lightId: "torch" });
    assert.deepEqual(state.removed, [500]);
    second.close();
  });
});
