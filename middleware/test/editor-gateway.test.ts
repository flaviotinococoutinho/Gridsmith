import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { EditorGateway } from "../src/ipc/EditorGateway.js";
import { EnginePipeServer } from "../src/ipc/EnginePipeServer.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import type { BlueprintEvent, BlueprintStore } from "../src/domain/BlueprintStore.js";
import { CapabilityRegistry, type EngineManifest } from "../src/domain/CapabilityRegistry.js";
import { EditorSurface } from "../src/canonical/EditorSurface.js";
import { HookBus } from "../src/canonical/HookBus.js";
import {
  ProjectSessionManager,
  type ProjectSessionChangedEvent,
  type SessionBlueprintEvent,
} from "../src/canonical/ProjectSessionManager.js";
import { ExperienceGovernor } from "../src/runtime/ExperienceGovernor.js";
import { MonoGameAdapter } from "../src/runtime/MonoGameAdapter.js";
import { RuntimeProfileRegistry } from "../src/runtime/RuntimeProfile.js";
import { MONOGAME_PROFILES } from "../src/runtime/profiles/monogame.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../src/protocol/jsonrpc.js";
import { generateTransportAuthToken } from "../src/transport/auth.js";
import { EventJournal } from "../src/transport/EventJournal.js";

let pipeCounter = 0;
const AUTH_TOKEN = generateTransportAuthToken();

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
  readonly store: BlueprintStore;
  sessions: ProjectSessionManager;
  engineCalls: Array<{ method: string; params: unknown }>;
  connectEditor(name?: string): Promise<JsonRpcPeer>;
  connectEngine(): Promise<JsonRpcPeer>;
  close(): Promise<void>;
}

interface SessionEventEnvelope {
  readonly seq: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly commandSequence: string;
  readonly transactionId?: string;
  readonly documentStateId?: string;
  readonly historyEntryId?: string;
  readonly actor?: "human" | "agent" | "pipeline";
  readonly historyAction?: "apply" | "undo" | "redo";
  readonly historyCursor?: string;
  readonly kind: string;
  readonly payload: BlueprintEvent | ProjectSessionChangedEvent;
}

async function makeHarness(): Promise<Harness> {
  const pipeName = `p7m-edgw-${process.pid}-${pipeCounter++}`;
  const engineServer = new EnginePipeServer({ pipeName, requestTimeoutMs: 2000 });
  const capabilities = new CapabilityRegistry(engineServer);
  const adapter = new MonoGameAdapter(engineServer, capabilities);
  const sessions = new ProjectSessionManager({ hooks: new HookBus(), adapter });
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const surface = new EditorSurface({
    sessions,
    governor: new ExperienceGovernor(profiles, capabilities),
    adapter,
  });
  const journal = new EventJournal(512, "editor-gateway-test");
  await sessions.activate(sessions.createEmptySession("initial-project"));
  const initial = sessions.status;
  journal.activateSession(initial.projectSessionId!, initial.projectId!, initial.commandSequence);
  sessions.on("event", (event: SessionBlueprintEvent) => {
    journal.appendForSession(
      event.projectSessionId,
      event.projectId,
      event.commandSequence,
      event.kind,
      event,
    );
  });
  sessions.on("sessionChanged", (event: ProjectSessionChangedEvent) => {
    if (event.action === "activated") {
      journal.activateSession(event.projectSessionId!, event.projectId!, event.commandSequence);
      journal.appendForSession(
        event.projectSessionId!,
        event.projectId!,
        event.commandSequence,
        event.kind,
        event,
      );
      return;
    }
    const previous = journal.position;
    journal.appendForSession(
      previous.projectSessionId,
      previous.projectId,
      previous.commandSequence,
      event.kind,
      event,
    );
    journal.deactivateSession();
  });
  const gateway = new EditorGateway({
    pipeName,
    surface,
    journal,
    authToken: AUTH_TOKEN,
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
    get store() {
      return sessions.current!.store;
    },
    sessions,
    engineCalls,
    async connectEditor(name = "electron-editor") {
      const peer = await connect(gateway.pipePath, name);
      await peer.request("editor/handshake", {
        clientName: name,
        protocolVersion: PROTOCOL_VERSION,
        authToken: AUTH_TOKEN,
      });
      return peer;
    },
    async connectEngine() {
      const peer = await connect(engineServer.pipePath, "fake-engine");
      let nextLightId = 300;
      peer.registerMethod("engine/describe", () => LIVE_MANIFEST);
      peer.registerMethod("engine/reset_session", () => ({ status: "reset" }));
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

    const broadcastToB = new Promise<SessionEventEnvelope>((resolve) => {
      // notifications sem handler são descartadas pelo peer: registra o receptor
      editorB.registerMethod("blueprint/event", (params) =>
        resolve(params as SessionEventEnvelope));
    });

    const result = (await editorA.request("blueprint/dispatch", {
      kind: "light/add",
      payload: { lightId: "torch", type: "point", position: [4, 2], color: [1, 1, 1], intensity: 2, radius: 64 },
    })) as {
      event: BlueprintEvent;
      projection: { status: string };
      commandSequence: string;
    };

    assert.equal(result.event.kind, "lightAdded");
    assert.equal(result.projection.status, "projected");
    assert.equal(result.commandSequence, "1");
    // a engine recebeu a projeção do comando do editor
    assert.equal(h.engineCalls[0]?.method, "lighting/add");
    // o OUTRO editor recebeu o evento por broadcast (coerência multi-janela)
    const broadcast = await broadcastToB;
    assert.equal(broadcast.kind, "lightAdded");
    assert.equal(broadcast.projectSessionId, h.sessions.current?.sessionId);
    assert.equal(broadcast.commandSequence, "1");

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

test("gateway legado exige o mesmo token efêmero antes de liberar a superfície canônica", async () => {
  const h = await makeHarness();
  try {
    const socket = net.connect(h.gateway.pipePath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const peer = new JsonRpcPeer(socket, { label: "unauthenticated", requestTimeoutMs: 2000 });
    await assert.rejects(
      peer.request("editor/handshake", {
        clientName: "unauthenticated",
        protocolVersion: PROTOCOL_VERSION,
        authToken: generateTransportAuthToken(),
      }),
      (err: unknown) =>
        err instanceof JsonRpcError && err.code === RpcErrorCode.AuthenticationFailed,
    );
    await assert.rejects(
      peer.request("blueprint/query", { projection: "document" }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.EngineNotReady,
    );
    peer.close();
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
      events.push((params as SessionEventEnvelope).kind);
    });

    const result = (await editor.request("blueprint/dispatch", {
      kind: "camera/configure",
      payload: { frequency: 3 },
    })) as {
      projection: { status: string; reason?: string };
      commandSequence: string;
    };

    assert.equal(result.projection.status, "deferred");
    assert.match(result.projection.reason ?? "", /no engine session/);
    assert.equal(result.commandSequence, "1");
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

    const materialized = await editor.request("project/templateDocument", {
      templateId: "platformer-2d",
      options: {
        projectId: "legacy-materialized",
        name: "Materializado no legado",
        referenceResolution: { width: 1280, height: 720 },
        tileSize: 16,
      },
    }) as { projectId: string; metadata: { name: string } };
    assert.equal(materialized.projectId, "legacy-materialized");
    assert.equal(materialized.metadata.name, "Materializado no legado");

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

test("project/new recusa template desconhecido e substitui a sessão sem exigir blueprint vazio", async () => {
  const h = await makeHarness();
  try {
    const editor = await h.connectEditor();

    await assert.rejects(
      editor.request("project/new", { templateId: "inexistente" }),
      (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
    );

    await editor.request("project/new", { templateId: "platformer-2d" });
    const first = (await editor.request("project/status", {})) as {
      projectSessionId: string;
    };
    await editor.request("project/new", { templateId: "platformer-2d" });
    const second = (await editor.request("project/status", {})) as {
      projectSessionId: string;
    };
    assert.notEqual(second.projectSessionId, first.projectSessionId);

    editor.close();
  } finally {
    await h.close();
  }
});

test("sessão de projeto: dois clientes observam a troca atômica pela mesma partição de eventos", async () => {
  const h = await makeHarness();
  try {
    const editorA = await h.connectEditor("session-owner");
    const editorB = await h.connectEditor("session-observer");
    const observed = new Promise<SessionEventEnvelope>((resolve) => {
      editorB.registerMethod("blueprint/event", (params) =>
        resolve(params as SessionEventEnvelope));
    });

    const activation = (await editorA.request("project/create", {
      projectId: "project-b",
    })) as {
      status: { projectSessionId: string; projectId: string };
    };
    const event = await observed;

    assert.equal(activation.status.projectId, "project-b");
    assert.equal(event.kind, "project/sessionChanged");
    assert.equal(event.projectId, "project-b");
    assert.equal(event.projectSessionId, activation.status.projectSessionId);
    assert.equal((event.payload as ProjectSessionChangedEvent).action, "activated");

    editorA.close();
    editorB.close();
  } finally {
    await h.close();
  }
});

test("histórico global: gateway legado aplica patch e sincroniza undo/redo entre dois clientes", async () => {
  const h = await makeHarness();
  try {
    const editorA = await h.connectEditor("history-editor-a");
    const editorB = await h.connectEditor("history-editor-b");
    let resolveUndo!: (event: SessionEventEnvelope) => void;
    let resolveRedo!: (event: SessionEventEnvelope) => void;
    const undoObserved = new Promise<SessionEventEnvelope>((resolve) => { resolveUndo = resolve; });
    const redoObserved = new Promise<SessionEventEnvelope>((resolve) => { resolveRedo = resolve; });
    editorB.registerMethod("blueprint/event", (params) => {
      const event = params as SessionEventEnvelope;
      if (event.historyAction === "undo") resolveUndo(event);
      if (event.historyAction === "redo") resolveRedo(event);
    });

    await editorA.request("blueprint/dispatch", {
      kind: "level/define",
      payload: {
        levelId: "level-1",
        width: 2,
        height: 1,
        tileSize: 16,
        seed: 1,
        intGrid: [0, 0],
        rules: [],
        palette: [],
      },
      requestId: "legacy-level-define",
    });
    const patch = await editorA.request("blueprint/dispatch", {
      kind: "level/patch",
      payload: {
        levelId: "level-1",
        changes: [
          { index: 0, before: 0, after: 1 },
          { index: 1, before: 0, after: 1 },
        ],
        transactionId: "legacy-brush-gesture",
        metadata: { actor: "agent", label: "Pintar corredor" },
      },
      requestId: "legacy-level-patch",
    }) as {
      commandSequence: string;
      documentStateId: string;
      historyCursor: string;
      historyEntry: { id: string; actor: string; transactionId: string; label: string };
    };
    assert.equal(patch.commandSequence, "2");
    assert.ok(patch.documentStateId);
    assert.ok(patch.historyCursor);
    assert.deepEqual(
      {
        actor: patch.historyEntry.actor,
        transactionId: patch.historyEntry.transactionId,
        label: patch.historyEntry.label,
      },
      {
        actor: "human",
        transactionId: "legacy-brush-gesture",
        label: "Pintar corredor",
      },
    );

    const status = await editorB.request("history/status", { limit: 10 }) as {
      projectSessionId: string;
      historyCursor: string;
      canUndo: boolean;
      canRedo: boolean;
      undoLabel: string;
      entries: Array<{ label: string; actor: string; applied: boolean }>;
    };
    assert.equal(status.canUndo, true);
    assert.equal(status.canRedo, false);
    assert.equal(status.undoLabel, "Pintar corredor");
    assert.equal(status.entries[0]?.actor, "human");

    const undo = await editorA.request("history/undo", {
      requestId: "legacy-undo",
      expectedProjectSessionId: status.projectSessionId,
      historyCursor: status.historyCursor,
    }) as {
      history: { historyCursor: string; canRedo: boolean; redoLabel: string };
      events: SessionEventEnvelope[];
      entry: { actor: string; label: string };
    };
    assert.equal(undo.entry.actor, "human");
    assert.equal(undo.history.canRedo, true);
    assert.equal(undo.history.redoLabel, "Pintar corredor");
    assert.deepEqual(h.store.listLevels()[0]?.intGrid, [0, 0]);
    const undoEvent = await undoObserved;
    assert.equal(undoEvent.historyAction, "undo");
    assert.equal(undoEvent.actor, "human");
    assert.equal(undoEvent.documentStateId, undo.history.historyCursor);

    const retry = await editorB.request("history/undo", {
      requestId: "legacy-undo",
      expectedProjectSessionId: status.projectSessionId,
      historyCursor: status.historyCursor,
    }) as { history: { historyCursor: string } };
    assert.equal(retry.history.historyCursor, undo.history.historyCursor);
    assert.deepEqual(h.store.listLevels()[0]?.intGrid, [0, 0]);

    const redo = await editorA.request("history/redo", {
      requestId: "legacy-redo",
      expectedProjectSessionId: status.projectSessionId,
      historyCursor: undo.history.historyCursor,
    }) as { history: { canRedo: boolean }; events: SessionEventEnvelope[] };
    assert.equal(redo.history.canRedo, false);
    assert.deepEqual(h.store.listLevels()[0]?.intGrid, [1, 1]);
    const redoEvent = await redoObserved;
    assert.equal(redoEvent.historyAction, "redo");
    assert.equal(redo.events[0]?.historyAction, "redo");

    editorA.close();
    editorB.close();
  } finally {
    await h.close();
  }
});
