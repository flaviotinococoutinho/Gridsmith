import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  DEFAULT_PROJECT_METADATA,
  exportBlueprint,
  type BlueprintDocument,
} from "../src/canonical/BlueprintSerializer.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { ProjectSessionManager } from "../src/canonical/ProjectSessionManager.js";
import type {
  BlueprintEvent,
  BlueprintStore,
  LightSpec,
} from "../src/domain/BlueprintStore.js";
import type {
  ProjectionResult,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeSessionEpoch,
  RuntimeSessionResetResult,
} from "../src/runtime/RuntimeAdapter.js";
import { RuntimeSessionSupersededError } from "../src/runtime/RuntimeAdapter.js";

class SessionRuntime implements RuntimeAdapter {
  readonly family = "test";
  isConnected = true;
  failNextProject = false;
  failNextRehydrate = false;
  failResetAt: number | undefined;
  blockNextReset: Promise<void> | undefined;
  onResetBlocked: (() => void) | undefined;
  blockNextProject: Promise<void> | undefined;
  onProjectBlocked: (() => void) | undefined;
  readonly rehydrated: BlueprintStore[] = [];
  lastSuccessfulStore: BlueprintStore | undefined;
  resetCount = 0;
  runtimeSessionEpoch = 1;

  identify(): RuntimeIdentity {
    return { family: this.family, version: "1.0.0" };
  }

  async resetSession(): Promise<RuntimeSessionResetResult> {
    const runtimeSessionEpoch = this.runtimeSessionEpoch;
    this.resetCount++;
    if (this.failResetAt === this.resetCount) {
      throw new Error("fault injected while resetting runtime");
    }
    if (this.blockNextReset) {
      const barrier = this.blockNextReset;
      this.blockNextReset = undefined;
      this.onResetBlocked?.();
      await barrier;
    }
    this.assertEpoch(runtimeSessionEpoch);
    return this.isConnected
      ? { status: "reset", runtimeSessionEpoch }
      : { status: "deferred", runtimeSessionEpoch, reason: "engine disconnected" };
  }

  async project(
    event: BlueprintEvent,
    expectedRuntimeSessionEpoch = this.runtimeSessionEpoch,
  ): Promise<ProjectionResult> {
    this.assertEpoch(expectedRuntimeSessionEpoch);
    if (this.failNextProject) {
      this.failNextProject = false;
      throw new Error("fault injected while projecting live event");
    }
    if (this.blockNextProject) {
      const barrier = this.blockNextProject;
      this.blockNextProject = undefined;
      this.onProjectBlocked?.();
      await barrier;
    }
    this.assertEpoch(expectedRuntimeSessionEpoch);
    return this.isConnected
      ? { event: event.kind, status: "projected" }
      : { event: event.kind, status: "deferred", reason: "engine disconnected" };
  }

  async rehydrateFrom(
    store: BlueprintStore,
    expectedRuntimeSessionEpoch = this.runtimeSessionEpoch,
  ): Promise<readonly ProjectionResult[]> {
    this.assertEpoch(expectedRuntimeSessionEpoch);
    this.rehydrated.push(store);
    if (this.failNextRehydrate) {
      this.failNextRehydrate = false;
      throw new Error("fault injected while rehydrating candidate runtime");
    }
    const events: BlueprintEvent[] = [
      ...store.listLights().map((light) => ({ kind: "lightAdded" as const, light })),
      ...store.listLevels().map((level) => ({ kind: "levelDefined" as const, level })),
      ...store.listEntities().map((entity) => ({ kind: "entityPlaced" as const, entity })),
    ];
    const results: ProjectionResult[] = [];
    for (const event of events) {
      results.push(await this.project(event, expectedRuntimeSessionEpoch));
    }
    this.assertEpoch(expectedRuntimeSessionEpoch);
    if (this.isConnected) this.lastSuccessfulStore = store;
    return results;
  }

  supersedeRuntime(): void {
    this.runtimeSessionEpoch++;
  }

  private assertEpoch(expected: RuntimeSessionEpoch): void {
    if (expected !== this.runtimeSessionEpoch) {
      throw new RuntimeSessionSupersededError(expected, this.runtimeSessionEpoch);
    }
  }
}

function manager(hooks = new HookBus(), runtime = new SessionRuntime()): {
  sessions: ProjectSessionManager;
  runtime: SessionRuntime;
} {
  let id = 0;
  return {
    sessions: new ProjectSessionManager({
      hooks,
      adapter: runtime,
      now: () => 1_700_000_000_000 + id,
      createId: () => `generated-${++id}`,
    }),
    runtime,
  };
}

function document(projectId: string, lights: readonly LightSpec[] = []): BlueprintDocument {
  return {
    schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
    projectId,
    metadata: DEFAULT_PROJECT_METADATA,
    skeletons: [],
    meshes: [],
    camera: {},
    lights,
    entityDefs: [],
    entities: [],
    levels: [],
    placements: [],
  };
}

function light(index: number): LightSpec {
  return {
    lightId: `light-${index}`,
    type: "directional",
    direction: [0, -1],
    color: [1, 1, 1],
    intensity: 1,
  };
}

test("abrir A, fechar e abrir B substitui stores e históricos na mesma execução", async () => {
  const { sessions, runtime } = manager();
  const a = await sessions.prepareFromDocument(document("A", [light(1)]));
  const activeA = await sessions.replaceAtomically(a);
  const storeA = sessions.current!.store;
  assert.equal(activeA.status.projectId, "A");

  await sessions.close(activeA.status.projectSessionId);
  assert.equal(sessions.current, undefined);

  const b = await sessions.prepareFromDocument(document("B", [light(2), light(3)]));
  await sessions.replaceAtomically(b);
  assert.equal(sessions.current!.projectId, "B");
  assert.notEqual(sessions.current!.store, storeA);
  assert.deepEqual(sessions.current!.store.listLights().map((item) => item.lightId), ["light-2", "light-3"]);
  assert.ok(runtime.resetCount >= 3, "activation/close/activation reset the runtime");
});

test("documento inválido mantém sessão A, dirty-equivalent sequence e runtime intactos", async () => {
  const { sessions, runtime } = manager();
  await sessions.replaceAtomically(
    await sessions.prepareFromDocument(document("A", [light(1)])),
  );
  const before = sessions.current!;
  const beforeDocument = exportBlueprint(before.store, before.projectId);
  const beforeSequence = before.history.lastSequence;
  const resetCount = runtime.resetCount;
  let changes = 0;
  sessions.on("sessionChanged", () => changes++);

  await assert.rejects(
    sessions.prepareFromDocument({
      schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
      projectId: "B",
      metadata: DEFAULT_PROJECT_METADATA,
      skeletons: "not-an-array",
      meshes: [], camera: {}, lights: [], entityDefs: [], entities: [], levels: [], placements: [],
    }),
    /skeletons.*array/,
  );

  assert.equal(sessions.current, before);
  assert.deepEqual(exportBlueprint(before.store, before.projectId), beforeDocument);
  assert.equal(before.history.lastSequence, beforeSequence);
  assert.equal(runtime.resetCount, resetCount, "invalid input never touched runtime");
  assert.equal(changes, 0, "invalid input published no session event");
});

test("posição não finita/numérica é rejeitada antes de tocar sessão ou runtime", async () => {
  const { sessions, runtime } = manager();
  await sessions.replaceAtomically(
    await sessions.prepareFromDocument(document("A", [light(1)])),
  );
  const before = sessions.current;
  const resets = runtime.resetCount;
  const invalid = {
    ...light(2),
    position: ["not-a-world-coordinate", 0],
  } as unknown as LightSpec;

  await assert.rejects(
    sessions.prepareFromDocument(document("B", [invalid])),
    /position.*finite|position.*numbers/,
  );

  assert.equal(sessions.current, before);
  assert.equal(runtime.resetCount, resets);
});

test("metadata preparada é clonada e congelada fora do objeto de entrada", async () => {
  const { sessions } = manager();
  const mutableMetadata = {
    name: "Original",
    referenceResolution: { width: 1280, height: 720 },
    spatial: { ...DEFAULT_PROJECT_METADATA.spatial },
  };
  const input = { ...document("immutable"), metadata: mutableMetadata };
  const prepared = await sessions.prepareFromDocument(input);

  mutableMetadata.name = "Mutado externamente";
  mutableMetadata.referenceResolution.width = 1;

  assert.equal(prepared.session.metadata.name, "Original");
  assert.equal(prepared.session.metadata.referenceResolution.width, 1280);
  assert.ok(Object.isFrozen(prepared.session.metadata));
  assert.ok(Object.isFrozen(prepared.session.metadata.referenceResolution));
  assert.ok(Object.isFrozen(prepared.session.metadata.spatial));
});

test("falha no quinto comando de replay não produz efeitos parciais fora da sessão temporária", async () => {
  const hooks = new HookBus();
  const { sessions, runtime } = manager(hooks);
  await sessions.replaceAtomically(
    await sessions.prepareFromDocument(document("A", [light(100)])),
  );
  const activeA = sessions.current!;
  const runtimeCallsBefore = runtime.rehydrated.length;
  const published: unknown[] = [];
  sessions.on("event", (event) => published.push(event));
  sessions.on("sessionChanged", (event) => published.push(event));

  let replayed = 0;
  hooks.addFilter("command:light/add", (command) => {
    replayed++;
    if (replayed === 5) throw new Error("fault injected at replay command 5");
    return command;
  }, { id: "fail-fifth" });

  await assert.rejects(
    sessions.prepareFromDocument(document("B", [1, 2, 3, 4, 5, 6].map(light))),
    /fault injected.*5/,
  );

  assert.equal(sessions.current, activeA);
  assert.deepEqual(activeA.store.listLights().map((item) => item.lightId), ["light-100"]);
  assert.equal(activeA.history.lastSequence, 1n);
  assert.equal(runtime.rehydrated.length, runtimeCallsBefore, "prepare never projects into runtime");
  assert.deepEqual(published, [], "temporary replay never reaches clients");
});

test("falha ao reidratar candidato restaura runtime e mantém a sessão anterior publicada", async () => {
  const { sessions, runtime } = manager();
  await sessions.replaceAtomically(
    await sessions.prepareFromDocument(document("A", [light(1)])),
  );
  const activeA = sessions.current!;
  assert.equal(runtime.lastSuccessfulStore, activeA.store);
  let changes = 0;
  sessions.on("sessionChanged", () => changes++);

  const candidateB = await sessions.prepareFromDocument(document("B", [light(2)]));
  runtime.failNextRehydrate = true;
  await assert.rejects(
    sessions.replaceAtomically(candidateB),
    /fault injected while rehydrating candidate runtime/,
  );

  assert.equal(sessions.current, activeA);
  assert.equal(runtime.lastSuccessfulStore, activeA.store);
  assert.deepEqual(activeA.store.listLights().map((item) => item.lightId), ["light-1"]);
  assert.equal(changes, 0, "failed activation did not publish a session switch");
});

test("supersession B → C no meio da reidratação aborta candidato e restaura A no novo epoch", async () => {
  const { sessions, runtime } = manager();
  await sessions.replaceAtomically(
    await sessions.prepareFromDocument(document("A", [light(1)])),
  );
  const activeA = sessions.current!;
  const candidateB = await sessions.prepareFromDocument(
    document("B", [light(2), light(3)]),
  );
  let release!: () => void;
  runtime.blockNextProject = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { runtime.onProjectBlocked = resolve; });
  let changes = 0;
  sessions.on("sessionChanged", () => changes++);

  const replacing = sessions.replaceAtomically(candidateB);
  await entered;
  runtime.supersedeRuntime();
  release();

  await assert.rejects(replacing, /Runtime session changed during projection/);
  assert.equal(sessions.current, activeA);
  assert.equal(runtime.lastSuccessfulStore, activeA.store);
  assert.equal(sessions.status.runtimeState, "synchronized");
  assert.equal(changes, 0, "candidate from the obsolete epoch was never published");
});

test("falha de projeção após commit vira deferred sem esconder store, history ou evento", async () => {
  const { sessions, runtime } = manager();
  await sessions.replaceAtomically(sessions.createEmptySession("live-failure"));
  const events: unknown[] = [];
  sessions.on("event", (event) => events.push(event));
  runtime.failNextProject = true;

  const result = await sessions.dispatch({ kind: "light/add", light: light(1) });

  assert.equal(result.projection?.status, "deferred");
  assert.match(result.projection?.status === "deferred" ? result.projection.reason : "", /fault injected/);
  assert.deepEqual(sessions.current!.store.listLights().map((item) => item.lightId), ["light-1"]);
  assert.equal(sessions.current!.history.lastSequence, 1n);
  assert.equal(events.length, 1);
  assert.equal(sessions.status.runtimeState, "deferred");
});

test("BlueprintStore não publica antes do commit de history/session event", async () => {
  const { sessions } = manager();
  await sessions.replaceAtomically(sessions.createEmptySession("single-publisher"));
  const store = sessions.current!.store;
  const published: unknown[] = [];
  sessions.on("event", (event) => published.push(event));

  assert.equal(store instanceof EventEmitter, false, "store must not expose a pre-commit emitter");
  const result = await sessions.dispatch({ kind: "light/add", light: light(1) });

  assert.equal(store.listLights().length, 1);
  assert.equal(sessions.current!.history.lastSequence, 1n);
  assert.equal(result.commandSequence, 1n);
  assert.equal(published.length, 1, "the manager is the single post-commit publisher");
});

test("observador que lança é isolado depois do commit e não impede os demais", async () => {
  const { sessions } = manager();
  let observed = 0;
  sessions.on("sessionChanged", () => {
    throw new Error("observer failed");
  });
  sessions.on("sessionChanged", () => observed++);

  const activated = await sessions.replaceAtomically(sessions.createEmptySession("observer"));

  assert.equal(activated.status.projectId, "observer");
  assert.equal(sessions.current?.projectId, "observer");
  assert.equal(observed, 1);
});

test("rollback irrecuperável marca runtime failed e bloqueia dispatch até reidratar", async () => {
  const { sessions, runtime } = manager();
  await sessions.replaceAtomically(sessions.createEmptySession("A"));
  const activeA = sessions.current!;
  const candidate = await sessions.prepareFromDocument(document("B", [light(2)]));
  runtime.failNextRehydrate = true;
  runtime.failResetAt = runtime.resetCount + 2;

  await assert.rejects(sessions.replaceAtomically(candidate), /runtime could not be restored/);
  assert.equal(sessions.current, activeA);
  assert.equal(sessions.status.runtimeState, "failed");
  await assert.rejects(
    sessions.dispatch({ kind: "light/add", light: light(3) }),
    /fail-closed/,
  );
  assert.equal(activeA.history.lastSequence, 0n);

  runtime.failResetAt = undefined;
  await sessions.rehydrateCurrent();
  assert.equal(sessions.status.runtimeState, "synchronized");
  await sessions.dispatch({ kind: "light/add", light: light(3) });
  assert.equal(activeA.history.lastSequence, 1n);
});

test("replaceAtomically usa compare-and-swap e recusa candidato preparado sobre sessão antiga", async () => {
  const { sessions } = manager();
  const activeA = await sessions.replaceAtomically(sessions.createEmptySession("A"));
  const expectedA = activeA.status.projectSessionId!;
  const candidateB = sessions.createEmptySession("B");
  const staleC = sessions.createEmptySession("C");

  await sessions.replaceAtomically(candidateB, expectedA);
  await assert.rejects(
    sessions.replaceAtomically(staleC, expectedA),
    /Active project session changed before replace/,
  );
  assert.equal(sessions.current?.projectId, "B");
});

test("replace e close recusam commandSequence obsoleto sem descartar comando concorrente", async () => {
  const { sessions } = manager();
  const active = await sessions.replaceAtomically(
    sessions.createEmptySession("revision-a"),
    undefined,
    "0",
  );
  const sessionId = active.status.projectSessionId!;
  await sessions.dispatch({ kind: "light/add", light: light(1) }, sessionId);

  await assert.rejects(
    sessions.replaceAtomically(
      sessions.createEmptySession("revision-b"),
      sessionId,
      "0",
    ),
    /command sequence changed before replace.*expected 0, got 1/,
  );
  await assert.rejects(
    sessions.close(sessionId, "0"),
    /command sequence changed before close.*expected 0, got 1/,
  );
  assert.equal(sessions.current?.projectId, "revision-a");
  assert.equal(sessions.current?.history.lastSequence, 1n);

  await sessions.replaceAtomically(
    sessions.createEmptySession("revision-b"),
    sessionId,
    "1",
  );
  assert.equal(sessions.current?.projectId, "revision-b");
});

test("sequência zero sem sessionId protege o primeiro Open contra sessão surgida", async () => {
  const { sessions } = manager();
  await sessions.replaceAtomically(sessions.createEmptySession("first"), undefined, "0");
  await assert.rejects(
    sessions.replaceAtomically(sessions.createEmptySession("stale-first"), undefined, "0"),
    /Active project session appeared before replace/,
  );
  assert.equal(sessions.current?.projectId, "first");
});

test("porta de leitura fecha durante reset/rehydrate e reabre somente após o commit", async () => {
  const { sessions, runtime } = manager();
  await sessions.replaceAtomically(sessions.createEmptySession("A"));
  let release!: () => void;
  runtime.blockNextReset = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { runtime.onResetBlocked = resolve; });

  const replacing = sessions.replaceAtomically(sessions.createEmptySession("B"));
  await entered;
  assert.throws(() => sessions.readCurrent(), /transition is in progress/);
  assert.equal(sessions.current?.projectId, "A", "referência publicada continua A durante staging");
  release();
  await replacing;
  assert.equal(sessions.readCurrent()?.projectId, "B");
});

test("rehydrateCurrent também mantém a porta de leitura fechada até terminar", async () => {
  const { sessions, runtime } = manager();
  await sessions.replaceAtomically(sessions.createEmptySession("A"));
  let release!: () => void;
  runtime.blockNextReset = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { runtime.onResetBlocked = resolve; });

  const rehydrating = sessions.rehydrateCurrent();
  await entered;
  assert.throws(() => sessions.readCurrent(), /transition is in progress/);
  release();
  await rehydrating;
  assert.equal(sessions.readCurrent()?.projectId, "A");
});

test("criar projeto vazio após fechar produz nova identidade sem depender de Blueprint vazio", async () => {
  const { sessions } = manager();
  const first = await sessions.replaceAtomically(sessions.createEmptySession("A"));
  await sessions.close(first.status.projectSessionId);
  const second = await sessions.replaceAtomically(sessions.createEmptySession("B"));
  assert.equal(second.status.active, true);
  assert.equal(second.status.projectId, "B");
  assert.notEqual(second.status.projectSessionId, first.status.projectSessionId);
  assert.equal(sessions.current!.store.isEmpty, true);
});

test("troca desconectada fica deferred; reconexão reseta e reidrata somente o projeto ativo", async () => {
  const runtime = new SessionRuntime();
  runtime.isConnected = false;
  const { sessions } = manager(new HookBus(), runtime);

  await sessions.replaceAtomically(
    await sessions.prepareFromDocument(document("A", [light(1)])),
  );
  await sessions.replaceAtomically(
    await sessions.prepareFromDocument(document("B", [light(2)])),
  );
  assert.equal(sessions.status.runtimeState, "deferred");
  const beforeReconnect = runtime.rehydrated.length;

  runtime.isConnected = true;
  await sessions.rehydrateCurrent();
  assert.equal(sessions.status.runtimeState, "synchronized");
  assert.equal(runtime.rehydrated.length, beforeReconnect + 1);
  assert.equal(runtime.rehydrated.at(-1), sessions.current!.store);
  assert.deepEqual(runtime.rehydrated.at(-1)!.listLights().map((item) => item.lightId), ["light-2"]);
});

test("eventos ativos carregam identidade e commandSequence da sessão", async () => {
  const { sessions } = manager();
  await sessions.replaceAtomically(sessions.createEmptySession("events"));
  const observed: Array<Record<string, unknown>> = [];
  sessions.on("event", (event) => observed.push(event as unknown as Record<string, unknown>));
  await sessions.dispatch({ kind: "light/add", light: light(1) });

  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.["projectSessionId"], sessions.current!.sessionId);
  assert.equal(observed[0]?.["projectId"], "events");
  assert.equal(observed[0]?.["commandSequence"], "1");
  assert.equal(observed[0]?.["revision"], "1");
});
