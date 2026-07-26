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

/**
 * O contrato canônico mede o mundo em PIXELS (`contracts/schemas/
 * actors.methods.schema.json`: "Posição no mundo em pixels [x, y]") e nenhuma
 * camada converte unidade: o middleware repassa cru e a engine consome cru.
 * Um template escrito em CÉLULAS coloca o Player e a luz dentro da célula
 * (0,0) — visualmente colados na origem. Este teste trava a unidade.
 */
test("o template posiciona em pixels do mundo, não em células", () => {
  const doc = createPlatformer2DDocument();
  const level = doc.levels[0]!;
  const worldWidth = level.width * level.tileSize;
  const worldHeight = level.height * level.tileSize;

  const player = doc.entities[0]!;
  const [px, py] = player.position;

  // se estivesse em células, ambos cairiam dentro do primeiro tile
  assert.ok(
    px >= level.tileSize || py >= level.tileSize,
    `posição do player ${JSON.stringify(player.position)} cabe dentro de uma única célula ` +
      `(${level.tileSize}px): está em células, não em pixels do mundo`,
  );
  // dentro do nível
  assert.ok(px > 0 && px < worldWidth, "player fora do nível no eixo x");
  assert.ok(py > 0 && py < worldHeight, "player fora do nível no eixo y");

  // em pé sobre o chão: a última linha é sólida, então o player fica na
  // penúltima — e não flutuando no topo nem enterrado
  const playerCellY = Math.floor(py / level.tileSize);
  assert.equal(playerCellY, level.height - 2, "player não está apoiado no chão");
  const groundIndex = (level.height - 1) * level.width + Math.floor(px / level.tileSize);
  assert.equal(level.intGrid[groundIndex], 1, "não há chão sólido abaixo do player");

  // a luz vive no MESMO espaço do seu raio (ambos em pixels)
  const light = doc.lights[0]!;
  const [lx, ly] = light.position;
  assert.ok(
    lx > level.tileSize && ly > level.tileSize,
    `posição da luz ${JSON.stringify(light.position)} está em células enquanto radius ` +
      `(${light.radius}) está em pixels — unidades incoerentes no mesmo objeto`,
  );
  assert.ok(lx < worldWidth && ly < worldHeight, "luz fora do retângulo do nível");
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
