import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { EnginePipeServer } from "../src/ipc/EnginePipeServer.js";
import { EngineBridge } from "../src/domain/EngineBridge.js";
import { BlueprintStore, type LightSpec } from "../src/domain/BlueprintStore.js";
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
  peer.registerMethod("camera/shake", (params) => params);
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

async function withBridge(
  fn: (server: EnginePipeServer, bridge: EngineBridge, state: FakeEngineState) => Promise<void>,
): Promise<void> {
  const server = new EnginePipeServer({ pipeName: uniquePipeName(), requestTimeoutMs: 2000 });
  const bridge = new EngineBridge(server, new BlueprintStore());
  const state: FakeEngineState = { nextLightId: 100, added: [], removed: [], cameraConfigs: [] };
  await server.listen();
  try {
    await fn(server, bridge, state);
  } finally {
    await server.close();
  }
}

test("configureCamera acumula merges no AST e envia a config completa à engine", async () => {
  await withBridge(async (server, bridge, state) => {
    const engine = await connectFakeEngine(server, state);
    await bridge.configureCamera({ frequency: 3 });
    await bridge.configureCamera({ damping: 0.5 });

    // o AST acumula; a engine recebe a config consolidada
    assert.deepEqual(bridge.store.cameraSettings, { frequency: 3, damping: 0.5 });
    assert.deepEqual(state.cameraConfigs.at(-1), { frequency: 3, damping: 0.5 });
    engine.close();
  });
});

test("configuração inválida de câmera é rejeitada pelo AST", async () => {
  await withBridge(async (_server, bridge) => {
    await assert.rejects(
      bridge.configureCamera({ frequency: -2 }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );
  });
});

test("addLight registra no AST, envia à engine e mapeia o id", async () => {
  await withBridge(async (server, bridge, state) => {
    const engine = await connectFakeEngine(server, state);
    const result = await bridge.addLight(makeLight("torch"));

    assert.equal(result.lightId, "torch");
    assert.equal(result.engineLightId, 100);
    assert.equal(bridge.store.getLight("torch")?.intensity, 2);
    assert.equal(state.added[0]?.params["type"], "point");
    // o id do blueprint NÃO vaza para a engine
    assert.equal(state.added[0]?.params["lightId"], undefined);
    engine.close();
  });
});

test("luz duplicada e specs inválidas são rejeitadas antes de chegar à engine", async () => {
  await withBridge(async (server, bridge, state) => {
    const engine = await connectFakeEngine(server, state);
    await bridge.addLight(makeLight("dup"));
    await assert.rejects(
      bridge.addLight(makeLight("dup")),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.DuplicateId,
    );
    await assert.rejects(
      bridge.addLight({ ...makeLight("bad-spot"), type: "spot" }), // sem cones
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );
    assert.equal(state.added.length, 1); // só a primeira chegou à engine
    engine.close();
  });
});

test("removeLight usa o id mapeado da engine", async () => {
  await withBridge(async (server, bridge, state) => {
    const engine = await connectFakeEngine(server, state);
    await bridge.addLight(makeLight("lamp"));
    await bridge.removeLight("lamp");

    assert.deepEqual(state.removed, [100]);
    assert.equal(bridge.store.getLight("lamp"), undefined);
    engine.close();
  });
});

test("reconexão reidrata câmera e luzes com ids remapeados", async () => {
  await withBridge(async (server, bridge, state) => {
    const first = await connectFakeEngine(server, state);
    await bridge.configureCamera({ frequency: 4, anticipationSeconds: 0.5 });
    await bridge.addLight(makeLight("torch"));
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
    await bridge.removeLight("torch");
    assert.deepEqual(state.removed, [500]);
    second.close();
  });
});
