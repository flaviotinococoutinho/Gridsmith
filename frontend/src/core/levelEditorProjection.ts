import type { LevelRule } from "./levelPresets.js";

/** Recorte mínimo da projeção canônica consumido pelo editor de nível. */
export interface LevelEditorProjectionDocument {
  readonly levels?: readonly ProjectedLevel[];
  readonly entities?: readonly ProjectedEntity[];
  readonly entityDefs?: readonly ProjectedEntityDefinition[];
}

export interface ProjectedLevel {
  readonly levelId: string;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly seed: number;
  readonly intGrid: readonly number[];
  readonly rules: readonly LevelRule[];
}

export interface ProjectedEntity {
  readonly entityId: string;
  readonly entityDefId: string;
  readonly position: readonly [number, number];
}

export interface ProjectedEntityDefinition {
  readonly entityDefId: string;
  readonly archetypeId?: string;
  readonly tags?: readonly string[];
}

export interface LevelEditorProjection {
  readonly level: ProjectedLevel | undefined;
  readonly entities: readonly ProjectedEntity[];
  readonly playerEntityDefinitionId: string | undefined;
}

/**
 * Seleciona o nível de entrada sem criar IDs, dimensões ou coordenadas locais.
 * O documento da sessão é a única fonte desses valores.
 */
export function selectLevelEditorProjection(
  document: LevelEditorProjectionDocument | undefined,
  preferredLevelId?: string,
): LevelEditorProjection {
  const playerDefinition = (document?.entityDefs ?? []).find((definition) =>
    definition.archetypeId === "player" || definition.tags?.includes("player"));

  return {
    level:
      document?.levels?.find((level) => level.levelId === preferredLevelId) ??
      document?.levels?.[0],
    entities: document?.entities ?? [],
    playerEntityDefinitionId: playerDefinition?.entityDefId,
  };
}
