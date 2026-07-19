/**
 * Estado declarativo (AST/Blueprint) do projeto, mantido no middleware.
 *
 * CQRS: toda mutação entra como um Comando imutável, é validada e aplicada
 * ao estado; o evento retornado sobe ao orquestrador para commit/publicação.
 * Leituras são projeções somente-leitura — nunca expõem referências mutáveis.
 */

import {
  validateGrid,
  validateRules,
  type AutoTileRule,
} from "../leveldesign/AutoTiler.js";
import { JsonRpcError, RpcErrorCode } from "../protocol/jsonrpc.js";

export interface BoneDefinition {
  readonly id: number;
  readonly parentId: number; // -1 = raiz
  /** Matriz afim 2D coluna-maior: m11, m12, m21, m22, m31, m32 */
  readonly inverseBindMatrix: readonly number[];
}

export interface SkeletonBlueprint {
  readonly skeletonId: string;
  readonly bones: readonly BoneDefinition[];
}

export interface MeshBinding {
  readonly meshId: string;
  readonly skeletonId: string;
  readonly sharedMemoryMapName: string;
  readonly vertexCount: number;
  readonly strideInBytes: number;
}

/** Configuração parcial da câmera cinemática (merge sobre o estado corrente). */
export interface CameraSettings {
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

export type LightKind = "directional" | "point" | "spot";

export interface LightSpec {
  readonly lightId: string;
  readonly type: LightKind;
  readonly position?: readonly [number, number];
  readonly height?: number;
  readonly direction?: readonly [number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly radius?: number;
  readonly innerConeDegrees?: number;
  readonly outerConeDegrees?: number;
}

/**
 * Campo tipado de uma definição de entidade — o schema que gera a UI do
 * editor (LDtk entity fields / Ogmo templates / Tiled property types; ver
 * docs/RESEARCH-EDITOR-LANDSCAPE.md).
 */
export interface EntityFieldDef {
  readonly name: string;
  readonly type: "int" | "float" | "bool" | "string" | "enum" | "point" | "color";
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
  /** Obrigatório para type "enum". */
  readonly options?: readonly string[];
}

export interface EntityDefinition {
  readonly entityDefId: string;
  readonly fields: readonly EntityFieldDef[];
  /**
   * Spawn table (ALPHA-0.1 P0.6): archetype do runtime que materializa
   * instâncias desta definição como atores vivos. Sem archetype, a entidade
   * é puramente editorial (a projeção explica isso com razão acionável).
   */
  readonly archetypeId?: string;
  /** Taxonomia (painel de assets / paleta do editor). */
  readonly tags?: readonly string[];
  readonly editor?: { readonly color?: string; readonly icon?: string };
}

export interface EntityInstance {
  readonly entityId: string;
  readonly entityDefId: string;
  readonly position: readonly [number, number];
  /** Valores por campo; ausentes assumem o default da definição. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Nível no modelo canônico (LDtk-like): o designer edita o IntGrid de
 * SIGNIFICADO + regras; a resolução em tiles é responsabilidade do adapter
 * de runtime na projeção (função pura com seed — determinística).
 */
export interface LevelSpec {
  readonly levelId: string;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly seed: number;
  /** width*height valores linha-maior; 0 = vazio. */
  readonly intGrid: readonly number[];
  readonly rules: readonly AutoTileRule[];
}

/** Limite alinhado ao TilemapStore da engine (256×256). */
export const MAX_LEVEL_CELLS = 256 * 256;
/** Limite publicado pelo descriptor MonoGame para `level.tileSize`. */
export const MAX_TILE_SIZE = 256;

export type BlueprintCommand =
  | { readonly kind: "skeleton/define"; readonly skeleton: SkeletonBlueprint }
  | { readonly kind: "mesh/bind"; readonly binding: MeshBinding }
  | { readonly kind: "camera/configure"; readonly settings: CameraSettings }
  | { readonly kind: "light/add"; readonly light: LightSpec }
  | { readonly kind: "light/remove"; readonly lightId: string }
  | { readonly kind: "entitydef/define"; readonly definition: EntityDefinition }
  | { readonly kind: "entity/place"; readonly entity: EntityInstance }
  | { readonly kind: "entity/move"; readonly entityId: string; readonly position: readonly [number, number] }
  | { readonly kind: "entity/remove"; readonly entityId: string }
  | { readonly kind: "level/define"; readonly level: LevelSpec }
  | { readonly kind: "level/update"; readonly level: LevelSpec }
  | { readonly kind: "level/remove"; readonly levelId: string }
  | { readonly kind: "world/place"; readonly placement: WorldPlacement }
  | { readonly kind: "world/unplace"; readonly levelId: string };

/**
 * Posição de um nível no world map (LDtk "free layout"): coordenadas em
 * pixels do mundo; o retângulo do nível deriva de width/height × tileSize.
 */
export interface WorldPlacement {
  readonly levelId: string;
  readonly x: number;
  readonly y: number;
}

export type WorldNeighborDirection = "left" | "right" | "up" | "down";

export interface WorldNeighbor {
  readonly levelId: string;
  readonly direction: WorldNeighborDirection;
}

export type BlueprintEvent =
  | { readonly kind: "skeletonDefined"; readonly skeleton: SkeletonBlueprint }
  | { readonly kind: "meshBound"; readonly binding: MeshBinding }
  | { readonly kind: "cameraConfigured"; readonly settings: CameraSettings }
  | { readonly kind: "lightAdded"; readonly light: LightSpec }
  | { readonly kind: "lightRemoved"; readonly lightId: string }
  | { readonly kind: "entityDefDefined"; readonly definition: EntityDefinition }
  // evento enriquecido: a projeção precisa do archetype sem consultar o store
  | { readonly kind: "entityPlaced"; readonly entity: EntityInstance; readonly archetypeId?: string }
  | { readonly kind: "entityMoved"; readonly entity: EntityInstance; readonly archetypeId?: string }
  | { readonly kind: "entityRemoved"; readonly entityId: string }
  | { readonly kind: "levelDefined"; readonly level: LevelSpec }
  | { readonly kind: "levelUpdated"; readonly level: LevelSpec }
  | { readonly kind: "levelRemoved"; readonly levelId: string }
  | { readonly kind: "worldLevelPlaced"; readonly placement: WorldPlacement }
  | { readonly kind: "worldLevelUnplaced"; readonly levelId: string };

/**
 * Estado canônico sem publicação própria. `apply` devolve o evento ao
 * orquestrador; somente o ProjectSessionManager publica depois que store e
 * CommandHistory foram confirmados como um único commit.
 */
export class BlueprintStore {
  private readonly skeletons = new Map<string, SkeletonBlueprint>();
  private readonly meshes = new Map<string, MeshBinding>();
  private readonly lights = new Map<string, LightSpec>();
  private readonly entityDefs = new Map<string, EntityDefinition>();
  private readonly entities = new Map<string, EntityInstance>();
  private readonly levels = new Map<string, LevelSpec>();
  private readonly placements = new Map<string, WorldPlacement>();
  private camera: CameraSettings = {};

  apply(command: BlueprintCommand): BlueprintEvent {
    switch (command.kind) {
      case "camera/configure": {
        validateCameraSettings(command.settings);
        this.camera = Object.freeze({ ...this.camera, ...command.settings });
        const event: BlueprintEvent = { kind: "cameraConfigured", settings: this.camera };
        return event;
      }
      case "light/add": {
        const light = command.light;
        validateLight(light);
        if (this.lights.has(light.lightId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Light "${light.lightId}" already exists`);
        }
        this.lights.set(light.lightId, Object.freeze({ ...light }));
        const event: BlueprintEvent = { kind: "lightAdded", light };
        return event;
      }
      case "light/remove": {
        if (!this.lights.delete(command.lightId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Light "${command.lightId}" does not exist`);
        }
        const event: BlueprintEvent = { kind: "lightRemoved", lightId: command.lightId };
        return event;
      }
      case "entitydef/define": {
        const definition = command.definition;
        validateEntityDefinition(definition);
        if (this.entityDefs.has(definition.entityDefId)) {
          throw new JsonRpcError(
            RpcErrorCode.DuplicateId,
            `Entity definition "${definition.entityDefId}" already exists`,
          );
        }
        this.entityDefs.set(definition.entityDefId, Object.freeze({ ...definition }));
        const event: BlueprintEvent = { kind: "entityDefDefined", definition };
        return event;
      }
      case "entity/place": {
        const definition = this.entityDefs.get(command.entity.entityDefId);
        if (!definition) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Entity definition "${command.entity.entityDefId}" is not defined`,
          );
        }
        if (this.entities.has(command.entity.entityId)) {
          throw new JsonRpcError(
            RpcErrorCode.DuplicateId,
            `Entity "${command.entity.entityId}" already exists`,
          );
        }
        const entity = resolveEntityFields(command.entity, definition);
        this.entities.set(entity.entityId, entity);
        const event: BlueprintEvent = {
          kind: "entityPlaced",
          entity,
          ...(definition.archetypeId !== undefined ? { archetypeId: definition.archetypeId } : {}),
        };
        return event;
      }
      case "entity/move": {
        const current = this.entities.get(command.entityId);
        if (!current) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity "${command.entityId}" does not exist`);
        }
        const position = command.position;
        if (!Array.isArray(position) || position.length !== 2 ||
            !position.every((n) => typeof n === "number" && Number.isFinite(n))) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `"position" must contain 2 numbers`);
        }
        const entity: EntityInstance = { ...current, position: [position[0]!, position[1]!] };
        this.entities.set(entity.entityId, entity);
        const definition = this.entityDefs.get(entity.entityDefId);
        const event: BlueprintEvent = {
          kind: "entityMoved",
          entity,
          ...(definition?.archetypeId !== undefined ? { archetypeId: definition.archetypeId } : {}),
        };
        return event;
      }
      case "entity/remove": {
        if (!this.entities.delete(command.entityId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity "${command.entityId}" does not exist`);
        }
        const event: BlueprintEvent = { kind: "entityRemoved", entityId: command.entityId };
        return event;
      }
      case "level/define": {
        const level = command.level;
        validateLevel(level);
        if (this.levels.has(level.levelId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Level "${level.levelId}" is already defined`);
        }
        this.levels.set(level.levelId, Object.freeze({ ...level }));
        const event: BlueprintEvent = { kind: "levelDefined", level };
        return event;
      }
      case "level/update": {
        const level = command.level;
        validateLevel(level);
        if (!this.levels.has(level.levelId)) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Level "${level.levelId}" does not exist — use level/define to create it`,
          );
        }
        this.levels.set(level.levelId, Object.freeze({ ...level }));
        const event: BlueprintEvent = { kind: "levelUpdated", level };
        return event;
      }
      case "level/remove": {
        if (!this.levels.delete(command.levelId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Level "${command.levelId}" does not exist`);
        }
        this.placements.delete(command.levelId); // sai também do world map
        const event: BlueprintEvent = { kind: "levelRemoved", levelId: command.levelId };
        return event;
      }
      case "world/place": {
        const placement = command.placement;
        if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `"x" and "y" must be finite numbers`);
        }
        const level = this.levels.get(placement.levelId);
        if (!level) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Level "${placement.levelId}" must be defined before placing it on the world map`,
          );
        }
        const rect = levelRect(level, placement);
        for (const [otherId, other] of this.placements) {
          if (otherId === placement.levelId) continue;
          const otherRect = levelRect(this.levels.get(otherId)!, other);
          if (rectsOverlap(rect, otherRect)) {
            throw new JsonRpcError(
              RpcErrorCode.InvalidParams,
              `Level "${placement.levelId}" would overlap "${otherId}" on the world map`,
            );
          }
        }
        // re-posicionar é permitido (drag-n-drop): substitui a colocação
        this.placements.set(placement.levelId, Object.freeze({ ...placement }));
        const event: BlueprintEvent = { kind: "worldLevelPlaced", placement };
        return event;
      }
      case "world/unplace": {
        if (!this.placements.delete(command.levelId)) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Level "${command.levelId}" is not placed on the world map`,
          );
        }
        const event: BlueprintEvent = { kind: "worldLevelUnplaced", levelId: command.levelId };
        return event;
      }
      case "skeleton/define": {
        const s = command.skeleton;
        validateSkeleton(s);
        if (this.skeletons.has(s.skeletonId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Skeleton "${s.skeletonId}" is already defined`);
        }
        this.skeletons.set(s.skeletonId, deepFreezeSkeleton(s));
        const event: BlueprintEvent = { kind: "skeletonDefined", skeleton: s };
        return event;
      }
      case "mesh/bind": {
        const b = command.binding;
        validateBinding(b);
        if (!this.skeletons.has(b.skeletonId)) {
          throw new JsonRpcError(RpcErrorCode.UnknownSkeleton, `Skeleton "${b.skeletonId}" is not defined`);
        }
        if (this.meshes.has(b.meshId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Mesh "${b.meshId}" is already bound`);
        }
        this.meshes.set(b.meshId, Object.freeze({ ...b }));
        const event: BlueprintEvent = { kind: "meshBound", binding: b };
        return event;
      }
    }
  }

  // ---- Projeções (Query) ----

  getSkeleton(skeletonId: string): SkeletonBlueprint | undefined {
    return this.skeletons.get(skeletonId);
  }

  listSkeletons(): readonly SkeletonBlueprint[] {
    return [...this.skeletons.values()];
  }

  getMesh(meshId: string): MeshBinding | undefined {
    return this.meshes.get(meshId);
  }

  listMeshes(): readonly MeshBinding[] {
    return [...this.meshes.values()];
  }

  /** Configuração acumulada da câmera ({} = defaults da engine). */
  get cameraSettings(): CameraSettings {
    return this.camera;
  }

  getLight(lightId: string): LightSpec | undefined {
    return this.lights.get(lightId);
  }

  listLights(): readonly LightSpec[] {
    return [...this.lights.values()];
  }

  getEntityDef(entityDefId: string): EntityDefinition | undefined {
    return this.entityDefs.get(entityDefId);
  }

  listEntityDefs(): readonly EntityDefinition[] {
    return [...this.entityDefs.values()];
  }

  getEntity(entityId: string): EntityInstance | undefined {
    return this.entities.get(entityId);
  }

  listEntities(): readonly EntityInstance[] {
    return [...this.entities.values()];
  }

  getLevel(levelId: string): LevelSpec | undefined {
    return this.levels.get(levelId);
  }

  listLevels(): readonly LevelSpec[] {
    return [...this.levels.values()];
  }

  listPlacements(): readonly WorldPlacement[] {
    return [...this.placements.values()];
  }

  /** true quando nenhum comando foi aplicado (estado "novo projeto"). */
  get isEmpty(): boolean {
    return (
      this.skeletons.size === 0 &&
      this.meshes.size === 0 &&
      this.lights.size === 0 &&
      this.entityDefs.size === 0 &&
      this.entities.size === 0 &&
      this.levels.size === 0 &&
      this.placements.size === 0 &&
      Object.keys(this.camera).length === 0
    );
  }

  /**
   * Vizinhos de um nível no world map: níveis cujo retângulo TOCA uma borda
   * do nível dado (LDtk: navegação entre níveis adjacentes).
   */
  neighborsOf(levelId: string): readonly WorldNeighbor[] {
    const placement = this.placements.get(levelId);
    const level = this.levels.get(levelId);
    if (!placement || !level) return [];
    const rect = levelRect(level, placement);

    const neighbors: WorldNeighbor[] = [];
    for (const [otherId, otherPlacement] of this.placements) {
      if (otherId === levelId) continue;
      const other = levelRect(this.levels.get(otherId)!, otherPlacement);
      const verticalTouch = other.y < rect.y + rect.h && other.y + other.h > rect.y;
      const horizontalTouch = other.x < rect.x + rect.w && other.x + other.w > rect.x;
      if (other.x + other.w === rect.x && verticalTouch) neighbors.push({ levelId: otherId, direction: "left" });
      else if (other.x === rect.x + rect.w && verticalTouch) neighbors.push({ levelId: otherId, direction: "right" });
      else if (other.y + other.h === rect.y && horizontalTouch) neighbors.push({ levelId: otherId, direction: "up" });
      else if (other.y === rect.y + rect.h && horizontalTouch) neighbors.push({ levelId: otherId, direction: "down" });
    }
    return neighbors;
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function levelRect(level: LevelSpec, placement: WorldPlacement): Rect {
  return {
    x: placement.x,
    y: placement.y,
    w: level.width * level.tileSize,
    h: level.height * level.tileSize,
  };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function validateLevel(level: LevelSpec): void {
  if (typeof level.levelId !== "string" || level.levelId.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"levelId" must be a non-empty string`);
  }
  if (!Number.isInteger(level.tileSize) || level.tileSize < 1 || level.tileSize > MAX_TILE_SIZE) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `"tileSize" must be an integer between 1 and ${MAX_TILE_SIZE}`,
    );
  }
  if (!Number.isInteger(level.seed)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"seed" must be an integer`);
  }
  if (level.width * level.height > MAX_LEVEL_CELLS) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `Level exceeds ${MAX_LEVEL_CELLS} cells (engine tilemap slot limit)`,
    );
  }
  try {
    validateGrid({ width: level.width, height: level.height, values: level.intGrid });
    validateRules(level.rules);
  } catch (err) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
  }
}

const FIELD_TYPES = ["int", "float", "bool", "string", "enum", "point", "color"] as const;

function validateEntityDefinition(def: EntityDefinition): void {
  if (typeof def.entityDefId !== "string" || def.entityDefId.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"entityDefId" must be a non-empty string`);
  }
  if (!Array.isArray(def.fields)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"fields" must be an array`);
  }
  if (def.archetypeId !== undefined && (typeof def.archetypeId !== "string" || def.archetypeId.length === 0)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"archetypeId" must be a non-empty string when present`);
  }
  const seen = new Set<string>();
  for (const field of def.fields) {
    if (typeof field.name !== "string" || field.name.length === 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Field name must be a non-empty string`);
    }
    if (seen.has(field.name)) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Duplicate field "${field.name}"`);
    }
    seen.add(field.name);
    if (!FIELD_TYPES.includes(field.type)) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Field "${field.name}": unknown type "${field.type}"`,
      );
    }
    if (field.type === "enum" && (!Array.isArray(field.options) || field.options.length === 0)) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Field "${field.name}": enum fields require non-empty "options"`,
      );
    }
    if (field.default !== undefined) {
      validateFieldValue(field, field.default, `default of "${field.name}"`);
    }
  }
}

/** Valida os valores da instância e materializa os defaults da definição. */
function resolveEntityFields(entity: EntityInstance, def: EntityDefinition): EntityInstance {
  if (typeof entity.entityId !== "string" || entity.entityId.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"entityId" must be a non-empty string`);
  }
  if (!isFiniteTuple(entity.position, 2)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"position" must contain 2 numbers`);
  }

  const known = new Map(def.fields.map((f) => [f.name, f]));
  for (const name of Object.keys(entity.fields ?? {})) {
    if (!known.has(name)) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Entity "${entity.entityId}": field "${name}" is not declared in "${def.entityDefId}"`,
      );
    }
  }

  const resolved: Record<string, unknown> = {};
  for (const field of def.fields) {
    const provided = entity.fields?.[field.name];
    if (provided !== undefined) {
      validateFieldValue(field, provided, `"${field.name}" of entity "${entity.entityId}"`);
      resolved[field.name] = provided;
    } else if (field.default !== undefined) {
      resolved[field.name] = field.default;
    } else {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Entity "${entity.entityId}": field "${field.name}" has no value and no default`,
      );
    }
  }

  return Object.freeze({ ...entity, fields: Object.freeze(resolved) });
}

function validateFieldValue(field: EntityFieldDef, value: unknown, context: string): void {
  const fail = (why: string): never => {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `Invalid ${context}: ${why}`);
  };

  switch (field.type) {
    case "int":
      if (!Number.isInteger(value)) fail(`expected integer, got ${JSON.stringify(value)}`);
      break;
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value)) fail(`expected number`);
      break;
    case "bool":
      if (typeof value !== "boolean") fail(`expected boolean`);
      break;
    case "string":
      if (typeof value !== "string") fail(`expected string`);
      break;
    case "enum":
      if (typeof value !== "string" || !field.options!.includes(value)) {
        fail(`expected one of [${field.options!.join(", ")}]`);
      }
      break;
    case "point":
      if (!isFiniteTuple(value, 2)) {
        fail(`expected [x, y]`);
      }
      break;
    case "color":
      if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
        fail(`expected "#rrggbb"`);
      }
      break;
  }

  if ((field.type === "int" || field.type === "float") && typeof value === "number") {
    if (field.min !== undefined && value < field.min) fail(`${value} < min ${field.min}`);
    if (field.max !== undefined && value > field.max) fail(`${value} > max ${field.max}`);
  }
}

function validateCameraSettings(s: CameraSettings): void {
  if (s.frequency !== undefined && !(s.frequency > 0)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"frequency" must be > 0`);
  }
  if (s.damping !== undefined && !(s.damping >= 0)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"damping" must be >= 0`);
  }
  if (s.anticipationSeconds !== undefined && !(s.anticipationSeconds >= 0)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"anticipationSeconds" must be >= 0`);
  }
}

function validateLight(light: LightSpec): void {
  if (typeof light.lightId !== "string" || light.lightId.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"lightId" must be a non-empty string`);
  }
  if (!["directional", "point", "spot"].includes(light.type)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"type" must be "directional", "point" or "spot"`);
  }
  if (!isFiniteTuple(light.color, 3)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"color" must contain 3 numbers`);
  }
  if (light.position !== undefined && !isFiniteTuple(light.position, 2)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"position" must contain 2 finite numbers`);
  }
  if (!(light.intensity > 0)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"intensity" must be > 0`);
  }
  if ((light.type === "point" || light.type === "spot") && !(light.radius !== undefined && light.radius > 0)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"radius" must be > 0 for ${light.type} lights`);
  }
  if (light.type === "spot") {
    const inner = light.innerConeDegrees;
    const outer = light.outerConeDegrees;
    if (!(inner !== undefined && outer !== undefined && inner > 0 && outer >= inner && outer < 180)) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `spot lights require 0 < innerConeDegrees <= outerConeDegrees < 180`,
      );
    }
  }
}

function isFiniteTuple(value: unknown, length: number): value is readonly number[] {
  return Array.isArray(value) && value.length === length &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function validateSkeleton(s: SkeletonBlueprint): void {
  if (typeof s.skeletonId !== "string" || s.skeletonId.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"skeletonId" must be a non-empty string`);
  }
  if (!Array.isArray(s.bones) || s.bones.length === 0 || s.bones.length > 256) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"bones" must contain between 1 and 256 entries`);
  }
  const ids = new Set<number>();
  for (const bone of s.bones) {
    if (!Number.isInteger(bone.id) || bone.id < 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Bone id must be a non-negative integer`);
    }
    if (ids.has(bone.id)) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Duplicate bone id ${bone.id}`);
    }
    ids.add(bone.id);
    if (!Number.isInteger(bone.parentId) || bone.parentId < -1) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Bone ${bone.id}: parentId must be >= -1`);
    }
    if (!Array.isArray(bone.inverseBindMatrix) || bone.inverseBindMatrix.length !== 6) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Bone ${bone.id}: inverseBindMatrix must contain exactly 6 floats (2D affine, column-major)`,
      );
    }
  }
  for (const bone of s.bones) {
    if (bone.parentId !== -1 && !ids.has(bone.parentId)) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Bone ${bone.id}: parentId ${bone.parentId} does not exist`);
    }
  }
}

function validateBinding(b: MeshBinding): void {
  for (const field of ["meshId", "skeletonId", "sharedMemoryMapName"] as const) {
    if (typeof b[field] !== "string" || b[field].length === 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"${field}" must be a non-empty string`);
    }
  }
  if (!Number.isInteger(b.vertexCount) || b.vertexCount < 1) {
    throw new JsonRpcError(RpcErrorCode.InvalidBinaryLayout, `"vertexCount" must be a positive integer`);
  }
  if (!Number.isInteger(b.strideInBytes) || b.strideInBytes < 4) {
    throw new JsonRpcError(RpcErrorCode.InvalidBinaryLayout, `"strideInBytes" must be an integer >= 4`);
  }
}

function deepFreezeSkeleton(s: SkeletonBlueprint): SkeletonBlueprint {
  for (const bone of s.bones) {
    Object.freeze(bone.inverseBindMatrix);
    Object.freeze(bone);
  }
  Object.freeze(s.bones);
  return Object.freeze(s);
}
