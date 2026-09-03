import assert from "node:assert/strict";
import test from "node:test";
import { BlueprintStore, type EntityDefinition, type TilesetSpec } from "../src/domain/BlueprintStore.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  DEFAULT_PROJECT_METADATA,
  documentToCommands,
  exportBlueprint,
  migrateBlueprintDocument,
  replayDocument,
} from "../src/canonical/BlueprintSerializer.js";

const TILESET: TilesetSpec = {
  tilesetId: "terreno",
  image: "assets/terreno.png",
  tileSize: 16,
  columns: 8,
  tileCount: 48,
};

const comSprite = (tileId: number): EntityDefinition => ({
  entityDefId: "player",
  fields: [],
  archetypeId: "player",
  sprite: { tilesetId: "terreno", tileId },
});

function store(): BlueprintStore {
  const s = new BlueprintStore();
  s.apply({ kind: "tileset/define", tileset: TILESET });
  return s;
}

test("o sprite entra na definição e sobrevive ao round-trip do documento", () => {
  const s = store();
  s.apply({ kind: "entitydef/define", definition: comSprite(12) });

  const exportado = exportBlueprint(s, "proj-1", DEFAULT_PROJECT_METADATA);
  assert.equal(exportado.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.deepEqual(exportado.entityDefs[0]?.sprite, { tilesetId: "terreno", tileId: 12 });
});

test("sprite aponta para arte que EXISTE: tileset ausente é recusado", () => {
  const s = new BlueprintStore(); // sem tileset nenhum
  assert.throws(
    () => s.apply({ kind: "entitydef/define", definition: comSprite(0) }),
    /Tileset "terreno" is not defined/,
  );
});

test("tileId fora do atlas é ENGANO, não degradação — o domínio recusa", () => {
  // a diferença com o tile de célula é deliberada: aquele é DERIVADO pelo
  // AutoTiler e pode cair na cor determinística; este foi ESCOLHIDO por
  // alguém, e aceitar o índice inválido viraria um quadrado colorido
  // permanente que ninguém consegue explicar
  const s = store();
  assert.throws(
    () => s.apply({ kind: "entitydef/define", definition: comSprite(48) }),
    /Tile 48 is outside tileset "terreno" \(48 tiles\)/,
  );
  // o último índice válido passa — a fronteira é exclusiva no topo
  assert.doesNotThrow(() => s.apply({ kind: "entitydef/define", definition: comSprite(47) }));
});

test("sprite malformado é recusado com a razão do campo", () => {
  const s = store();
  const invalido = (sprite: unknown): EntityDefinition =>
    ({ entityDefId: "x", fields: [], sprite }) as unknown as EntityDefinition;

  assert.throws(() => s.apply({ kind: "entitydef/define", definition: invalido({ tileId: 1 }) }), /sprite.tilesetId/);
  assert.throws(
    () => s.apply({ kind: "entitydef/define", definition: invalido({ tilesetId: "terreno", tileId: -1 }) }),
    /sprite.tileId/,
  );
  assert.throws(
    () => s.apply({ kind: "entitydef/define", definition: invalido({ tilesetId: "terreno", tileId: 1.5 }) }),
    /sprite.tileId/,
  );
});

test("tileset de sprite não pode ser removido enquanto referenciado", () => {
  const s = store();
  s.apply({ kind: "entitydef/define", definition: comSprite(12) });

  assert.throws(
    () => s.apply({ kind: "tileset/remove", tilesetId: "terreno" }),
    /still used by 1 entity definition/,
  );
});

test("o replay define o TILESET antes da definição que o referencia", async () => {
  // sem esta ordem, reabrir um projeto com sprite falharia por ordem: o
  // documento estaria correto e a reidratação o recusaria
  const origem = store();
  origem.apply({ kind: "entitydef/define", definition: comSprite(3) });
  const documento = exportBlueprint(origem, "proj-1", DEFAULT_PROJECT_METADATA);

  const kinds = documentToCommands(structuredClone(documento) as unknown).map((c) => c.kind);
  assert.ok(
    kinds.indexOf("tileset/define") < kinds.indexOf("entitydef/define"),
    `tileset/define precisa vir antes de entitydef/define (ordem: ${kinds.join(", ")})`,
  );

  const destino = new BlueprintStore();
  await replayDocument(
    migrateBlueprintDocument(structuredClone(documento) as unknown),
    destino,
    new CanonicalOrchestrator(destino, new HookBus()),
  );
  assert.deepEqual(destino.listEntityDefs()[0]?.sprite, { tilesetId: "terreno", tileId: 3 });
});

test("migração 5 → 6 NÃO inventa arte", () => {
  // dar sprite a toda definição antiga colocaria no Player de cada projeto um
  // desenho que o dono nunca escolheu
  const v5 = {
    schemaVersion: 5,
    projectId: "proj-1",
    metadata: DEFAULT_PROJECT_METADATA,
    camera: {},
    entityDefs: [{ entityDefId: "player", fields: [], archetypeId: "player" }],
    tilesets: [TILESET],
    levels: [],
    entities: [],
    skeletons: [],
    meshes: [],
    lights: [],
    placements: [],
  };

  const migrado = migrateBlueprintDocument(v5);
  assert.equal(migrado.schemaVersion, 6);
  assert.equal(migrado.entityDefs[0]?.sprite, undefined);
});
