import type { LevelRule } from "./levelPresets.js";

/** Recorte mínimo da projeção canônica consumido pelo editor de nível. */
export interface LevelEditorProjectionDocument {
  readonly projectId?: string;
  readonly metadata?: ProjectedProjectMetadata;
  readonly levels?: readonly ProjectedLevel[];
  readonly entities?: readonly ProjectedEntity[];
  readonly entityDefs?: readonly ProjectedEntityDefinition[];
  readonly camera?: ProjectedCameraSettings;
  readonly lights?: readonly ProjectedLight[];
  readonly skeletons?: readonly ProjectedSkeleton[];
  readonly meshes?: readonly ProjectedMesh[];
}

export interface ProjectedProjectMetadata {
  readonly name: string;
  readonly referenceResolution?: { readonly width: number; readonly height: number };
  readonly spatial?: {
    readonly positionUnit: string;
    readonly cellOrigin: string;
    readonly yAxis: string;
    readonly entityAnchor: string;
  };
}

export interface ProjectedCameraSettings {
  readonly frequency?: number;
  readonly damping?: number;
  readonly response?: number;
  readonly anticipationSeconds?: number;
  readonly shakeFrequencyHz?: number;
  readonly shakeMaxOffset?: number;
  readonly shakeMaxRotationRadians?: number;
  readonly shakeTraumaDecayPerSecond?: number;
  readonly shakeSeed?: number;
}

export interface ProjectedLight {
  readonly lightId: string;
  readonly type: "directional" | "point" | "spot";
  readonly position?: readonly [number, number];
  readonly height?: number;
  readonly direction?: readonly [number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly radius?: number;
  readonly innerConeDegrees?: number;
  readonly outerConeDegrees?: number;
}

export interface ProjectedSkeleton {
  readonly skeletonId: string;
}

export interface ProjectedMesh {
  readonly meshId: string;
  readonly skeletonId: string;
}

export interface ProjectedLevel {
  readonly levelId: string;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly seed: number;
  readonly intGrid: readonly number[];
  readonly rules: readonly LevelRule[];
  readonly palette?: readonly ProjectedPaletteEntry[];
}

export interface ProjectedPaletteEntry {
  readonly value: number;
  readonly name: string;
  readonly color: string;
}

export interface ProjectedEntity {
  readonly entityId: string;
  readonly entityDefId: string;
  readonly position: readonly [number, number];
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface ProjectedEntityDefinition {
  readonly entityDefId: string;
  readonly archetypeId?: string;
  readonly tags?: readonly string[];
  readonly fields?: readonly ProjectedEntityField[];
  readonly editor?: { readonly color?: string; readonly icon?: string };
  /** Referência canônica persistida; metadados importados continuam no catálogo. */
  readonly spriteRenderer?: {
    readonly assetId: string;
    readonly defaultClip?: string;
  };
}

export interface ProjectedEntityField {
  readonly name: string;
  readonly type: "int" | "float" | "bool" | "string" | "enum" | "point" | "color";
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly string[];
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
