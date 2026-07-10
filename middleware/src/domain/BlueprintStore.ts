/**
 * Estado declarativo (AST/Blueprint) do projeto, mantido no middleware.
 *
 * CQRS: toda mutação entra como um Comando imutável, é validada, aplicada
 * ao estado e emitida como evento para os assinantes (UI, ponte da engine).
 * Leituras são projeções somente-leitura — nunca expõem referências mutáveis.
 */

import { EventEmitter } from "node:events";
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

export type BlueprintCommand =
  | { readonly kind: "skeleton/define"; readonly skeleton: SkeletonBlueprint }
  | { readonly kind: "mesh/bind"; readonly binding: MeshBinding }
  | { readonly kind: "camera/configure"; readonly settings: CameraSettings }
  | { readonly kind: "light/add"; readonly light: LightSpec }
  | { readonly kind: "light/remove"; readonly lightId: string }
  | { readonly kind: "entitydef/define"; readonly definition: EntityDefinition }
  | { readonly kind: "entity/place"; readonly entity: EntityInstance }
  | { readonly kind: "entity/remove"; readonly entityId: string }
  | { readonly kind: "level/define"; readonly level: LevelSpec }
  | { readonly kind: "level/remove"; readonly levelId: string };

export type BlueprintEvent =
  | { readonly kind: "skeletonDefined"; readonly skeleton: SkeletonBlueprint }
  | { readonly kind: "meshBound"; readonly binding: MeshBinding }
  | { readonly kind: "cameraConfigured"; readonly settings: CameraSettings }
  | { readonly kind: "lightAdded"; readonly light: LightSpec }
  | { readonly kind: "lightRemoved"; readonly lightId: string }
  | { readonly kind: "entityDefDefined"; readonly definition: EntityDefinition }
  | { readonly kind: "entityPlaced"; readonly entity: EntityInstance }
  | { readonly kind: "entityRemoved"; readonly entityId: string }
  | { readonly kind: "levelDefined"; readonly level: LevelSpec }
  | { readonly kind: "levelRemoved"; readonly levelId: string };

/**
 * Eventos: "event" (BlueprintEvent) após cada comando aplicado com sucesso.
 */
export class BlueprintStore extends EventEmitter {
  private readonly skeletons = new Map<string, SkeletonBlueprint>();
  private readonly meshes = new Map<string, MeshBinding>();
  private readonly lights = new Map<string, LightSpec>();
  private readonly entityDefs = new Map<string, EntityDefinition>();
  private readonly entities = new Map<string, EntityInstance>();
  private readonly levels = new Map<string, LevelSpec>();
  private camera: CameraSettings = {};

  apply(command: BlueprintCommand): BlueprintEvent {
    switch (command.kind) {
      case "camera/configure": {
        validateCameraSettings(command.settings);
        this.camera = Object.freeze({ ...this.camera, ...command.settings });
        const event: BlueprintEvent = { kind: "cameraConfigured", settings: this.camera };
        this.emit("event", event);
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
        this.emit("event", event);
        return event;
      }
      case "light/remove": {
        if (!this.lights.delete(command.lightId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Light "${command.lightId}" does not exist`);
        }
        const event: BlueprintEvent = { kind: "lightRemoved", lightId: command.lightId };
        this.emit("event", event);
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
        this.emit("event", event);
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
        const event: BlueprintEvent = { kind: "entityPlaced", entity };
        this.emit("event", event);
        return event;
      }
      case "entity/remove": {
        if (!this.entities.delete(command.entityId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity "${command.entityId}" does not exist`);
        }
        const event: BlueprintEvent = { kind: "entityRemoved", entityId: command.entityId };
        this.emit("event", event);
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
        this.emit("event", event);
        return event;
      }
      case "level/remove": {
        if (!this.levels.delete(command.levelId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Level "${command.levelId}" does not exist`);
        }
        const event: BlueprintEvent = { kind: "levelRemoved", levelId: command.levelId };
        this.emit("event", event);
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
        this.emit("event", event);
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
        this.emit("event", event);
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
}

function validateLevel(level: LevelSpec): void {
  if (typeof level.levelId !== "string" || level.levelId.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"levelId" must be a non-empty string`);
  }
  if (!Number.isInteger(level.tileSize) || level.tileSize < 1) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"tileSize" must be a positive integer`);
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
  if (!Array.isArray(entity.position) || entity.position.length !== 2) {
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
      if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== "number")) {
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
  if (!Array.isArray(light.color) || light.color.length !== 3) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"color" must contain 3 numbers`);
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
