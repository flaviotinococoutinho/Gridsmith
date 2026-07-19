import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BLUEPRINT_DOCUMENT_VERSION,
  DEFAULT_PROJECT_METADATA,
  migrateBlueprintDocument,
  type BlueprintDocument,
} from "../src/canonical/BlueprintSerializer.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HistoryBarrierError } from "../src/canonical/CommandHistory.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { ProjectSessionManager } from "../src/canonical/ProjectSessionManager.js";
import {
  BlueprintStore,
  type BlueprintEvent,
  type LevelPatchCommand,
  type LevelSpec,
} from "../src/domain/BlueprintStore.js";
import type {
  ProjectionResult,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeSessionResetResult,
} from "../src/runtime/RuntimeAdapter.js";

const LEVEL: LevelSpec = {
  levelId: "level-1",
  width: 3,
  height: 1,
  tileSize: 16,
  seed: 1,
  intGrid: [0, 0, 0],
  rules: [{ patternSize: 1, pattern: [1], tileIds: [1] }],
  palette: [{ value: 1, name: "Chão", color: "#7a5230" }],
};

const META = { actor: "human" as const, label: "Pintou uma linha" };

function patch(
  changes: LevelPatchCommand["changes"],
  transactionId = "gesture-1",
): LevelPatchCommand {
  return { kind: "level/patch", levelId: LEVEL.levelId, changes, transactionId, metadata: META };
}

test("histórico global: level/patch usa CAS por célula e lote inválido não aplica prefixo parcial", () => {
  const store = new BlueprintStore();
  store.apply({ kind: "level/define", level: LEVEL });

  assert.throws(
    () => store.applyBatch([
      patch([{ index: 0, before: 0, after: 1 }], "batch"),
      patch([{ index: 1, before: 9, after: 1 }], "batch"),
    ]),
    /cell 1 changed before patch/,
  );
  assert.deepEqual(store.getLevel(LEVEL.levelId)?.intGrid, [0, 0, 0]);

  const applied = store.applyWithInverse(patch([
    { index: 0, before: 0, after: 1 },
    { index: 2, before: 0, after: 1 },
  ]));
  assert.equal(applied.event.kind, "levelPatched");
  assert.deepEqual(Object.keys(applied.event).sort(), ["changes", "kind", "levelId"]);
  assert.equal("level" in applied.event, false, "public patch event must not duplicate the full level snapshot");
  assert.deepEqual(store.getLevel(LEVEL.levelId)?.intGrid, [1, 0, 1]);
  store.applyBatch(applied.inverse);
  assert.deepEqual(store.getLevel(LEVEL.levelId)?.intGrid, [0, 0, 0]);
});

test("histórico global: inversos explícitos restauram câmera, luz, propriedade, paleta e world placement", () => {
  const store = new BlueprintStore();
  store.apply({ kind: "camera/configure", settings: { frequency: 2 } });
  const camera = store.applyWithInverse({ kind: "camera/configure", settings: { damping: 0.5 } });
  store.applyBatch(camera.inverse);
  assert.deepEqual(store.cameraSettings, { frequency: 2 }, "inverse removes a previously absent camera key");

  store.apply({
    kind: "light/add",
    light: { lightId: "sun", type: "directional", direction: [1, 0], color: [1, 1, 1], intensity: 1 },
  });
  const light = store.applyWithInverse({
    kind: "light/update",
    light: { lightId: "sun", type: "directional", direction: [0, 1], color: [1, 1, 1], intensity: 2 },
  });
  store.applyBatch(light.inverse);
  assert.equal(store.getLight("sun")?.intensity, 1);

  store.apply({
    kind: "entitydef/define",
    definition: { entityDefId: "player", fields: [{ name: "speed", type: "int", default: 1 }] },
  });
  store.apply({
    kind: "entity/place",
    entity: { entityId: "player-1", entityDefId: "player", position: [8, 8], fields: {} },
  });
  const property = store.applyWithInverse({
    kind: "entity/properties",
    entityId: "player-1",
    changes: [{ name: "speed", before: 1, after: 2 }],
  });
  store.applyBatch(property.inverse);
  assert.equal(store.getEntity("player-1")?.fields["speed"], 1);

  store.apply({ kind: "level/define", level: LEVEL });
  const palette = store.applyWithInverse({
    kind: "level/palette",
    levelId: LEVEL.levelId,
    changes: [{
      value: 2,
      before: null,
      after: { value: 2, name: "Parede", color: "#5a6a7a" },
    }],
  });
  assert.equal(palette.event.kind, "levelPaletteChanged");
  assert.equal("level" in palette.event, false, "palette event remains incremental on journal/transports");
  store.applyBatch(palette.inverse);
  assert.deepEqual(store.getLevel(LEVEL.levelId)?.palette, LEVEL.palette);

  store.apply({ kind: "world/place", placement: { levelId: LEVEL.levelId, x: 0, y: 0 } });
  const moved = store.applyWithInverse({ kind: "world/place", placement: { levelId: LEVEL.levelId, x: 64, y: 0 } });
  store.applyBatch(moved.inverse);
  assert.deepEqual(store.listPlacements(), [{ levelId: LEVEL.levelId, x: 0, y: 0 }]);
});

test("histórico global: define/update/remove e place/move/remove possuem inversos de domínio", () => {
  const store = new BlueprintStore();
  const originalDef = {
    entityDefId: "npc",
    fields: [{ name: "mood", type: "string" as const, default: "ok" }],
    editor: { color: "#112233" },
  };
  store.apply({ kind: "entitydef/define", definition: originalDef });
  const updated = store.applyWithInverse({
    kind: "entitydef/update",
    definition: { ...originalDef, editor: { color: "#445566" } },
  });
  store.applyBatch(updated.inverse);
  assert.deepEqual(store.getEntityDef("npc"), originalDef);

  store.apply({
    kind: "entity/place",
    entity: { entityId: "npc-1", entityDefId: "npc", position: [0, 0], fields: {} },
  });
  const moved = store.applyWithInverse({ kind: "entity/move", entityId: "npc-1", position: [16, 32] });
  store.applyBatch(moved.inverse);
  assert.deepEqual(store.getEntity("npc-1")?.position, [0, 0]);
  const removedEntity = store.applyWithInverse({ kind: "entity/remove", entityId: "npc-1" });
  store.applyBatch(removedEntity.inverse);
  assert.equal(store.getEntity("npc-1")?.fields["mood"], "ok");

  store.apply({ kind: "entity/remove", entityId: "npc-1" });
  const removedDef = store.applyWithInverse({ kind: "entitydef/remove", entityDefId: "npc" });
  store.applyBatch(removedDef.inverse);
  assert.equal(store.getEntityDef("npc")?.editor?.color, "#112233");

  store.apply({
    kind: "light/add",
    light: { lightId: "lamp", type: "point", position: [8, 8], color: [1, 1, 1], intensity: 1, radius: 32 },
  });
  const removedLight = store.applyWithInverse({ kind: "light/remove", lightId: "lamp" });
  store.applyBatch(removedLight.inverse);
  assert.equal(store.getLight("lamp")?.radius, 32);

  store.apply({ kind: "level/define", level: LEVEL });
  store.apply({ kind: "world/place", placement: { levelId: LEVEL.levelId, x: 0, y: 0 } });
  const removedLevel = store.applyWithInverse({ kind: "level/remove", levelId: LEVEL.levelId });
  assert.equal(removedLevel.inverse.length, 2, "level inverse restores definition then placement");
  store.applyBatch(removedLevel.inverse);
  assert.deepEqual(store.listPlacements(), [{ levelId: LEVEL.levelId, x: 0, y: 0 }]);
  const unplaced = store.applyWithInverse({ kind: "world/unplace", levelId: LEVEL.levelId });
  store.applyBatch(unplaced.inverse);
  assert.deepEqual(store.listPlacements(), [{ levelId: LEVEL.levelId, x: 0, y: 0 }]);
});

test("histórico global: gesto coalesce, preserva proveniência, usa cursor estável e invalida futuro", async () => {
  const store = new BlueprintStore();
  let id = 0;
  const history = new (await import("../src/canonical/CommandHistory.js")).CommandHistory(
    () => 1000 + id,
    () => `id-${++id}`,
  );
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), undefined, history);
  await orchestrator.dispatch({ kind: "level/define", level: LEVEL }, { mode: "prepare" });
  const baseline = history.documentStateId;

  await orchestrator.dispatch(patch([{ index: 0, before: 0, after: 1 }]), { actor: "agent" });
  await orchestrator.dispatch(patch([{ index: 0, before: 1, after: 2 }]), { actor: "agent" });
  assert.equal(history.length, 1);
  assert.equal(history.list()[0]?.actor, "agent");
  assert.equal(history.list()[0]?.label, "Pintou uma linha");
  assert.equal(history.list()[0]?.forward.length, 1, "patches do mesmo gesto são coalescidos semanticamente");
  const paintedState = history.documentStateId;

  await orchestrator.undo(paintedState);
  assert.equal(history.documentStateId, baseline);
  assert.deepEqual(store.getLevel(LEVEL.levelId)?.intGrid, [0, 0, 0]);
  assert.equal(history.status.canRedo, true);
  await orchestrator.redo(baseline);
  assert.equal(history.documentStateId, paintedState);
  assert.deepEqual(store.getLevel(LEVEL.levelId)?.intGrid, [2, 0, 0]);

  await orchestrator.undo(paintedState);
  await orchestrator.dispatch(patch([{ index: 1, before: 0, after: 3 }], "new-branch"));
  assert.equal(history.status.canRedo, false);
  assert.equal(history.lastSequence, 7n, "revisão conta applies e os patches coalescidos de undo/redo");
});

test("histórico global: undo de câmera sinaliza replace e remove chaves no runtime", async () => {
  const store = new BlueprintStore();
  const runtime = new NoopRuntime();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), runtime);

  await orchestrator.dispatch({ kind: "camera/configure", settings: { frequency: 3 } });
  const changed = await orchestrator.dispatch({ kind: "camera/configure", settings: { damping: 0.5 } });
  const undone = await orchestrator.undo(changed.historyCursor);

  assert.deepEqual(store.cameraSettings, { frequency: 3 });
  assert.deepEqual(undone.results.map((result) => result.event), [{
    kind: "cameraConfigured",
    settings: { frequency: 3 },
    replace: true,
  }]);
  assert.deepEqual(runtime.events.at(-1), {
    kind: "cameraConfigured",
    settings: { frequency: 3 },
    replace: true,
  });
});

test("histórico global: no-op é rejeitado antes de criar history entry ou dirty state", async () => {
  assert.ok(Object.isFrozen(new BlueprintStore().cameraSettings), "initial camera projection is immutable");
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());
  await orchestrator.dispatch({ kind: "camera/configure", settings: { frequency: 3 } });
  const historyLength = orchestrator.history.length;
  const documentStateId = orchestrator.history.documentStateId;
  const commandSequence = orchestrator.history.lastSequence;

  await assert.rejects(
    orchestrator.dispatch({ kind: "camera/configure", settings: { frequency: 3 } }),
    /does not change the Blueprint/,
  );

  assert.equal(orchestrator.history.length, historyLength);
  assert.equal(orchestrator.history.documentStateId, documentStateId);
  assert.equal(orchestrator.history.lastSequence, commandSequence);
  assert.ok(Object.isFrozen(store.cameraSettings), "camera projection remains immutable after changes");
});

test("histórico global: archetype em uso é rejeitado sem alterar store, history ou dirty cursor", async () => {
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());
  await orchestrator.dispatch({
    kind: "entitydef/define",
    definition: {
      entityDefId: "player",
      archetypeId: "player-v1",
      fields: [{ name: "speed", type: "int", default: 1 }],
    },
  }, { mode: "prepare" });
  await orchestrator.dispatch({
    kind: "entity/place",
    entity: {
      entityId: "player-1",
      entityDefId: "player",
      position: [8, 8],
      fields: {},
    },
  }, { mode: "prepare" });
  const historyLength = orchestrator.history.length;
  const commandSequence = orchestrator.history.lastSequence;
  const documentStateId = orchestrator.history.documentStateId;
  const previousDefinition = store.getEntityDef("player");

  await assert.rejects(
    orchestrator.dispatch({
      kind: "entitydef/update",
      definition: {
        entityDefId: "player",
        archetypeId: "player-v2",
        fields: [{ name: "speed", type: "int", default: 1 }],
      },
    }),
    /cannot change archetypeId.*remove its instances first/,
  );

  assert.deepEqual(store.getEntityDef("player"), previousDefinition);
  assert.equal(orchestrator.history.length, historyLength);
  assert.equal(orchestrator.history.lastSequence, commandSequence);
  assert.equal(orchestrator.history.documentStateId, documentStateId);
});

test("histórico global: comandos sem inverso explícito formam barreira", async () => {
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());
  await orchestrator.dispatch({
    kind: "skeleton/define",
    skeleton: { skeletonId: "rig", bones: [{ id: 0, parentId: -1, inverseBindMatrix: [1, 0, 0, 1, 0, 0] }] },
  });
  assert.equal(orchestrator.history.status.canUndo, false);
  assert.equal(orchestrator.history.list()[0]?.barrier, true);
  await assert.rejects(orchestrator.undo(), HistoryBarrierError);
});

test("histórico global: replay estabelece baseline não desfazível e sessão publica undo identificável", async () => {
  const runtime = new NoopRuntime();
  let id = 0;
  const sessions = new ProjectSessionManager({
    hooks: new HookBus(),
    adapter: runtime,
    createId: () => `session-${++id}`,
    now: () => 10_000 + id,
  });
  const document: BlueprintDocument = {
    schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
    projectId: "history-project",
    metadata: DEFAULT_PROJECT_METADATA,
    skeletons: [], meshes: [], camera: {}, lights: [], entityDefs: [], entities: [],
    levels: [LEVEL], placements: [],
  };
  await sessions.replaceAtomically(await sessions.prepareFromDocument(document));
  assert.equal(sessions.current?.history.length, 0);
  assert.equal(sessions.status.commandSequence, "1");
  assert.equal(sessions.status.canUndo, false);

  const observed: Array<{ historyAction: string; actor: string }> = [];
  sessions.on("event", (event) => observed.push({
    historyAction: event.historyAction,
    actor: event.actor,
  }));
  const applied = await sessions.dispatch(
    patch([{ index: 1, before: 0, after: 1 }], "agent-gesture"),
    sessions.current?.sessionId,
    "agent",
  );
  const undone = await sessions.historyUndo(
    sessions.current?.sessionId,
    applied.historyCursor,
    "human",
  );
  assert.equal(undone.entry.actor, "agent", "undo preserves original command provenance");
  assert.deepEqual(observed, [
    { historyAction: "apply", actor: "agent" },
    { historyAction: "undo", actor: "agent" },
  ]);
  assert.deepEqual(sessions.current?.store.getLevel(LEVEL.levelId)?.intGrid, [0, 0, 0]);
  assert.equal(undone.status.canRedo, true);
});

test("histórico global: migration v3 adiciona paleta determinística e produz schema v4", () => {
  const migrated = migrateBlueprintDocument({
    schemaVersion: 3,
    projectId: "v3",
    metadata: DEFAULT_PROJECT_METADATA,
    skeletons: [], meshes: [], camera: {}, lights: [], entityDefs: [], entities: [],
    levels: [{ ...LEVEL, palette: undefined, intGrid: [0, 1, 2] }],
    placements: [],
  });
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.levels[0]?.palette, [
    { value: 1, name: "Chão", color: "#7a5230" },
    { value: 2, name: "Parede", color: "#5a6a7a" },
    { value: 3, name: "Perigo", color: "#b8433a" },
  ]);
});

class NoopRuntime implements RuntimeAdapter {
  readonly family = "test";
  readonly isConnected = true;
  readonly events: BlueprintEvent[] = [];
  identify(): RuntimeIdentity { return { family: this.family, version: "1" }; }
  async project(event: BlueprintEvent): Promise<ProjectionResult> {
    this.events.push(event);
    return { event: event.kind, status: "projected" };
  }
  async resetSession(): Promise<RuntimeSessionResetResult> {
    return { status: "reset", runtimeSessionEpoch: 1 };
  }
  async rehydrateFrom(store: BlueprintStore): Promise<readonly ProjectionResult[]> {
    return store.listLevels().map(() => ({ event: "levelDefined", status: "projected" as const }));
  }
}
