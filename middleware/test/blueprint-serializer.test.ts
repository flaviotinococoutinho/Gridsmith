import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  BlueprintDocumentError,
  documentToCommands,
  exportBlueprint,
  replayDocument,
} from "../src/canonical/BlueprintSerializer.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { BlueprintStore } from "../src/domain/BlueprintStore.js";

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Constrói um projeto usando TODOS os domínios do Blueprint. */
async function buildFullProject(): Promise<{ store: BlueprintStore; orchestrator: CanonicalOrchestrator }> {
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());

  await orchestrator.dispatch({
    kind: "skeleton/define",
    skeleton: { skeletonId: "rig", bones: [{ id: 0, parentId: -1, inverseBindMatrix: IDENTITY }] },
  });
  await orchestrator.dispatch({
    kind: "mesh/bind",
    binding: { meshId: "m", skeletonId: "rig", sharedMemoryMapName: "map", vertexCount: 4, strideInBytes: 36 },
  });
  await orchestrator.dispatch({ kind: "camera/configure", settings: { frequency: 3, damping: 0.7 } });
  await orchestrator.dispatch({
    kind: "light/add",
    light: { lightId: "sun", type: "point", position: [1, 2], color: [1, 1, 1], intensity: 2, radius: 50 },
  });
  await orchestrator.dispatch({
    kind: "entitydef/define",
    definition: { entityDefId: "coin", fields: [{ name: "value", type: "int", default: 1 }] },
  });
  await orchestrator.dispatch({
    kind: "entity/place",
    entity: { entityId: "coin-1", entityDefId: "coin", position: [8, 8], fields: {} },
  });
  await orchestrator.dispatch({
    kind: "level/define",
    level: {
      levelId: "l1",
      width: 2,
      height: 1,
      tileSize: 16,
      seed: 3,
      intGrid: [1, 1],
      rules: [{ patternSize: 1, pattern: [1], tileIds: [9] }],
    },
  });
  await orchestrator.dispatch({ kind: "world/place", placement: { levelId: "l1", x: 0, y: 0 } });
  return { store, orchestrator };
}

test("roundtrip: export → replay em projeto vazio → export idêntico", async () => {
  const original = await buildFullProject();
  const document = exportBlueprint(original.store);
  assert.equal(document.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);

  const fresh = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(fresh, new HookBus());
  const summary = await replayDocument(document, fresh, orchestrator);

  assert.equal(summary.applied, 8);
  // replay sem adapter: nada projetado, nada deferido/pulado registrado
  assert.equal(summary.projected, 0);

  // o documento reexportado é IDÊNTICO — persistência sem perdas
  assert.deepEqual(exportBlueprint(fresh), document);
});

test("comandos são ordenados por dependência (malha após esqueleto, colocação após nível)", async () => {
  const { store } = await buildFullProject();
  const kinds = documentToCommands(exportBlueprint(store)).map((c) => c.kind);
  assert.ok(kinds.indexOf("skeleton/define") < kinds.indexOf("mesh/bind"));
  assert.ok(kinds.indexOf("entitydef/define") < kinds.indexOf("entity/place"));
  assert.ok(kinds.indexOf("level/define") < kinds.indexOf("world/place"));
});

test("replay valida na borda: documento corrompido falha com o erro do domínio", async () => {
  const { store } = await buildFullProject();
  const document = exportBlueprint(store);
  const corrupted = {
    ...document,
    // malha órfã: referencia esqueleto que não existe no documento
    meshes: [{ ...document.meshes[0]!, skeletonId: "ghost" }],
  };

  const fresh = new BlueprintStore();
  await assert.rejects(
    replayDocument(corrupted, fresh, new CanonicalOrchestrator(fresh, new HookBus())),
    /Skeleton "ghost" is not defined/,
  );
});

test("versão desconhecida é rejeitada sem depender de Blueprint vazio", async () => {
  const { store } = await buildFullProject();
  const document = exportBlueprint(store);

  assert.throws(
    () => documentToCommands({ ...document, schemaVersion: 99 }),
    (err: unknown) => err instanceof BlueprintDocumentError && /schemaVersion 99/.test(err.message),
  );
});

test("câmera default ({}) não gera comando no replay", async () => {
  const store = new BlueprintStore();
  const commands = documentToCommands(exportBlueprint(store));
  assert.deepEqual(commands, []);
  assert.equal(store.isEmpty, true);
});
