import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { EnginePipeServer, type EngineLogEntry, type EngineSession } from "../src/ipc/EnginePipeServer.js";
import { EngineBridge } from "../src/domain/EngineBridge.js";
import { BlueprintStore } from "../src/domain/BlueprintStore.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { CapabilityRegistry } from "../src/domain/CapabilityRegistry.js";
import { MonoGameAdapter } from "../src/runtime/MonoGameAdapter.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../src/protocol/jsonrpc.js";

let pipeCounter = 0;
function uniquePipeName(): string {
  return `p7m-test-${process.pid}-${pipeCounter++}`;
}

/** Cliente TS que se comporta como o host da engine (mesmo contrato do lado C#). */
async function connectFakeEngine(server: EnginePipeServer): Promise<JsonRpcPeer> {
  const socket = net.connect(server.pipePath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const peer = new JsonRpcPeer(socket, { label: "fake-engine", requestTimeoutMs: 2000 });
  peer.registerMethod("engine/ping", (params) => {
    const { payload } = params as { payload: string };
    return { echo: payload, receivedAtUnixMs: Date.now() };
  });
  peer.registerMethod("skeleton/initialize", (params) => {
    const { skeletonId, bones } = params as { skeletonId: string; bones: unknown[] };
    return { skeletonId, boneCount: bones.length, status: "initialized" };
  });
  peer.registerMethod("mesh/bind_shared_memory", (params) => {
    const { meshId, vertexCount, strideInBytes } = params as {
      meshId: string;
      vertexCount: number;
      strideInBytes: number;
    };
    return { meshId, mappedBytes: vertexCount * strideInBytes, status: "bound" };
  });
  return peer;
}

interface Stack {
  server: EnginePipeServer;
  bridge: EngineBridge;
  store: BlueprintStore;
  orchestrator: CanonicalOrchestrator;
  adapter: MonoGameAdapter;
}

async function withServer(fn: (stack: Stack) => Promise<void>): Promise<void> {
  const server = new EnginePipeServer({
    pipeName: uniquePipeName(),
    supportedCapabilities: ["skeleton", "mesh", "shared-memory"],
    requestTimeoutMs: 2000,
  });
  const store = new BlueprintStore();
  const bridge = new EngineBridge(server, store);
  const adapter = new MonoGameAdapter(server, new CapabilityRegistry(server));
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), adapter);
  await server.listen();
  try {
    await fn({ server, bridge, store, orchestrator, adapter });
  } finally {
    await server.close();
  }
}

test("handshake válido estabelece sessão e devolve identidade", async () => {
  await withServer(async ({ server }) => {
    const engine = await connectFakeEngine(server);
    const result = await engine.request<{
      sessionId: string;
      serverName: string;
      protocolVersion: string;
      acceptedCapabilities: string[];
    }>("engine/handshake", {
      clientName: "P7m.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: ["skeleton", "raytracing"],
    });
    assert.equal(result.serverName, "p7m-middleware");
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.ok(result.sessionId.length > 0);
    // capacidades não suportadas pelo middleware são filtradas
    assert.deepEqual(result.acceptedCapabilities, ["skeleton"]);
    assert.equal(server.currentSession?.clientName, "P7m.Engine.Runtime");
    engine.close();
  });
});

test("versão MAJOR incompatível é recusada com PROTOCOL_MISMATCH", async () => {
  await withServer(async ({ server }) => {
    const engine = await connectFakeEngine(server);
    await assert.rejects(
      engine.request("engine/handshake", {
        clientName: "P7m.Engine.Runtime",
        clientVersion: "0.1.0",
        protocolVersion: "2.0",
      }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.ProtocolMismatch,
    );
    assert.equal(server.currentSession, undefined);
    engine.close();
  });
});

test("fluxo bidirecional: middleware pinga a engine e recebe logs dela", async () => {
  await withServer(async ({ server, bridge }) => {
    const logReceived = new Promise<EngineLogEntry>((resolve) => {
      server.once("engineLog", (_s: EngineSession, entry: EngineLogEntry) => resolve(entry));
    });
    const engine = await connectFakeEngine(server);
    await engine.request("engine/handshake", {
      clientName: "P7m.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    // direção middleware → engine (request)
    const pong = await bridge.pingEngine("marco");
    assert.equal(pong.echo, "marco");

    // direção engine → middleware (notification)
    engine.notify("engine/log", { level: "info", message: "frame pacing ok", category: "runtime" });
    const entry = await logReceived;
    assert.equal(entry.message, "frame pacing ok");
    engine.close();
  });
});

test("skeleton/define e mesh/bind percorrem o caminho canônico até a engine", async () => {
  await withServer(async ({ server, store, orchestrator }) => {
    const engine = await connectFakeEngine(server);
    await engine.request("engine/handshake", {
      clientName: "P7m.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    const identity = [1, 0, 0, 1, 0, 0];
    const skeleton = await orchestrator.dispatch({
      kind: "skeleton/define",
      skeleton: {
        skeletonId: "hero-rig",
        bones: [
          { id: 0, parentId: -1, inverseBindMatrix: identity },
          { id: 1, parentId: 0, inverseBindMatrix: identity },
        ],
      },
    });
    assert.equal(skeleton.projection?.status, "projected");
    assert.deepEqual(skeleton.projection?.detail, {
      skeletonId: "hero-rig",
      boneCount: 2,
      status: "initialized",
    });

    const mesh = await orchestrator.dispatch({
      kind: "mesh/bind",
      binding: {
        meshId: "hero-mesh",
        skeletonId: "hero-rig",
        sharedMemoryMapName: "p7m-mesh-hero",
        vertexCount: 128,
        strideInBytes: 32,
      },
    });
    assert.deepEqual(mesh.projection?.detail, { meshId: "hero-mesh", mappedBytes: 4096, status: "bound" });

    // Projeções do AST refletem os comandos aplicados
    assert.equal(store.getSkeleton("hero-rig")?.bones.length, 2);
    assert.equal(store.getMesh("hero-mesh")?.vertexCount, 128);
    engine.close();
  });
});

test("comandos sem engine conectada ficam no AST e são reidratados na conexão", async () => {
  await withServer(async ({ server, bridge, store, orchestrator, adapter }) => {
    // Reidratação canônica: o adapter projeta o Blueprint em cada sessão nova
    // (mesma fiação do composition root em src/index.ts).
    server.on("session", () => void adapter.rehydrateFrom(store));

    const identity = [1, 0, 0, 1, 0, 0];
    // Comando aplicado com a engine offline: fica registrado no blueprint.
    const offline = await orchestrator.dispatch({
      kind: "skeleton/define",
      skeleton: {
        skeletonId: "npc-rig",
        bones: [{ id: 0, parentId: -1, inverseBindMatrix: identity }],
      },
    });
    assert.equal(offline.projection?.status, "deferred");
    assert.ok(store.getSkeleton("npc-rig"));

    // A engine conecta depois; o adapter deve reenviar skeleton/initialize.
    const socket = net.connect(server.pipePath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const engine = new JsonRpcPeer(socket, { label: "late-engine", requestTimeoutMs: 2000 });
    engine.registerMethod("engine/ping", (params) => ({ echo: (params as { payload: string }).payload }));
    const rehydrated = new Promise<string>((resolve) => {
      engine.registerMethod("skeleton/initialize", (params) => {
        const { skeletonId, bones } = params as { skeletonId: string; bones: unknown[] };
        resolve(skeletonId);
        return { skeletonId, boneCount: bones.length, status: "initialized" };
      });
    });
    await engine.request("engine/handshake", {
      clientName: "P7m.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    assert.equal(await rehydrated, "npc-rig");
    const pong = await bridge.pingEngine("pós-reidratação");
    assert.equal(pong.echo, "pós-reidratação");
    engine.close();
  });
});

test("comandos inválidos são rejeitados pelo AST antes de chegar à engine", async () => {
  await withServer(async ({ orchestrator }) => {
    const identity = [1, 0, 0, 1, 0, 0];
    await assert.rejects(
      orchestrator.dispatch({
        kind: "mesh/bind",
        binding: {
          meshId: "orphan",
          skeletonId: "inexistente",
          sharedMemoryMapName: "map",
          vertexCount: 1,
          strideInBytes: 4,
        },
      }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.UnknownSkeleton,
    );
    const defineDup = () =>
      orchestrator.dispatch({
        kind: "skeleton/define",
        skeleton: { skeletonId: "dup", bones: [{ id: 0, parentId: -1, inverseBindMatrix: identity }] },
      });
    await defineDup();
    await assert.rejects(
      defineDup(),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.DuplicateId,
    );
  });
});
