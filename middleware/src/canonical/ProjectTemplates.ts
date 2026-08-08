/**
 * Templates de projeto (ALPHA-0.1, P0.2 — "Novo projeto de Plataforma 2D").
 *
 * Um template é uma FUNÇÃO PURA que produz um `BlueprintDocument` inicial e
 * válido. O fluxo "Novo projeto" apenas reproduz esse documento pelo caminho
 * canônico (mesmas validações, hooks e projeção de qualquer edição manual),
 * então o template não é um caso especial — é só um projeto de partida.
 */

import type {
  EntityDefinition,
  EntityInstance,
  LevelSpec,
  LightSpec,
  WorldPlacement,
} from "../domain/BlueprintStore.js";
import { cellToWorldCenter } from "../leveldesign/GridCoordinates.js";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  DEFAULT_PROJECT_METADATA,
  type BlueprintDocument,
  type ProjectMetadata,
} from "./BlueprintSerializer.js";

export interface ProjectTemplate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly create: () => BlueprintDocument;
}

const PLATFORMER_WIDTH = 16;
const PLATFORMER_HEIGHT = 9;
const PLATFORMER_TILE_SIZE = 16;
const SOLID = 1;
const EMPTY = 0;

/**
 * Centro do nível como o template historicamente o escreveu, em pixels.
 *
 * NÃO é `cellToWorldCenter`: o ponto cai em MEIA célula (`16/2, 9/2`), e a
 * função canônica recusa fração de propósito. Também não é o centro
 * geométrico do nível, que seria `[128, 72]` — a expressão original aplica a
 * fórmula de centro de célula a um índice fracionário e erra 8 px.
 *
 * O valor é preservado deliberadamente: mudá-lo moveria a luz de todo projeto
 * novo, e a migração 2 → 3 reproduz exatamente estes números para que abrir um
 * projeto antigo e criar um novo dêem o mesmo documento. Corrigir o desvio é
 * mudança de template, não de migração, e está registrada como pendência.
 */
function legacyLevelCenterPx(widthInCells: number, heightInCells: number): [number, number] {
  const axis = (cells: number): number =>
    (cells / 2) * PLATFORMER_TILE_SIZE + PLATFORMER_TILE_SIZE / 2;
  return [axis(widthInCells), axis(heightInCells)];
}

/** Metadata comum aos templates: só o nome varia. */
function templateMetadata(name: string): ProjectMetadata {
  return { ...DEFAULT_PROJECT_METADATA, name };
}

/** IntGrid de partida: chão na base + paredes nas laterais, resto vazio. */
function platformerIntGrid(): number[] {
  const grid = new Array<number>(PLATFORMER_WIDTH * PLATFORMER_HEIGHT).fill(EMPTY);
  for (let x = 0; x < PLATFORMER_WIDTH; x++) {
    grid[(PLATFORMER_HEIGHT - 1) * PLATFORMER_WIDTH + x] = SOLID; // chão
  }
  for (let y = 0; y < PLATFORMER_HEIGHT; y++) {
    grid[y * PLATFORMER_WIDTH + 0] = SOLID; // parede esquerda
    grid[y * PLATFORMER_WIDTH + (PLATFORMER_WIDTH - 1)] = SOLID; // parede direita
  }
  return grid;
}

/**
 * Template "Plataforma 2D": uma cena mínima — um nível com chão e paredes, uma
 * câmera cinemática, uma luz e um Player posicionado. É o alvo do passo 2 da
 * jornada de aceite ("escolher Novo projeto de Plataforma 2D").
 */
export function createPlatformer2DDocument(): BlueprintDocument {
  const level: LevelSpec = {
    levelId: "level-1",
    width: PLATFORMER_WIDTH,
    height: PLATFORMER_HEIGHT,
    tileSize: PLATFORMER_TILE_SIZE,
    seed: 1,
    intGrid: platformerIntGrid(),
    // Regra default: célula sólida (1) → tile 1. O editor refina depois.
    rules: [{ patternSize: 1, pattern: [SOLID], tileIds: [1] }],
  };

  const playerDef: EntityDefinition = {
    entityDefId: "player",
    archetypeId: "player",
    tags: ["player"],
    editor: { color: "#3aa0ff" },
    fields: [
      { name: "speed", type: "float", default: 90 },
      { name: "jumpVelocity", type: "float", default: 320 },
    ],
  };

  const player: EntityInstance = {
    entityId: "player-1",
    entityDefId: "player",
    // em pé sobre o chão (a última linha é sólida), dentro da parede esquerda
    position: [...cellToWorldCenter({ x: 2, y: PLATFORMER_HEIGHT - 2 }, PLATFORMER_TILE_SIZE)],
    fields: {},
  };

  const light: LightSpec = {
    lightId: "key-light",
    type: "point",
    // centro do nível em pixels — o mesmo espaço do `radius` abaixo
    position: legacyLevelCenterPx(PLATFORMER_WIDTH, PLATFORMER_HEIGHT),
    height: 1,
    color: [1, 1, 1],
    intensity: 1.2,
    radius: 240,
  };

  const placement: WorldPlacement = { levelId: "level-1", x: 0, y: 0 };

  return {
    schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
    projectId: "template-platformer-2d",
    metadata: templateMetadata("Plataforma 2D"),
    skeletons: [],
    meshes: [],
    camera: { frequency: 2, damping: 1, response: 2, anticipationSeconds: 0.15 },
    lights: [light],
    entityDefs: [playerDef],
    entities: [player],
    levels: [level],
    placements: [placement],
  };
}

const TOPDOWN_WIDTH = 20;
const TOPDOWN_HEIGHT = 14;

/**
 * IntGrid de partida do top-down: sala fechada por paredes, com dois blocos
 * internos. Contrasta de propósito com o platformer — chão embaixo ali, sala
 * murada aqui — para provar que o fluxo "Novo projeto" é genérico e não um
 * caso especial de plataforma.
 */
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
  // dois obstáculos internos: dão o que contornar já na primeira sessão
  for (let y = 4; y <= 5; y++) {
    for (let x = 5; x <= 7; x++) grid[at(x, y)] = SOLID;
  }
  for (let y = 8; y <= 9; y++) {
    for (let x = 12; x <= 14; x++) grid[at(x, y)] = SOLID;
  }
  return grid;
}

/**
 * Template "Aventura top-down": uma sala murada com obstáculos, câmera mais
 * firme (sem antecipação de salto) e um Herói no centro.
 *
 * Segue a MESMA convenção de unidade do platformer: posição em pixels do
 * mundo via `cellToWorldCenter`, a conversão canônica.
 */
export function createTopDown2DDocument(): BlueprintDocument {
  const level: LevelSpec = {
    levelId: "sala-1",
    width: TOPDOWN_WIDTH,
    height: TOPDOWN_HEIGHT,
    tileSize: PLATFORMER_TILE_SIZE,
    seed: 7,
    intGrid: topDownIntGrid(),
    rules: [{ patternSize: 1, pattern: [SOLID], tileIds: [1] }],
  };

  const heroDef: EntityDefinition = {
    entityDefId: "heroi",
    archetypeId: "player",
    tags: ["player"],
    editor: { color: "#f0a03a" },
    fields: [
      { name: "speed", type: "float", default: 70 },
      { name: "vida", type: "int", default: 3 },
    ],
  };

  const hero: EntityInstance = {
    entityId: "heroi-1",
    entityDefId: "heroi",
    position: [...cellToWorldCenter({ x: 3, y: 3 }, PLATFORMER_TILE_SIZE)],
    fields: {},
  };

  const light: LightSpec = {
    lightId: "tocha",
    type: "point",
    position: legacyLevelCenterPx(TOPDOWN_WIDTH, TOPDOWN_HEIGHT),
    height: 1,
    color: [1, 0.92, 0.75],
    intensity: 1.4,
    radius: 200,
  };

  const placement: WorldPlacement = { levelId: "sala-1", x: 0, y: 0 };

  return {
    schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
    projectId: "template-top-down-2d",
    metadata: templateMetadata("Aventura top-down"),
    skeletons: [],
    meshes: [],
    // top-down não antecipa salto: resposta menor e sem anticipation
    camera: { frequency: 3, damping: 1.2, response: 0, anticipationSeconds: 0 },
    lights: [light],
    entityDefs: [heroDef],
    entities: [hero],
    levels: [level],
    placements: [placement],
  };
}

/** Registro de templates disponíveis para o fluxo "Novo projeto". */
export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: "platformer-2d",
    label: "Plataforma 2D",
    description:
      "Cena inicial de plataforma: nível com chão e paredes, câmera cinemática, uma luz e um Player posicionado.",
    create: createPlatformer2DDocument,
  },
  {
    id: "top-down-2d",
    label: "Aventura top-down",
    description:
      "Sala murada com obstáculos, câmera firme sem antecipação e um Herói no centro.",
    create: createTopDown2DDocument,
  },
];

export function getProjectTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((template) => template.id === id);
}
