/**
 * Impressões digitais dos documentos v2 que EXISTEM NO MUNDO.
 *
 * A migração 2 → 3 precisa decidir uma coisa perigosa: converter ou não as
 * posições de célula para pixel. Converter um documento que já está em pixels
 * multiplica as coordenadas por 16 e joga tudo para fora do nível; NÃO
 * converter um documento que está em células deixa o player dentro da célula
 * (0,0). Nenhuma heurística sobre a MAGNITUDE do número resolve isso — "3" é
 * uma célula plausível e um pixel plausível.
 *
 * A saída é não adivinhar. Só três documentos v2 foram produzidos por builds
 * do P7M, e todos os três são conhecidos byte a byte: o template de plataforma
 * ANTES da correção de unidade (em células), o mesmo template DEPOIS dela (em
 * pixels) e o template top-down (em pixels, nasceu depois da correção).
 * Qualquer outro documento v2 é de origem desconhecida — projeto real, edição
 * manual, agente — e NUNCA tem coordenada convertida.
 *
 * Os shapes abaixo são CONGELADOS: descrevem documentos que já foram gravados
 * em disco e que, por definição, não mudam mais. Eles são deliberadamente
 * duplicados de `ProjectTemplates.ts` em vez de reaproveitados — os templates
 * continuam evoluindo, e uma impressão digital que acompanhasse essa evolução
 * deixaria de reconhecer os arquivos antigos exatamente quando fosse
 * necessária. `middleware/test/blueprint-migration.test.ts` prova que cada
 * shape ainda casa com sua fixture em `test/fixtures/documents/`.
 */

import { createHash } from "node:crypto";

/** O que a migração faz ao reconhecer a origem de um documento. */
export interface LegacyOrigin {
  /** Nome de produto que a metadata v3 recebe. */
  readonly projectName: string;
  /** Se as posições estão em CÉLULA e precisam virar pixel. */
  readonly positionsInCells: boolean;
}

const SOLID = 1;
const EMPTY = 0;

const PLATFORMER_WIDTH = 16;
const PLATFORMER_HEIGHT = 9;
const TILE_SIZE = 16;

const TOPDOWN_WIDTH = 20;
const TOPDOWN_HEIGHT = 14;

function platformerIntGrid(): number[] {
  const grid = new Array<number>(PLATFORMER_WIDTH * PLATFORMER_HEIGHT).fill(EMPTY);
  for (let x = 0; x < PLATFORMER_WIDTH; x++) {
    grid[(PLATFORMER_HEIGHT - 1) * PLATFORMER_WIDTH + x] = SOLID;
  }
  for (let y = 0; y < PLATFORMER_HEIGHT; y++) {
    grid[y * PLATFORMER_WIDTH + 0] = SOLID;
    grid[y * PLATFORMER_WIDTH + (PLATFORMER_WIDTH - 1)] = SOLID;
  }
  return grid;
}

function topDownIntGrid(): number[] {
  const grid = new Array<number>(TOPDOWN_WIDTH * TOPDOWN_HEIGHT).fill(EMPTY);
  const at = (x: number, y: number): number => y * TOPDOWN_WIDTH + x;
  for (let x = 0; x < TOPDOWN_WIDTH; x++) {
    grid[at(x, 0)] = SOLID;
    grid[at(x, TOPDOWN_HEIGHT - 1)] = SOLID;
  }
  for (let y = 0; y < TOPDOWN_HEIGHT; y++) {
    grid[at(0, y)] = SOLID;
    grid[at(TOPDOWN_WIDTH - 1, y)] = SOLID;
  }
  for (let y = 4; y <= 5; y++) {
    for (let x = 5; x <= 7; x++) grid[at(x, y)] = SOLID;
  }
  for (let y = 8; y <= 9; y++) {
    for (let x = 12; x <= 14; x++) grid[at(x, y)] = SOLID;
  }
  return grid;
}

type Fields = Record<string, unknown>;

function platformerV2(
  playerPosition: readonly [number, number],
  lightPosition: readonly [number, number],
  playerFields: Fields,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    projectId: "template-platformer-2d",
    skeletons: [],
    meshes: [],
    camera: { frequency: 2, damping: 1, response: 2, anticipationSeconds: 0.15 },
    lights: [
      {
        lightId: "key-light",
        type: "point",
        position: lightPosition,
        height: 1,
        color: [1, 1, 1],
        intensity: 1.2,
        radius: 240,
      },
    ],
    entityDefs: [
      {
        entityDefId: "player",
        archetypeId: "player",
        tags: ["player"],
        editor: { color: "#3aa0ff" },
        fields: [
          { name: "speed", type: "float", default: 90 },
          { name: "jumpVelocity", type: "float", default: 320 },
        ],
      },
    ],
    entities: [
      {
        entityId: "player-1",
        entityDefId: "player",
        position: playerPosition,
        fields: playerFields,
      },
    ],
    levels: [
      {
        levelId: "level-1",
        width: PLATFORMER_WIDTH,
        height: PLATFORMER_HEIGHT,
        tileSize: TILE_SIZE,
        seed: 1,
        intGrid: platformerIntGrid(),
        rules: [{ patternSize: 1, pattern: [SOLID], tileIds: [1] }],
      },
    ],
    placements: [{ levelId: "level-1", x: 0, y: 0 }],
  };
}

function topDownV2(heroFields: Fields): Record<string, unknown> {
  return {
    schemaVersion: 2,
    projectId: "template-top-down-2d",
    skeletons: [],
    meshes: [],
    camera: { frequency: 3, damping: 1.2, response: 0, anticipationSeconds: 0 },
    lights: [
      {
        lightId: "tocha",
        type: "point",
        position: [168, 120],
        height: 1,
        color: [1, 0.92, 0.75],
        intensity: 1.4,
        radius: 200,
      },
    ],
    entityDefs: [
      {
        entityDefId: "heroi",
        archetypeId: "player",
        tags: ["player"],
        editor: { color: "#f0a03a" },
        fields: [
          { name: "speed", type: "float", default: 70 },
          { name: "vida", type: "int", default: 3 },
        ],
      },
    ],
    entities: [
      { entityId: "heroi-1", entityDefId: "heroi", position: [56, 56], fields: heroFields },
    ],
    levels: [
      {
        levelId: "sala-1",
        width: TOPDOWN_WIDTH,
        height: TOPDOWN_HEIGHT,
        tileSize: TILE_SIZE,
        seed: 7,
        intGrid: topDownIntGrid(),
        rules: [{ patternSize: 1, pattern: [SOLID], tileIds: [1] }],
      },
    ],
    placements: [{ levelId: "sala-1", x: 0, y: 0 }],
  };
}

const PLATFORMER_FIELDS_MATERIALIZED: Fields = { speed: 90, jumpVelocity: 320 };
const TOPDOWN_FIELDS_MATERIALIZED: Fields = { speed: 70, vida: 3 };

const PLATFORMER_NAME = "Plataforma 2D";
const TOPDOWN_NAME = "Aventura top-down";

/**
 * Cada origem rende DOIS documentos, não um: o factory devolve a entidade com
 * `fields: {}`, e o que chega ao disco tem os defaults MATERIALIZADOS pelo
 * replay. As duas formas circulam, então as duas precisam ser reconhecidas.
 */
function buildFingerprints(): ReadonlyMap<string, LegacyOrigin> {
  const platformerCells: LegacyOrigin = { projectName: PLATFORMER_NAME, positionsInCells: true };
  const platformerPixels: LegacyOrigin = { projectName: PLATFORMER_NAME, positionsInCells: false };
  const topDown: LegacyOrigin = { projectName: TOPDOWN_NAME, positionsInCells: false };

  const entries: [Record<string, unknown>, LegacyOrigin][] = [
    // Plataforma ANTES da correção de unidade: posições em célula.
    [platformerV2([2, 7], [8, 4.5], {}), platformerCells],
    [platformerV2([2, 7], [8, 4.5], PLATFORMER_FIELDS_MATERIALIZED), platformerCells],
    // Plataforma DEPOIS da correção: já em pixels, não se converte nada.
    [platformerV2([40, 120], [136, 80], {}), platformerPixels],
    [platformerV2([40, 120], [136, 80], PLATFORMER_FIELDS_MATERIALIZED), platformerPixels],
    // Top-down nasceu depois da correção: sempre em pixels.
    [topDownV2({}), topDown],
    [topDownV2(TOPDOWN_FIELDS_MATERIALIZED), topDown],
  ];

  const map = new Map<string, LegacyOrigin>();
  for (const [shape, origin] of entries) {
    map.set(fingerprintOf(shape), origin);
  }
  return map;
}

let cached: ReadonlyMap<string, LegacyOrigin> | undefined;

/**
 * Origem conhecida de um documento v2, ou `undefined` para qualquer outro —
 * e "qualquer outro" inclui projeto real de usuário, que jamais tem
 * coordenada convertida.
 */
export function recognizeLegacyV2Document(
  document: Record<string, unknown>,
): LegacyOrigin | undefined {
  cached ??= buildFingerprints();
  return cached.get(fingerprintOf(document));
}

/** Exposto para o teste provar que os shapes ainda casam com as fixtures. */
export function fingerprintOf(document: unknown): string {
  return createHash("sha256").update(stableJson(document)).digest("hex");
}

/**
 * Serialização estável que IGNORA `projectId` em qualquer profundidade: dois
 * projetos criados do mesmo template têm ids diferentes e são, para efeito de
 * reconhecimento de origem, o mesmo documento.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => key !== "projectId")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
