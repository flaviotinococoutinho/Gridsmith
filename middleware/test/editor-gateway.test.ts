import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { EditorGateway } from "../src/ipc/EditorGateway.js";
import { EnginePipeServer } from "../src/ipc/EnginePipeServer.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { BlueprintStore, type BlueprintEvent } from "../src/domain/BlueprintStore.js";
import { CapabilityRegistry, type EngineManifest } from "../src/domain/CapabilityRegistry.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { ExperienceGovernor } from "../src/runtime/ExperienceGovernor.js";
import { MonoGameAdapter } from "../src/runtime/MonoGameAdapter.js";
import { RuntimeProfileRegistry } from "../src/runtime/RuntimeProfile.js";
import { MONOGAME_PROFILES } from "../src/runtime/profiles/monogame.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../src/protocol/jsonrpc.js";

let pipeCounter = 0;

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
  },
};

interface Harness {
  gateway: EditorGateway;
  engineServer: EnginePipeServer;
  store: BlueprintStore;
  engineCalls: Array<{ method: string; params: unknown }>;
  connectEditor(name?: string): Promise<JsonRpcPeer>;
  connectEngine(): Promise<JsonRpcPeer>;
  close(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const pipeName = `p7m-edgw-${process.pid}-${pipeCounter++}`;
  const engineServer = new EnginePipeServer({ pipeName, requestTimeoutMs: 2000 });
  const capabilities = new CapabilityRegistry(engineServer);
  const adapter = new MonoGameAdapter(engineServer, capabilities);
  const store = new BlueprintStore();
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const gateway = new EditorGateway({
    pipeName,
    orchestrator: new CanonicalOrchestrator(store, new HookBus(), adapter),
    store,
    governor: new ExperienceGovernor(profiles, capabilities),
    adapter,
    requestTimeoutMs: 2000,
  });
  await engineServer.listen();
  await gateway.listen();

  const engineCalls: Array<{ method: string; params: unknown }> = [];

  async function connect(path: string, label: string): Promise<JsonRpcPeer> {
    const socket = net.connect(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new JsonRpcPeer(socket, { label, requestTimeoutMs: 2000 });
  }

  return {
    gateway,
    engineServer,
    store,
    engineCalls,
    async connectEditor(name = "electron-editor") {
      const peer = await connect(gateway.pipePath, name);
      await peer.request("editor/handshake", { clientName: name, protocolVersion: PROTOCOL_VERSION });
      return peer;
    },
    async connectEngine() {
      const peer = await connect(engineServer.pipePath, "fake-engine");
      let nextLightId = 300;
      peer.registerMethod("engine/describe", () => LIVE_MANIFEST);
      peer.registerMethod("lighting/add", (params) => {
        engineCalls.push({ method: "lighting/add", params });
        return { lightId: nextLightId++ };
      });
      peer.registerMethod("camera/configure", (params) => {
        engineCalls.push({ method: "camera/configure", params });
        return params;
      });
      await peer.request("engine/handshake", {
        clientName: "P7m.Engine.Runtime",
        clientVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      });
      await new Promise((r) => setTimeout(r, 50)); // engine/describe assíncrono
      return peer;
    },
    async close() {
      await gateway.close();
      await engineServer.close();
    },
  };
}

test("dispatch do editor percorre o caminho canônico até a engine e faz broadcast", async () => {
  const h = await makeHarness();
  try {
    const engine = await h.connectEngine();
    const editorA = await h.connectEditor("editor-a");
    const editorB = await h.connectEditor("editor-b");

    const broadcastToB = new Promise<BlueprintEvent>((resolve) => {
      // notifications sem handler são descartadas pelo peer: registra o receptor
      editorB.registerMethod("blueprint/event", (params) => resolve(params as BlueprintEvent));
    });

    const result = (await editorA.request("blueprint/dispatch", {
      kind: "light/add",
      payload: { lightId: "torch", type: "point", position: [4, 2], color: [1, 1, 1], intensity: 2, radius: 64 },
    })) as { event: BlueprintEvent; projection: { status: string } };

    assert.equal(result.event.kind, "lightAdded");
    assert.equal(result.projection.status, "projected");
    // a engine recebeu a projeção do comando do editor
    assert.equal(h.engineCalls[0]?.method, "lighting/add");
    // o OUTRO editor recebeu o evento por broadcast (coerência multi-janela)
    const broadcast = await broadcastToB;
    assert.equal(broadcast.kind, "lightAdded");

    // projeção de leitura reflete o AST
    const lights = (await editorB.request("blueprint/query", { projection: "lights" })) as {
      lights: Array<{ lightId: string }>;
    };
    assert.equal(lights.lights[0]?.lightId, "torch");

    editorA.close();
    editorB.close();
    engine.close();
  } finally {
    await h.close();
  }
});

test("experience/resolve usa a identidade do runtime conectado", async () => {
  const h = await makeHarness();
  try {
    const engine = await h.connectEngine();
    const editor = await h.connectEditor();

    const experience = (await editor.request("experience/resolve", {})) as {
      family: string;
      profileVersion: string;
      liveManifestConsidered: boolean;
      decisions: Array<{ feature: string; enabled: boolean }>;
    };

    assert.equal(experience.family, "monogame");
    assert.equal(experience.profileVersion, "3.8.2"); // identidade veio do describe
    assert.equal(experience.liveManifestConsidered, true);
    const preview = experience.decisions.find((d) => d.feature === "preview.embedded");
    assert.equal(preview?.enabled, true);

    // versão explícita sobrepõe: 3.8.0 desabilita o preview
    const older = (await editor.request("experience/resolve", { version: "3.8.0" })) as {
      decisions: Array<{ feature: string; enabled: boolean }>;
    };
    assert.equal(older.decisions.find((d) => d.feature === "preview.embedded")?.enabled, false);

    editor.close();
    engine.close();
  } finally {
    await h.close();
  }
});

test("comandos inválidos e chamadas sem handshake são rejeitados", async () => {
  const h = await makeHarness();
  try {
    // sem handshake
    const socket = net.connect(h.gateway.pipePath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const rude = new JsonRpcPeer(socket, { label: "rude", requestTimeoutMs: 2000 });
    await assert.rejects(
      rude.request("blueprint/query", { projection: "lights" }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.EngineNotReady,
    );
    rude.close();

    const editor = await h.connectEditor();
    await assert.rejects(
      editor.request("blueprint/dispatch", { kind: "not/a-command", payload: {} }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );
    await assert.rejects(
      editor.request("blueprint/query", { projection: "secrets" }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );
    // erro de domínio do AST propaga tipado (validação do comando)
    await assert.rejects(
      editor.request("blueprint/dispatch", {
        kind: "light/add",
        payload: { lightId: "bad", type: "point", color: [1, 1, 1], intensity: -5 },
      }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );
    editor.close();
  } finally {
    await h.close();
  }
});

test("dispatch offline: AST aceita, projeção deferred, broadcast acontece", async () => {
  const h = await makeHarness();
  try {
    const editor = await h.connectEditor();
    const events: string[] = [];
    editor.registerMethod("blueprint/event", (params) => {
      events.push((params as BlueprintEvent).kind);
    });

    const result = (await editor.request("blueprint/dispatch", {
      kind: "camera/configure",
      payload: { frequency: 3 },
    })) as { projection: { status: string; reason?: string } };

    assert.equal(result.projection.status, "deferred");
    assert.match(result.projection.reason ?? "", /no engine session/);
    assert.deepEqual(h.store.cameraSettings, { frequency: 3 });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, ["cameraConfigured"]);
    editor.close();
  } finally {
    await h.close();
  }
});

test("project/templates lista o Plataforma 2D e project/new o reproduz no AST", async () => {
  const h = await makeHarness();
  try {
    const editor = await h.connectEditor();

    const { templates } = (await editor.request("project/templates", {})) as {
      templates: Array<{ id: string; label: string }>;
    };
    assert.ok(templates.some((t) => t.id === "platformer-2d"));

    const summary = (await editor.request("project/new", { templateId: "platformer-2d" })) as {
      templateId: string;
      applied: number;
    };
    assert.equal(summary.templateId, "platformer-2d");
    assert.equal(summary.applied, 6);

    const levels = (await editor.request("blueprint/query", { projection: "levels" })) as {
      levels: Array<{ levelId: string }>;
    };
    assert.equal(levels.levels[0]?.levelId, "level-1");
    const entities = (await editor.request("blueprint/query", { projection: "entities" })) as {
      entities: Array<{ entityId: string }>;
    };
    assert.equal(entities.entities[0]?.entityId, "player-1");

    editor.close();
  } finally {
    await h.close();
  }
});

test("project/new recusa template desconhecido e exige blueprint vazio", async () => {
  const h = await makeHarness();
  try {
    const editor = await h.connectEditor();

    await assert.rejects(
      editor.request("project/new", { templateId: "inexistente" }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );

    await editor.request("project/new", { templateId: "platformer-2d" });
    // segundo new falha: o blueprint já não está vazio
    await assert.rejects(
      editor.request("project/new", { templateId: "platformer-2d" }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );

    editor.close();
  } finally {
    await h.close();
  }
});
