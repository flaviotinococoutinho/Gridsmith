import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { EnginePipeServer } from "../src/ipc/EnginePipeServer.js";
import { CapabilityRegistry, type EngineManifest } from "../src/domain/CapabilityRegistry.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { PROTOCOL_VERSION } from "../src/protocol/jsonrpc.js";

let pipeCounter = 0;
function uniquePipeName(): string {
  return `p7m-test-caps-${process.pid}-${pipeCounter++}`;
}

/** Manifesto no formato que a engine C# publica (EngineDescriptor). */
const FAKE_MANIFEST: EngineManifest = {
  engine: { name: "P7m.Engine.Runtime", version: "0.1.0", protocolVersion: "1.0" },
  subsystems: {
    rigging: {
      status: "available",
      limits: { maxSkeletons: 64, maxBonesPerSkeleton: 256 },
      features: ["linear-blend-skinning"],
      editor: {
        panel: "rig-editor",
        gizmos: ["bone", "ik-chain"],
        nodeTypes: ["skeleton", "bone"],
        properties: [{ name: "boneLength", type: "float", min: 0, max: 4096, default: 32 }],
      },
    },
    sharedMemory: {
      status: "available",
      vertexLayouts: [
        {
          name: "SkinnedVertex2D",
          layoutVersion: 1,
          strideInBytes: 36,
          fields: [
            { name: "position", offset: 0, type: "float2" },
            { name: "uv", offset: 8, type: "float2" },
            { name: "boneIndices", offset: 16, type: "byte4" },
            { name: "boneWeights", offset: 20, type: "float4" },
          ],
        },
      ],
    },
    lighting: { status: "planned", phase: 3, features: ["deferred-2d"] },
  },
};

async function connectFakeEngine(server: EnginePipeServer): Promise<JsonRpcPeer> {
  const socket = net.connect(server.pipePath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const peer = new JsonRpcPeer(socket, { label: "fake-engine", requestTimeoutMs: 2000 });
  peer.registerMethod("engine/describe", () => FAKE_MANIFEST);
  await peer.request("engine/handshake", {
    clientName: "P7m.Engine.Runtime",
    clientVersion: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
  });
  return peer;
}

test("registry pede engine/describe na sessão e cacheia o manifesto", async () => {
  const server = new EnginePipeServer({ pipeName: uniquePipeName(), requestTimeoutMs: 2000 });
  const registry = new CapabilityRegistry(server);
  await server.listen();
  try {
    const engine = await connectFakeEngine(server);
    const manifest = await registry.waitForManifest(2000);
    assert.equal(manifest.engine.name, "P7m.Engine.Runtime");
    assert.equal(registry.manifest, manifest);
    engine.close();
  } finally {
    await server.close();
  }
});

test("findVertexLayout localiza o layout publicado pela engine", async () => {
  const server = new EnginePipeServer({ pipeName: uniquePipeName(), requestTimeoutMs: 2000 });
  const registry = new CapabilityRegistry(server);
  await server.listen();
  try {
    const engine = await connectFakeEngine(server);
    await registry.waitForManifest(2000);

    const layout = registry.findVertexLayout("SkinnedVertex2D");
    assert.ok(layout);
    assert.equal(layout.strideInBytes, 36);
    assert.equal(layout.fields.find((f) => f.name === "boneWeights")?.offset, 20);
    assert.equal(registry.findVertexLayout("Inexistente"), undefined);
    engine.close();
  } finally {
    await server.close();
  }
});

test("editorConcepts projeta painéis, gizmos e nós para a edição visual", async () => {
  const server = new EnginePipeServer({ pipeName: uniquePipeName(), requestTimeoutMs: 2000 });
  const registry = new CapabilityRegistry(server);
  await server.listen();
  try {
    const engine = await connectFakeEngine(server);
    await registry.waitForManifest(2000);

    const concepts = registry.editorConcepts();
    const rigging = concepts.find((c) => c.subsystem === "rigging");
    assert.ok(rigging);
    assert.equal(rigging.status, "available");
    assert.equal(rigging.panel, "rig-editor");
    assert.deepEqual(rigging.gizmos, ["bone", "ik-chain"]);
    assert.equal(rigging.properties[0]?.name, "boneLength");
    assert.equal(rigging.limits["maxBonesPerSkeleton"], 256);

    // subsistemas "planned" aparecem com a fase — a UI mostra como preview
    const lighting = concepts.find((c) => c.subsystem === "lighting");
    assert.equal(lighting?.status, "planned");
    assert.equal(lighting?.phase, 3);
    engine.close();
  } finally {
    await server.close();
  }
});

test("engine sem engine/describe não derruba o middleware (describeError)", async () => {
  const server = new EnginePipeServer({ pipeName: uniquePipeName(), requestTimeoutMs: 500 });
  const registry = new CapabilityRegistry(server);
  await server.listen();
  try {
    const failed = new Promise<Error>((resolve) => registry.once("describeError", resolve));
    const socket = net.connect(server.pipePath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const peer = new JsonRpcPeer(socket, { label: "legacy-engine", requestTimeoutMs: 2000 });
    // engine "antiga": faz handshake mas não implementa engine/describe
    await peer.request("engine/handshake", {
      clientName: "Legacy",
      clientVersion: "0.0.1",
      protocolVersion: PROTOCOL_VERSION,
    });

    const err = await failed;
    assert.match(err.message, /Method not found/);
    assert.equal(registry.manifest, undefined);
    peer.close();
  } finally {
    await server.close();
  }
});
