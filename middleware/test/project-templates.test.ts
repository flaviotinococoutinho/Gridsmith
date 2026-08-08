import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { HookBus } from "../src/canonical/HookBus.js";
import { ProjectSessionManager } from "../src/canonical/ProjectSessionManager.js";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  DEFAULT_PROJECT_METADATA,
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
for (const template of PROJECT_TEMPLATES) {
  test(`template "${template.id}" posiciona em pixels do mundo, não em células`, () => {
  const doc = template.create();
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

  // invariante universal (vale para plataforma E top-down): a entidade não
  // nasce DENTRO de parede. "Apoiada no chão" é específico de plataforma e
  // está no teste próprio do platformer, abaixo.
  const cellX = Math.floor(px / level.tileSize);
  const cellY = Math.floor(py / level.tileSize);
  assert.equal(
    level.intGrid[cellY * level.width + cellX],
    0,
    `entidade nasce dentro de célula sólida (${cellX}, ${cellY})`,
  );

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
}

/**
 * Todo template registrado precisa ser um documento válido e reprodutível —
 * um template quebrado só apareceria quando o usuário o escolhesse.
 */
for (const template of PROJECT_TEMPLATES) {
  test(`template "${template.id}" é válido e reproduz pelo caminho canônico`, async () => {
    assert.ok(template.label.length > 0, "template sem rótulo humano");
    assert.ok(template.description.length > 0, "template sem descrição");

    const doc = template.create();
    assert.equal(doc.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
    assert.ok(doc.projectId.length > 0, "template sem projectId");
    const level = doc.levels[0]!;
    assert.equal(level.intGrid.length, level.width * level.height);

    // toda entidade aponta para uma definição existente, e a definição usada
    // precisa ter archetypeId — sem ele nada vira ator vivo no runtime
    for (const entity of doc.entities) {
      const definition = doc.entityDefs.find((d) => d.entityDefId === entity.entityDefId);
      assert.ok(definition, `entidade ${entity.entityId} sem definição no documento`);
      assert.ok(
        (definition?.archetypeId ?? "").length > 0,
        `definição ${entity.entityDefId} sem archetypeId: a entidade nunca spawnaria`,
      );
    }
    // todo placement aponta para um nível existente
    for (const placement of doc.placements) {
      assert.ok(
        doc.levels.some((l) => l.levelId === placement.levelId),
        `placement aponta para nível inexistente ${placement.levelId}`,
      );
    }

    const store = new BlueprintStore();
    const orchestrator = new CanonicalOrchestrator(store, new HookBus());
    const summary = await replayDocument(doc, store, orchestrator);
    // todo comando do documento é aplicado: nível, definição, entidade, luz,
    // câmera e placement. Um template que não reproduz inteiro só apareceria
    // quebrado na mão do usuário que o escolhesse.
    assert.ok(summary.applied > 0, "replay do template não aplicou nada");
    assert.equal(store.listLevels().length, doc.levels.length);
    assert.equal(store.listEntities().length, doc.entities.length);
  });
}

test("os ids dos templates são únicos e resolvem por getProjectTemplate", () => {
  const ids = PROJECT_TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "há template com id duplicado");
  for (const id of ids) assert.equal(getProjectTemplate(id)?.id, id);
  assert.equal(getProjectTemplate("inexistente"), undefined);
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

test("o DOMÍNIO do template atravessa export → replay → export sem perdas", async () => {
  // Escopo honesto: isto prova o round-trip do que o STORE guarda. A metadata
  // NÃO é estado do store — ela vive na sessão —, então os dois lados passam a
  // default explicitamente e este teste não diz nada sobre preservação de
  // nome. Quem prova isso é "o nome do projeto sobrevive ao ciclo criar →
  // salvar → reabrir", que percorre sessão e superfície.
  const doc = createPlatformer2DDocument();

  const store1 = new BlueprintStore();
  await replayDocument(doc, store1, new CanonicalOrchestrator(store1, new HookBus()));
  const exported1 = exportBlueprint(store1, undefined, DEFAULT_PROJECT_METADATA);

  const store2 = new BlueprintStore();
  await replayDocument(exported1, store2, new CanonicalOrchestrator(store2, new HookBus()));
  const exported2 = exportBlueprint(store2, undefined, DEFAULT_PROJECT_METADATA);

  assert.deepEqual(exported2, exported1);
});

test("registro de templates expõe o Plataforma 2D", () => {
  assert.ok(PROJECT_TEMPLATES.some((t) => t.id === "platformer-2d"));

  const template = getProjectTemplate("platformer-2d");
  assert.ok(template);
  assert.equal(template!.create().levels.length, 1);
  assert.equal(getProjectTemplate("inexistente"), undefined);
});

test("platformer: o Player nasce apoiado sobre o chão sólido", () => {
  const doc = createPlatformer2DDocument();
  const level = doc.levels[0]!;
  const [px, py] = doc.entities[0]!.position;
  const cellY = Math.floor(py / level.tileSize);
  const cellX = Math.floor(px / level.tileSize);
  // a última linha é sólida: o player fica na penúltima, nem flutuando nem enterrado
  assert.equal(cellY, level.height - 2, "player não está apoiado no chão");
  assert.equal(level.intGrid[(level.height - 1) * level.width + cellX], 1, "sem chão abaixo");
});

test("o nome do projeto sobrevive ao ciclo criar → salvar → reabrir", async () => {
  // Este é o invariante que justifica `metadata` viver na SESSÃO e não só no
  // arquivo. Sem ele, exportar reexportaria a metadata default e o primeiro
  // save apagaria o nome — um round-trip que perde dado é pior do que não ter
  // o campo. O teste percorre o caminho real: sessão → documento → sessão.
  const sessions = new ProjectSessionManager({ hooks: new HookBus() });

  const criado = (await sessions.createFromTemplate("top-down-2d", "meu-projeto")).session;
  const documento = exportBlueprint(criado.store, criado.projectId, criado.metadata);
  assert.equal(documento.metadata.name, "Aventura top-down");

  // o que iria para o disco, e volta dele
  const reaberto = (
    await sessions.prepareFromDocument(JSON.parse(JSON.stringify(documento)) as unknown)
  ).session;

  assert.equal(reaberto.metadata.name, documento.metadata.name);
  assert.deepEqual(
    exportBlueprint(reaberto.store, reaberto.projectId, reaberto.metadata),
    documento,
  );
});

test("abrir um projeto v2 legado entra na sessão já com nome e coordenadas corretos", async () => {
  const sessions = new ProjectSessionManager({ hooks: new HookBus() });
  const legado = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures", "documents", "v2-platformer-base.json"),
      "utf8",
    ),
  ) as unknown;

  const sessao = (await sessions.prepareFromDocument(legado)).session;

  assert.equal(sessao.metadata.name, "Plataforma 2D");
  assert.deepEqual(sessao.store.listEntities()[0]?.position, [40, 120]);
});
