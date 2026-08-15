import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  documentToCommands,
  exportBlueprint,
  DEFAULT_PROJECT_METADATA,
  migrateBlueprintDocument,
} from "../src/canonical/BlueprintSerializer.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import {
  BlueprintStore,
  type LevelSpec,
  type TilesetSpec,
} from "../src/domain/BlueprintStore.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "documents");

const tileset = (tilesetId = "terreno"): TilesetSpec => ({
  tilesetId,
  image: "assets/terreno.png",
  tileSize: 16,
  columns: 8,
  tileCount: 48,
});

const level = (levelId: string, tilesetId?: string): LevelSpec => ({
  levelId,
  width: 4,
  height: 4,
  tileSize: 16,
  seed: 1,
  intGrid: new Array<number>(16).fill(0),
  rules: [{ patternSize: 1, pattern: [1], tileIds: [1] }],
  ...(tilesetId === undefined ? {} : { tilesetId }),
});

// ------------------------------------------------------------ domínio

test("tileset/define valida a grade do atlas e recusa duplicata", () => {
  const store = new BlueprintStore();
  store.apply({ kind: "tileset/define", tileset: tileset() });
  assert.equal(store.getTileset("terreno")?.columns, 8);

  assert.throws(() => store.apply({ kind: "tileset/define", tileset: tileset() }), /already exists/);
  assert.throws(
    () => store.apply({ kind: "tileset/define", tileset: { ...tileset("x"), tileCount: 0 } }),
    /"tileCount"/,
  );
  // mais colunas que tiles: a fórmula produziria uma primeira linha com buracos
  assert.throws(
    () => store.apply({ kind: "tileset/define", tileset: { ...tileset("y"), columns: 64, tileCount: 8 } }),
    /at least "columns"/,
  );
});

test("nível que aponta para tileset inexistente é recusado NA ESCRITA", () => {
  const store = new BlueprintStore();
  assert.throws(
    () => store.apply({ kind: "level/define", level: level("l1", "nao-existe") }),
    /use tileset\/define first/,
  );

  store.apply({ kind: "tileset/define", tileset: tileset() });
  store.apply({ kind: "level/define", level: level("l1", "terreno") });
  assert.equal(store.getLevel("l1")?.tilesetId, "terreno");
});

test("remover tileset referenciado é recusado, não cascateado", () => {
  const store = new BlueprintStore();
  store.apply({ kind: "tileset/define", tileset: tileset() });
  store.apply({ kind: "level/define", level: level("l1", "terreno") });

  assert.throws(
    () => store.apply({ kind: "tileset/remove", tilesetId: "terreno" }),
    /still used by 1 level/,
  );

  // solta a referência e a remoção passa
  store.apply({ kind: "level/update", level: level("l1") });
  store.apply({ kind: "tileset/remove", tilesetId: "terreno" });
  assert.equal(store.getTileset("terreno"), undefined);
});

test("define e remove são inversos um do outro no histórico canônico", async () => {
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());

  await orchestrator.dispatch({ kind: "tileset/define", tileset: tileset() }, { actor: "human" });
  assert.equal(orchestrator.history.status().undoLabel, "Criar tileset");

  await orchestrator.undo();
  assert.equal(store.listTilesets().length, 0, "desfazer o define remove o tileset");

  await orchestrator.redo();
  assert.deepEqual(store.getTileset("terreno"), tileset(), "refazer o traz de volta idêntico");

  await orchestrator.dispatch({ kind: "tileset/remove", tilesetId: "terreno" });
  await orchestrator.undo();
  assert.deepEqual(store.getTileset("terreno"), tileset(), "desfazer o remove restaura o spec");
});

// -------------------------------------------------------- documento v5

test("o documento v5 serializa tilesets e o round-trip preserva tudo", () => {
  const store = new BlueprintStore();
  store.apply({ kind: "tileset/define", tileset: tileset() });
  store.apply({ kind: "level/define", level: level("l1", "terreno") });

  const doc = exportBlueprint(store, "p1", DEFAULT_PROJECT_METADATA);
  assert.equal(doc.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.deepEqual(doc.tilesets, [tileset()]);

  // replay: tileset vem ANTES do nível, senão o define do nível recusaria
  const kinds = documentToCommands(structuredClone(doc)).map((c) => c.kind);
  assert.ok(
    kinds.indexOf("tileset/define") < kinds.indexOf("level/define"),
    `tileset precisa preceder o nível no replay (ordem: ${kinds.join(", ")})`,
  );
});

test("a fixture v4 congelada migra para v5 ganhando tilesets VAZIOS", () => {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, "v4-platformer.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(raw["schemaVersion"], 4, "a fixture está congelada em v4");

  const migrated = migrateBlueprintDocument(raw);
  assert.equal(migrated.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.deepEqual(migrated.tilesets, [], "a migração NÃO inventa arte: tilesetId é escolha, não default");
  // nenhum nível ganhou tilesetId por efeito colateral
  for (const migratedLevel of migrated.levels) {
    assert.equal(migratedLevel.tilesetId, undefined);
  }
});

test("um simulador de v2 contaminado com campos da v5 ainda é reconhecido", () => {
  // mesma jogada da paleta na v4: o fingerprint compara o documento v2
  // INTEIRO, e um factory novo pode vazar tilesets/tilesetId para dentro de
  // um doc que se declara v2 — sem o strip, a conversão de coordenadas do
  // template pré-correção pararia de disparar EM SILÊNCIO
  const base = JSON.parse(
    readFileSync(path.join(FIXTURES, "v2-platformer-base.json"), "utf8"),
  ) as Record<string, unknown>;
  const clean = migrateBlueprintDocument(structuredClone(base));

  const contaminated = structuredClone(base) as Record<string, unknown>;
  contaminated["tilesets"] = [tileset()];
  contaminated["levels"] = (contaminated["levels"] as Record<string, unknown>[]).map((l) => ({
    ...l,
    tilesetId: "terreno",
  }));
  const migrated = migrateBlueprintDocument(contaminated);

  assert.equal(
    migrated.metadata.name,
    clean.metadata.name,
    "a origem reconhecida sobrevive à contaminação",
  );
  assert.deepEqual(
    migrated.entities.map((e) => e.position),
    clean.entities.map((e) => e.position),
    "a conversão de coordenadas continua disparando",
  );
});
