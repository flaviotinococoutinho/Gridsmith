import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  exportBlueprint,
  replayDocument,
} from "../src/canonical/BlueprintSerializer.js";
import {
  PROJECT_TEMPLATES,
  createPlatformer2DDocument,
  getProjectTemplate,
} from "../src/canonical/ProjectTemplates.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { BlueprintStore } from "../src/domain/BlueprintStore.js";
import { cellToWorldCenter } from "../src/leveldesign/GridCoordinates.js";

test("o template Plataforma 2D é um documento válido da versão corrente", () => {
  const doc = createPlatformer2DDocument();
  assert.equal(doc.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.equal(doc.levels.length, 1);
  assert.equal(doc.entityDefs.length, 1);
  assert.equal(doc.entities.length, 1);
  assert.equal(doc.placements.length, 1);

  const level = doc.levels[0]!;
  assert.equal(level.intGrid.length, level.width * level.height);
});

test("o template reproduz pelo caminho canônico num projeto vazio", async () => {
  const doc = createPlatformer2DDocument();
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());

  const summary = await replayDocument(doc, store, orchestrator);

  // camera + light + entityDef + entity + level + world/place = 6 comandos
  assert.equal(summary.applied, 6);
  assert.equal(store.listLevels().length, 1);
  assert.equal(store.listEntities().length, 1);
  assert.equal(store.listEntityDefs().length, 1);
});

test("persistência do template é sem perdas (export → replay → export idêntico)", async () => {
  const doc = createPlatformer2DDocument();

  const store1 = new BlueprintStore();
  await replayDocument(doc, store1, new CanonicalOrchestrator(store1, new HookBus()));
  const exported1 = exportBlueprint(store1);

  const store2 = new BlueprintStore();
  await replayDocument(exported1, store2, new CanonicalOrchestrator(store2, new HookBus()));
  const exported2 = exportBlueprint(store2);

  assert.deepEqual(exported2, exported1);
});

test("roundtrip de sessão preserva metadata customizada do template", async () => {
  const document = createPlatformer2DDocument({
    projectId: "custom-roundtrip",
    name: "Roundtrip customizado",
    referenceResolution: { width: 1600, height: 900 },
    tileSize: 24,
  });
  const store = new BlueprintStore();
  await replayDocument(document, store, new CanonicalOrchestrator(store, new HookBus()));

  const exported = exportBlueprint(store, document.projectId, document.metadata);
  assert.equal(exported.projectId, document.projectId);
  assert.deepEqual(exported.metadata, document.metadata);
  assert.equal(exported.levels[0]?.tileSize, 24);
});

test("registro de templates expõe o Plataforma 2D", () => {
  assert.ok(PROJECT_TEMPLATES.some((t) => t.id === "platformer-2d"));

  const template = getProjectTemplate("platformer-2d");
  assert.ok(template);
  assert.equal(template!.create().levels.length, 1);
  assert.equal(template!.preview.kind, "level-schematic");
  assert.equal(template!.defaults.tileSize, 16);
  assert.equal(getProjectTemplate("inexistente"), undefined);
});

test("Novo Plataforma 2D parametriza metadata/tile e preserva IDs reais", () => {
  const doc = createPlatformer2DDocument({
    projectId: "meu-projeto",
    name: "Meu jogo",
    referenceResolution: { width: 1920, height: 1080 },
    tileSize: 32,
  });

  assert.equal(doc.projectId, "meu-projeto");
  assert.equal(doc.metadata.name, "Meu jogo");
  assert.deepEqual(doc.metadata.referenceResolution, { width: 1920, height: 1080 });
  assert.equal(doc.metadata.spatial.positionUnit, "world-pixel");
  assert.equal(doc.levels[0]?.levelId, "level-1");
  assert.equal(doc.levels[0]?.tileSize, 32);
  assert.equal(doc.entityDefs[0]?.entityDefId, "player");
  assert.equal(doc.entities[0]?.entityId, "player-1");
  assert.deepEqual(doc.entities[0]?.position, cellToWorldCenter({ x: 2, y: 7 }, 32));
  assert.equal(doc.lights[0]?.lightId, "key-light");
  assert.ok(Object.keys(doc.camera).length > 0);

  assert.equal(createPlatformer2DDocument({ tileSize: 256 }).levels[0]?.tileSize, 256);
  assert.throws(() => createPlatformer2DDocument({ tileSize: 257 }), /between 1 and 256/);
});
