#!/usr/bin/env node
/**
 * Gera o projeto de exemplo versionado
 * (`examples/plataforma-2d/plataforma-2d.gridsmith.json`).
 *
 * O documento NÃO é escrito à mão: o script monta o conteúdo, reproduz cada
 * item pelo caminho canônico (`documentToCommands` → `CanonicalOrchestrator`)
 * num store novo e serializa o RESULTADO com `exportBlueprint`. O arquivo
 * versionado é, então, a serialização que o próprio middleware produz — não
 * uma imitação dela que passaria a divergir na primeira mudança de formato.
 *
 * Pré-requisito: `cd middleware && npm run build` (o script importa o `dist`).
 *
 * Uso: node scripts/make-example-project.mjs [--check]
 *   --check  não escreve; falha se o documento versionado divergir do gerado.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "examples/plataforma-2d/plataforma-2d.gridsmith.json");
const DIST = resolve(ROOT, "middleware/dist");

const { BlueprintStore } = await import(`${DIST}/domain/BlueprintStore.js`);
const { CanonicalOrchestrator } = await import(`${DIST}/canonical/CanonicalOrchestrator.js`);
const { HookBus } = await import(`${DIST}/canonical/HookBus.js`);
const { exportBlueprint, replayDocument, BLUEPRINT_DOCUMENT_VERSION, DEFAULT_PROJECT_SPATIAL } =
  await import(`${DIST}/canonical/BlueprintSerializer.js`);

const WIDTH = 32;
const HEIGHT = 18;
const TILE_SIZE = 16;
const EMPTY = 0;
const SOLID = 1;
const STONE = 2;
/** O tile do jogador dentro do atlas 4×4 gerado por `make-example-atlas.mjs`. */
const PLAYER_TILE = 8;

/**
 * Nível desenhado por composição, não por ruído: chão, paredes, duas
 * plataformas e um bloco de pedra. O avaliador precisa reconhecer um nível de
 * plataforma no primeiro olhar — um grid aleatório não comunicaria nada.
 */
function intGrid() {
  const grid = new Array(WIDTH * HEIGHT).fill(EMPTY);
  const put = (x, y, value) => {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) grid[y * WIDTH + x] = value;
  };

  for (let x = 0; x < WIDTH; x++) {
    put(x, HEIGHT - 1, SOLID);
    put(x, HEIGHT - 2, SOLID);
  }
  for (let y = 0; y < HEIGHT; y++) {
    put(0, y, SOLID);
    put(WIDTH - 1, y, SOLID);
  }
  for (let x = 5; x <= 11; x++) put(x, HEIGHT - 6, SOLID);
  for (let x = 16; x <= 23; x++) put(x, HEIGHT - 9, SOLID);
  for (let y = HEIGHT - 5; y <= HEIGHT - 3; y++) {
    for (let x = 25; x <= 28; x++) put(x, y, STONE);
  }
  return grid;
}

/** Centro da célula, a mesma convenção do documento (ENTITY_ANCHOR = center). */
const cellCenter = (x, y) => [x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE + TILE_SIZE / 2];

const document = {
  schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
  projectId: "exemplo-plataforma-2d",
  metadata: {
    name: "Plataforma 2D — exemplo",
    referenceResolution: { width: WIDTH * TILE_SIZE, height: HEIGHT * TILE_SIZE },
    // a convenção espacial vem do middleware, não de uma cópia aqui: repetir
    // os quatro literais criaria uma segunda fonte de verdade para a v3
    spatial: DEFAULT_PROJECT_SPATIAL,
  },
  skeletons: [],
  meshes: [],
  camera: { frequency: 2, damping: 1, response: 2, anticipationSeconds: 0.15 },
  lights: [
    {
      lightId: "luz-principal",
      type: "point",
      position: [(WIDTH * TILE_SIZE) / 2, (HEIGHT * TILE_SIZE) / 2],
      height: 1,
      color: [1, 1, 1],
      intensity: 1.2,
      radius: 260,
    },
  ],
  // o atlas vem do PNG versionado ao lado — a referência é relativa ao
  // documento, que é o que o main aceita (AtlasImagePath recusa o resto)
  tilesets: [
    {
      tilesetId: "atlas-exemplo",
      image: "assets/atlas.png",
      tileSize: TILE_SIZE,
      columns: 4,
      tileCount: 16,
    },
  ],
  entityDefs: [
    {
      entityDefId: "jogador",
      archetypeId: "player",
      tags: ["player"],
      editor: { color: "#3aa0ff" },
      fields: [
        { name: "speed", type: "float", default: 90 },
        { name: "jumpVelocity", type: "float", default: 320 },
      ],
      // B6: o ator aparece como ARTE, no canvas e na janela do host
      sprite: { tilesetId: "atlas-exemplo", tileId: PLAYER_TILE },
    },
  ],
  entities: [
    {
      entityId: "jogador-1",
      entityDefId: "jogador",
      position: cellCenter(3, HEIGHT - 3),
      fields: {},
    },
  ],
  levels: [
    {
      levelId: "nivel-1",
      width: WIDTH,
      height: HEIGHT,
      tileSize: TILE_SIZE,
      seed: 7,
      intGrid: intGrid(),
      // "pinte significado, derive arte": a primeira regra que casa vence, e
      // por isso a grama vem ANTES da terra — invertê-las cobriria o topo de
      // terra e o nível pareceria um bloco só
      rules: [
        {
          name: "grama no topo",
          patternSize: 3,
          pattern: [null, EMPTY, null, null, SOLID, null, null, null, null],
          tileIds: [2],
        },
        { name: "terra", patternSize: 1, pattern: [SOLID], tileIds: [1] },
        { name: "pedra", patternSize: 1, pattern: [STONE], tileIds: [3] },
      ],
      palette: [
        { value: SOLID, name: "Sólido", color: "#7a5436" },
        { value: STONE, name: "Pedra", color: "#7e828c" },
      ],
      tilesetId: "atlas-exemplo",
    },
  ],
  placements: [{ levelId: "nivel-1", x: 0, y: 0 }],
};

// A prova de que o exemplo é abrível: ele passa pelo MESMO caminho que o
// "Abrir projeto" usa. Um documento que só fosse JSON válido poderia falhar na
// validação canônica e o avaliador descobriria isso pelo erro.
const store = new BlueprintStore();
const orchestrator = new CanonicalOrchestrator(store, new HookBus());
const summary = await replayDocument(document, store, orchestrator);
const serialized = exportBlueprint(store, document.projectId, document.metadata);
const json = `${JSON.stringify(serialized, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current;
  try {
    current = readFileSync(OUTPUT, "utf8");
  } catch {
    console.error(`[exemplo] ${OUTPUT} não existe — rode: node scripts/make-example-project.mjs`);
    process.exit(1);
  }
  if (current !== json) {
    console.error("[exemplo] o documento versionado difere do gerado — regenere e commite.");
    process.exit(1);
  }
  console.log(`[exemplo] OK — ${summary.applied} comandos reproduzidos, v${serialized.schemaVersion}.`);
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, json);
  console.log(
    `[exemplo] escrito ${OUTPUT} — ${summary.applied} comandos, v${serialized.schemaVersion}.`,
  );
}
