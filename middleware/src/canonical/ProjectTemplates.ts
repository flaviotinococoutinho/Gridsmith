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
import { MAX_TILE_SIZE } from "../domain/BlueprintStore.js";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  DEFAULT_PROJECT_METADATA,
  type BlueprintDocument,
  type ProjectMetadata,
} from "./BlueprintSerializer.js";
import { cellToWorldCenter } from "../leveldesign/GridCoordinates.js";

export interface ProjectTemplateOptions {
  readonly projectId: string;
  readonly name: string;
  readonly referenceResolution: {
    readonly width: number;
    readonly height: number;
  };
  readonly tileSize: number;
}

export interface ProjectTemplatePreview {
  readonly kind: "level-schematic";
  readonly widthCells: number;
  readonly heightCells: number;
  readonly playerCell: readonly [number, number];
  readonly accent: string;
}

export interface ProjectTemplate {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly preview: ProjectTemplatePreview;
  readonly defaults: Omit<ProjectTemplateOptions, "projectId" | "name">;
  readonly create: (options?: Partial<ProjectTemplateOptions>) => BlueprintDocument;
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
export function createPlatformer2DDocument(
  requested: Partial<ProjectTemplateOptions> = {},
): BlueprintDocument {
  const options = normalizeOptions(requested);
  const tileSize = options.tileSize;
  const level: LevelSpec = {
    levelId: "level-1",
    width: PLATFORMER_WIDTH,
    height: PLATFORMER_HEIGHT,
    tileSize,
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
    position: cellToWorldCenter({ x: 2, y: PLATFORMER_HEIGHT - 2 }, tileSize),
    fields: {},
  };

  const light: LightSpec = {
    lightId: "key-light",
    type: "point",
    position: cellToWorldCenter(
      { x: Math.floor(PLATFORMER_WIDTH / 2), y: Math.floor(PLATFORMER_HEIGHT / 2) },
      tileSize,
    ),
    height: 1,
    color: [1, 1, 1],
    intensity: 1.2,
    radius: 240,
  };

  const placement: WorldPlacement = { levelId: "level-1", x: 0, y: 0 };

  return {
    schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
    projectId: options.projectId,
    metadata: projectMetadata(options),
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
    preview: Object.freeze({
      kind: "level-schematic",
      widthCells: PLATFORMER_WIDTH,
      heightCells: PLATFORMER_HEIGHT,
      playerCell: Object.freeze([2, PLATFORMER_HEIGHT - 2]) as readonly [number, number],
      accent: "#3aa0ff",
    }),
    defaults: Object.freeze({
      referenceResolution: DEFAULT_PROJECT_METADATA.referenceResolution,
      tileSize: 16,
    }),
    create: createPlatformer2DDocument,
  },
];

export function getProjectTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((template) => template.id === id);
}

function normalizeOptions(requested: Partial<ProjectTemplateOptions>): ProjectTemplateOptions {
  const projectId = requested.projectId ?? "template-platformer-2d";
  const name = requested.name?.trim() || "Plataforma 2D";
  const referenceResolution = requested.referenceResolution ??
    DEFAULT_PROJECT_METADATA.referenceResolution;
  const tileSize = requested.tileSize ?? 16;
  if (!projectId.trim() || projectId.length > 256) {
    throw new TypeError("projectId must be non-empty and at most 256 characters");
  }
  if (
    !Number.isInteger(referenceResolution.width) ||
    referenceResolution.width < 1 ||
    !Number.isInteger(referenceResolution.height) ||
    referenceResolution.height < 1
  ) {
    throw new TypeError("referenceResolution must contain positive integer width/height");
  }
  if (!Number.isInteger(tileSize) || tileSize < 1 || tileSize > MAX_TILE_SIZE) {
    throw new TypeError(`tileSize must be an integer between 1 and ${MAX_TILE_SIZE}`);
  }
  return Object.freeze({
    projectId,
    name,
    referenceResolution: Object.freeze({ ...referenceResolution }),
    tileSize,
  });
}

function projectMetadata(options: ProjectTemplateOptions): ProjectMetadata {
  return Object.freeze({
    name: options.name,
    referenceResolution: options.referenceResolution,
    spatial: DEFAULT_PROJECT_METADATA.spatial,
  });
}
