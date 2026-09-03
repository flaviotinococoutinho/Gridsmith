/**
 * Driver do lado do EDITOR para `scripts/verify-visual-parity.sh` (ADR-022).
 *
 * Papel: (1) resolver o IntGrid do cenário em tiles pelo MESMO AutoTiler que
 * a projeção usa em produção — a engine nunca resolve, ela recebe resolvido;
 * (2) compor a lista de quads com o espelho puro (`core/frameDescription`);
 * (3) escrever o cenário RESOLVIDO para o driver da engine e a descrição do
 * editor para o diff. O shell roda a engine sobre o mesmo cenário e compara
 * BYTE a BYTE.
 *
 * O cenário fixa deliberadamente: célula parcialmente visível na borda do
 * recorte (a regra do `+1`), tiles sem arte (-1 não vira quad), ator fora do
 * recorte (culling com meia-extensão) e ator em meia-célula (âncora no
 * centro) — cada armadilha da composição vira uma diferença visível no diff
 * se um dos lados regredir. Números só em frações binárias exatas: paridade
 * byte a byte não pode depender de arredondamento decimal.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveAutoTiles } from "@gridsmith/middleware/dist/leveldesign/AutoTiler.js";
import {
  composeFrame,
  describeFrame,
  type FrameActorState,
  type FrameLevelState,
  type FrameViewportState,
} from "../core/frameDescription.js";

const outDir = process.argv[process.argv.indexOf("--out-dir") + 1];
if (!outDir || outDir.startsWith("--")) {
  console.error("uso: parity-driver --out-dir <dir>");
  process.exit(2);
}

// ---------------------------------------------------------------- cenário

const WIDTH = 12;
const HEIGHT = 8;
const TILE_SIZE = 16;
const SEED = 7;

// chão na metade de baixo, uma coluna de parede, um vão sem significado
const intGrid = new Array<number>(WIDTH * HEIGHT).fill(0);
for (let x = 0; x < WIDTH; x++) {
  for (let y = 5; y < HEIGHT; y++) intGrid[y * WIDTH + x] = 1;
}
for (let y = 2; y < 5; y++) intGrid[y * WIDTH + 3] = 2;
intGrid[5 * WIDTH + 7] = 0; // buraco: tile -1 no resolvido

const rules = [
  { patternSize: 1, pattern: [1], tileIds: [4, 5] },
  { patternSize: 1, pattern: [2], tileIds: [9] },
];

const { tiles } = resolveAutoTiles(
  { width: WIDTH, height: HEIGHT, values: intGrid },
  rules as never,
  SEED,
);

const level: FrameLevelState = { width: WIDTH, height: HEIGHT, tileSize: TILE_SIZE, tiles: [...tiles] };

const actors: FrameActorState[] = [
  // ator COM sprite (documento v6): o tile da definição chega ao quad
  { x: 56, y: 72, tileId: 9 }, // centro de célula (ENTITY_ANCHOR = center)
  // ator SEM sprite: continua em -1 e cai na cor determinística — os dois
  // casos no mesmo cenário, senão o gate passaria cobrindo só um deles
  { x: 100.5, y: 40.25 }, // fração binária exata — âncora desloca o canto
  { x: 4000, y: 4000, tileId: 3 }, // fora do recorte: o culling corta antes da arte
];

// recorte que TERMINA no meio de uma célula: exercita a regra da célula
// parcial da borda (o `+1` que evita a tira preta)
const viewport: FrameViewportState = { centerX: 68, centerY: 52, width: 136, height: 88, zoom: 1 };
const ACTOR_SIZE = 16; // o MESMO hardcoded do host (GridsmithGame)

// ------------------------------------------------------------------ saída

fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  path.join(outDir, "scenario.json"),
  JSON.stringify(
    {
      level: { width: WIDTH, height: HEIGHT, tileSize: TILE_SIZE, tiles: [...tiles] },
      actors: actors.map((actor, index) => ({
        entityId: `ator-${index}`,
        x: actor.x,
        y: actor.y,
        // o cenário carrega o tileset junto: sem ele o store da engine
        // normaliza o tile para -1, e o gate compararia arte contra ausência
        ...(actor.tileId === undefined
          ? {}
          : { spriteTilesetId: "terreno", spriteTileId: actor.tileId }),
      })),
      viewport,
      actorSize: ACTOR_SIZE,
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(outDir, "editor-frame.txt"),
  describeFrame(composeFrame(level, actors, viewport, ACTOR_SIZE)),
);

console.log(`[parity] cenário e descrição do editor escritos em ${outDir}`);
