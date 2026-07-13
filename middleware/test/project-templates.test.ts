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

test("registro de templates expõe o Plataforma 2D", () => {
  assert.ok(PROJECT_TEMPLATES.some((t) => t.id === "platformer-2d"));

  const template = getProjectTemplate("platformer-2d");
  assert.ok(template);
  assert.equal(template!.create().levels.length, 1);
  assert.equal(getProjectTemplate("inexistente"), undefined);
});
