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
import { BLUEPRINT_DOCUMENT_VERSION, type BlueprintDocument } from "./BlueprintSerializer.js";

export interface ProjectTemplate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly create: () => BlueprintDocument;
}

const PLATFORMER_WIDTH = 16;
const PLATFORMER_HEIGHT = 9;
const SOLID = 1;
const EMPTY = 0;

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
    tileSize: 16,
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
    position: [2, PLATFORMER_HEIGHT - 2],
    fields: {},
  };

  const light: LightSpec = {
    lightId: "key-light",
    type: "point",
    position: [PLATFORMER_WIDTH / 2, PLATFORMER_HEIGHT / 2],
    height: 1,
    color: [1, 1, 1],
    intensity: 1.2,
    radius: 240,
  };

  const placement: WorldPlacement = { levelId: "level-1", x: 0, y: 0 };

  return {
    schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
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

/** Registro de templates disponíveis para o fluxo "Novo projeto". */
export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: "platformer-2d",
    label: "Plataforma 2D",
    description:
      "Cena inicial de plataforma: nível com chão e paredes, câmera cinemática, uma luz e um Player posicionado.",
    create: createPlatformer2DDocument,
  },
];

export function getProjectTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((template) => template.id === id);
}
