import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  migrateBlueprintDocument,
  replayDocument,
} from "../src/canonical/BlueprintSerializer.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { BlueprintStore } from "../src/domain/BlueprintStore.js";

/**
 * O exemplo versionado (D5) é a primeira coisa que um avaliador abre. Ele é
 * gerado por `scripts/make-example-project.mjs`, mas quem garante que ele
 * ABRE é este teste: um exemplo que só é JSON válido falharia na validação
 * canônica, e o avaliador conheceria o produto pela mensagem de erro.
 */
const EXAMPLE_DIR = path.join(import.meta.dirname, "..", "..", "examples", "plataforma-2d");
const EXAMPLE_FILE = path.join(EXAMPLE_DIR, "plataforma-2d.gridsmith.json");

const readExample = (): Record<string, unknown> =>
  JSON.parse(readFileSync(EXAMPLE_FILE, "utf8")) as Record<string, unknown>;

test("o exemplo versionado está na versão CORRENTE do documento", () => {
  // um bump de versão sem regenerar o exemplo o deixaria migrando na abertura:
  // funciona, mas o arquivo distribuído deixa de ser o que o produto escreve
  assert.equal(readExample()["schemaVersion"], BLUEPRINT_DOCUMENT_VERSION);
});

test("o exemplo reproduz pelo caminho canônico, comando a comando", async () => {
  const document = migrateBlueprintDocument(readExample());
  const store = new BlueprintStore();
  const summary = await replayDocument(document, store, new CanonicalOrchestrator(store, new HookBus()));

  assert.ok(summary.applied > 0, "o exemplo não pode ser um documento vazio");
  assert.equal(store.listLevels().length, 1);
  assert.equal(store.listEntities().length, 1);
  assert.equal(store.listTilesets().length, 1);
});

test("o exemplo NÃO inventa arte: a imagem do atlas existe ao lado do documento", () => {
  const document = migrateBlueprintDocument(readExample());
  const [tileset] = document.tilesets ?? [];
  assert.ok(tileset, "o exemplo declara um atlas");
  // referência relativa ao documento é o que o main aceita (AtlasImagePath
  // recusa absoluto e qualquer coisa fora do diretório do projeto)
  assert.ok(!path.isAbsolute(tileset.image));
  assert.ok(
    existsSync(path.join(EXAMPLE_DIR, tileset.image)),
    `o atlas "${tileset.image}" precisa estar versionado junto do exemplo`,
  );
});

test("o sprite do exemplo aponta um tile DENTRO do atlas que ele declara", () => {
  const document = migrateBlueprintDocument(readExample());
  const [tileset] = document.tilesets ?? [];
  const definition = (document.entityDefs ?? []).find((entry) => entry.sprite !== undefined);
  assert.ok(definition?.sprite, "o exemplo mostra a arte do ator (B6)");
  assert.equal(definition.sprite.tilesetId, tileset?.tilesetId);
  // fora da faixa não é erro em runtime — é o fallback conjunto. Mas num
  // exemplo seria a vitrine do produto mostrando o caminho degradado.
  assert.ok(definition.sprite.tileId >= 0 && definition.sprite.tileId < (tileset?.tileCount ?? 0));
});

test("o nível do exemplo usa o atlas e nomeia os significados que pinta", () => {
  const document = migrateBlueprintDocument(readExample());
  const [level] = document.levels ?? [];
  assert.ok(level);
  assert.equal(level.tilesetId, document.tilesets?.[0]?.tilesetId);
  // toda cor pintada tem nome na paleta: sem isso o editor mostraria "#888"
  // para um valor que o documento usa, que é a mentira que a D4 eliminou
  const painted = new Set(level.intGrid.filter((value) => value !== 0));
  for (const value of painted) {
    assert.ok(
      level.palette?.some((entry) => entry.value === value),
      `o valor ${value} é pintado no nível e precisa de entrada na paleta`,
    );
  }
});
