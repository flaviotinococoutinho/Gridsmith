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
  /**
   * Associação editorial do archetype a um sprite importado. A referência é
   * deliberadamente estável por `assetId`: o catálogo pode estar temporariamente
   * indisponível sem tornar o Blueprint ilegível ou impedir o usuário de reparar
   * o vínculo pela interface.
   */
  readonly spriteRenderer?: {
    readonly assetId: string;
    readonly defaultClip?: string;
  };
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
  /** Vocabulário visual persistido do IntGrid (0 continua reservado para vazio). */
  readonly palette?: readonly LevelPaletteEntry[];
}

export interface LevelPaletteEntry {
  readonly value: number;
  readonly name: string;
  readonly color: string;
}

export interface LevelCellChange {
  readonly index: number;
  readonly before: number;
  readonly after: number;
}

export interface LevelPaletteChange {
  readonly value: number;
  readonly before: LevelPaletteEntry | null;
  readonly after: LevelPaletteEntry | null;
}

export type CommandActor = "human" | "agent" | "pipeline";

export interface CommandMetadata {
  /** A borda confiável sobrescreve este valor; payloads não escolhem proveniência. */
  readonly actor: CommandActor;
  /** Label opcional; o middleware produz uma label humana quando ausente. */
  readonly label?: string;
  /** Comandos sem inverso explícito formam barreira mesmo quando false/ausente. */
  readonly barrier?: boolean;
}

export interface CommandContext {
  readonly transactionId?: string;
  readonly metadata?: CommandMetadata;
}

export interface LevelPatchCommand {
  readonly kind: "level/patch";
  readonly levelId: string;
  readonly changes: readonly LevelCellChange[];
  readonly transactionId: string;
  readonly metadata: CommandMetadata;
}

export interface EntityPropertyChange {
  readonly name: string;
  readonly before: unknown;
  readonly after: unknown;
}

/** Limite alinhado ao TilemapStore da engine (256×256). */
export const MAX_LEVEL_CELLS = 256 * 256;
/** Limite publicado pelo descriptor MonoGame para `level.tileSize`. */
export const MAX_TILE_SIZE = 256;

export type BlueprintCommand =
  | ({ readonly kind: "skeleton/define"; readonly skeleton: SkeletonBlueprint } & CommandContext)
  | ({ readonly kind: "mesh/bind"; readonly binding: MeshBinding } & CommandContext)
  | ({
      readonly kind: "camera/configure";
      readonly settings: CameraSettings;
      /** Uso canônico do inverso: restaura exatamente, inclusive removendo chaves. */
      readonly replace?: boolean;
    } & CommandContext)
  | ({ readonly kind: "light/add"; readonly light: LightSpec } & CommandContext)
  | ({ readonly kind: "light/update"; readonly light: LightSpec } & CommandContext)
  | ({ readonly kind: "light/remove"; readonly lightId: string } & CommandContext)
  | ({ readonly kind: "entitydef/define"; readonly definition: EntityDefinition } & CommandContext)
  | ({ readonly kind: "entitydef/update"; readonly definition: EntityDefinition } & CommandContext)
  | ({ readonly kind: "entitydef/remove"; readonly entityDefId: string } & CommandContext)
  | ({ readonly kind: "entity/place"; readonly entity: EntityInstance } & CommandContext)
  | ({ readonly kind: "entity/move"; readonly entityId: string; readonly position: readonly [number, number] } & CommandContext)
  | ({ readonly kind: "entity/properties"; readonly entityId: string; readonly changes: readonly EntityPropertyChange[] } & CommandContext)
  | ({ readonly kind: "entity/remove"; readonly entityId: string } & CommandContext)
  | ({ readonly kind: "level/define"; readonly level: LevelSpec } & CommandContext)
  | ({ readonly kind: "level/update"; readonly level: LevelSpec } & CommandContext)
  | LevelPatchCommand
  | ({ readonly kind: "level/palette"; readonly levelId: string; readonly changes: readonly LevelPaletteChange[] } & CommandContext)
  | ({ readonly kind: "level/remove"; readonly levelId: string } & CommandContext)
  | ({ readonly kind: "world/place"; readonly placement: WorldPlacement } & CommandContext)
  | ({ readonly kind: "world/unplace"; readonly levelId: string } & CommandContext);

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
  | {
      readonly kind: "cameraConfigured";
      readonly settings: CameraSettings;
      /** Restaura defaults antes de aplicar settings (usado por inversos exatos). */
      readonly replace?: boolean;
    }
  | { readonly kind: "lightAdded"; readonly light: LightSpec }
  | { readonly kind: "lightUpdated"; readonly light: LightSpec }
  | { readonly kind: "lightRemoved"; readonly lightId: string }
  | { readonly kind: "entityDefDefined"; readonly definition: EntityDefinition }
  | { readonly kind: "entityDefUpdated"; readonly definition: EntityDefinition }
  | { readonly kind: "entityDefRemoved"; readonly entityDefId: string }
  // evento enriquecido: a projeção precisa do archetype sem consultar o store
  | { readonly kind: "entityPlaced"; readonly entity: EntityInstance; readonly archetypeId?: string }
  | { readonly kind: "entityMoved"; readonly entity: EntityInstance; readonly archetypeId?: string }
  | {
      readonly kind: "entityPropertiesChanged";
      readonly entity: EntityInstance;
      readonly changes: readonly EntityPropertyChange[];
      readonly archetypeId?: string;
    }
  | { readonly kind: "entityRemoved"; readonly entityId: string }
  | { readonly kind: "levelDefined"; readonly level: LevelSpec }
  | { readonly kind: "levelUpdated"; readonly level: LevelSpec }
  | {
      readonly kind: "levelPatched";
      readonly levelId: string;
      readonly changes: readonly LevelCellChange[];
    }
  | {
      readonly kind: "levelPaletteChanged";
      readonly levelId: string;
      readonly changes: readonly LevelPaletteChange[];
    }
  | { readonly kind: "levelRemoved"; readonly levelId: string }
  | { readonly kind: "worldLevelPlaced"; readonly placement: WorldPlacement }
  | { readonly kind: "worldLevelUnplaced"; readonly levelId: string };

export interface BlueprintApplyResult {
  readonly event: BlueprintEvent;
  /** Ordem em que os comandos devem ser executados para desfazer este apply. */
  readonly inverse: readonly BlueprintCommand[];
}

export interface BlueprintBatchPlan {
  readonly results: readonly BlueprintApplyResult[];
  /** Interno; só a instância que criou o plano pode confirmá-lo. */
  readonly source: BlueprintStore;
  readonly baseVersion: number;
  readonly draft: BlueprintStore;
}

/**
 * Estado canônico sem publicação própria. `apply` devolve o evento ao
 * orquestrador; somente o ProjectSessionManager publica depois que store e
 * CommandHistory foram confirmados como um único commit.
 */
export class BlueprintStore {
  private skeletons = new Map<string, SkeletonBlueprint>();
  private meshes = new Map<string, MeshBinding>();
  private lights = new Map<string, LightSpec>();
  private entityDefs = new Map<string, EntityDefinition>();
  private entities = new Map<string, EntityInstance>();
  private levels = new Map<string, LevelSpec>();
  private placements = new Map<string, WorldPlacement>();
  private camera: CameraSettings = Object.freeze({});
  private mutationVersion = 0;

  apply(command: BlueprintCommand): BlueprintEvent {
    return this.applyWithInverse(command).event;
  }

  applyWithInverse(command: BlueprintCommand): BlueprintApplyResult {
    return this.applyBatch([command])[0]!;
  }

  /** Planeja e valida todo o lote sem tocar a instância publicada. */
  planBatch(commands: readonly BlueprintCommand[]): BlueprintBatchPlan {
    if (commands.length === 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, "Blueprint command batch must not be empty");
    }
    const draft = this.fork();
    const results = commands.map((command) => draft.applyMutable(immutableClone(command)));
    return Object.freeze({
      source: this,
      baseVersion: this.mutationVersion,
      draft,
      results: Object.freeze(results),
    });
  }

  /** Commit síncrono do plano já validado; nenhuma referência do caller é adotada. */
  commitBatch(plan: BlueprintBatchPlan): readonly BlueprintApplyResult[] {
    if (plan.source !== this || plan.baseVersion !== this.mutationVersion) {
      throw new JsonRpcError(RpcErrorCode.ProjectSessionConflict, "Blueprint changed while a command batch was being prepared");
    }
    this.skeletons = plan.draft.skeletons;
    this.meshes = plan.draft.meshes;
    this.lights = plan.draft.lights;
    this.entityDefs = plan.draft.entityDefs;
    this.entities = plan.draft.entities;
    this.levels = plan.draft.levels;
    this.placements = plan.draft.placements;
    this.camera = plan.draft.camera;
    this.mutationVersion++;
    return plan.results;
  }

  applyBatch(commands: readonly BlueprintCommand[]): readonly BlueprintApplyResult[] {
    const plan = this.planBatch(commands);
    return this.commitBatch(plan);
  }

  private fork(): BlueprintStore {
    const draft = new BlueprintStore();
    draft.skeletons = new Map(this.skeletons);
    draft.meshes = new Map(this.meshes);
    draft.lights = new Map(this.lights);
    draft.entityDefs = new Map(this.entityDefs);
    draft.entities = new Map(this.entities);
    draft.levels = new Map(this.levels);
    draft.placements = new Map(this.placements);
    draft.camera = this.camera;
    draft.mutationVersion = this.mutationVersion;
    return draft;
  }

  private applyMutable(command: BlueprintCommand): BlueprintApplyResult {
    switch (command.kind) {
      case "camera/configure": {
        validateCameraSettings(command.settings);
        const previous = this.camera;
        const next = immutableClone(command.replace ? command.settings : { ...this.camera, ...command.settings });
        rejectNoop(valuesEqual(previous, next), command.kind);
        this.camera = next;
        const event: BlueprintEvent = {
          kind: "cameraConfigured",
          settings: this.camera,
          ...(command.replace ? { replace: true } : {}),
        };
        return applied(event, [{ kind: "camera/configure", settings: previous, replace: true }]);
      }
      case "light/add": {
        const light = immutableClone(command.light);
        validateLight(light);
        if (this.lights.has(light.lightId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Light "${light.lightId}" already exists`);
        }
        this.lights.set(light.lightId, light);
        const event: BlueprintEvent = { kind: "lightAdded", light };
        return applied(event, [{ kind: "light/remove", lightId: light.lightId }]);
      }
      case "light/update": {
        const light = immutableClone(command.light);
        validateLight(light);
        const previous = this.lights.get(light.lightId);
        if (!previous) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Light "${light.lightId}" does not exist`);
        }
        rejectNoop(valuesEqual(previous, light), command.kind);
        this.lights.set(light.lightId, light);
        return applied({ kind: "lightUpdated", light }, [{ kind: "light/update", light: previous }]);
      }
      case "light/remove": {
        const previous = this.lights.get(command.lightId);
        if (!previous || !this.lights.delete(command.lightId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Light "${command.lightId}" does not exist`);
        }
        const event: BlueprintEvent = { kind: "lightRemoved", lightId: command.lightId };
        return applied(event, [{ kind: "light/add", light: previous }]);
      }
      case "entitydef/define": {
        const definition = immutableClone(command.definition);
        validateEntityDefinition(definition);
        if (this.entityDefs.has(definition.entityDefId)) {
          throw new JsonRpcError(
            RpcErrorCode.DuplicateId,
            `Entity definition "${definition.entityDefId}" already exists`,
          );
        }
        this.entityDefs.set(definition.entityDefId, definition);
        const event: BlueprintEvent = { kind: "entityDefDefined", definition };
        return applied(event, [{ kind: "entitydef/remove", entityDefId: definition.entityDefId }]);
      }
      case "entitydef/update": {
        const definition = immutableClone(command.definition);
        validateEntityDefinition(definition);
        const previous = this.entityDefs.get(definition.entityDefId);
        if (!previous) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity definition "${definition.entityDefId}" does not exist`);
        }
        rejectNoop(valuesEqual(previous, definition), command.kind);
        for (const entity of this.entities.values()) {
          if (entity.entityDefId !== definition.entityDefId) continue;
          if (previous.archetypeId !== definition.archetypeId) {
            throw new JsonRpcError(
              RpcErrorCode.InvalidParams,
              `Entity definition "${definition.entityDefId}" cannot change archetypeId while entity "${entity.entityId}" is instantiated; remove its instances first`,
            );
          }
          const resolved = resolveEntityFields(entity, definition);
          if (!valuesEqual(resolved.fields, entity.fields)) {
            throw new JsonRpcError(
              RpcErrorCode.InvalidParams,
              `Entity definition "${definition.entityDefId}" would implicitly change entity "${entity.entityId}"; dispatch entity/properties explicitly`,
            );
          }
        }
        this.entityDefs.set(definition.entityDefId, definition);
        return applied(
          { kind: "entityDefUpdated", definition },
          [{ kind: "entitydef/update", definition: previous }],
        );
      }
      case "entitydef/remove": {
        const previous = this.entityDefs.get(command.entityDefId);
        if (!previous) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity definition "${command.entityDefId}" does not exist`);
        }
        if ([...this.entities.values()].some((entity) => entity.entityDefId === command.entityDefId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity definition "${command.entityDefId}" is still in use`);
        }
        this.entityDefs.delete(command.entityDefId);
        return applied(
          { kind: "entityDefRemoved", entityDefId: command.entityDefId },
          [{ kind: "entitydef/define", definition: previous }],
        );
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
        const entity = immutableClone(resolveEntityFields(command.entity, definition));
        this.entities.set(entity.entityId, entity);
        const event: BlueprintEvent = {
          kind: "entityPlaced",
          entity,
          ...(definition.archetypeId !== undefined ? { archetypeId: definition.archetypeId } : {}),
        };
        return applied(event, [{ kind: "entity/remove", entityId: entity.entityId }]);
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
        rejectNoop(valuesEqual(current.position, position), command.kind);
        const entity: EntityInstance = immutableClone({ ...current, position: [position[0]!, position[1]!] });
        this.entities.set(entity.entityId, entity);
        const definition = this.entityDefs.get(entity.entityDefId);
        const event: BlueprintEvent = {
          kind: "entityMoved",
          entity,
          ...(definition?.archetypeId !== undefined ? { archetypeId: definition.archetypeId } : {}),
        };
        return applied(event, [{ kind: "entity/move", entityId: entity.entityId, position: current.position }]);
      }
      case "entity/properties": {
        const current = this.entities.get(command.entityId);
        if (!current) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity "${command.entityId}" does not exist`);
        }
        if (!Array.isArray(command.changes) || command.changes.length === 0) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `"changes" must be a non-empty array`);
        }
        const definition = this.entityDefs.get(current.entityDefId)!;
        const fields = { ...current.fields };
        const seen = new Set<string>();
        const changes = immutableClone(command.changes);
        for (const change of changes) {
          if (!change || typeof change.name !== "string" || seen.has(change.name)) {
            throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity property changes require unique field names`);
          }
          seen.add(change.name);
          const field = definition.fields.find((candidate) => candidate.name === change.name);
          if (!field) {
            throw new JsonRpcError(RpcErrorCode.InvalidParams, `Field "${change.name}" is not declared in "${definition.entityDefId}"`);
          }
          if (!valuesEqual(fields[change.name], change.before)) {
            throw new JsonRpcError(RpcErrorCode.ProjectSessionConflict, `Entity field "${change.name}" changed before patch`);
          }
          validateFieldValue(field, change.after, `"${change.name}" of entity "${current.entityId}"`);
          fields[change.name] = change.after;
        }
        rejectNoop(changes.every((change) => valuesEqual(change.before, change.after)), command.kind);
        const entity = immutableClone({ ...current, fields });
        this.entities.set(entity.entityId, entity);
        const event: BlueprintEvent = {
          kind: "entityPropertiesChanged",
          entity,
          changes,
          ...(definition.archetypeId !== undefined ? { archetypeId: definition.archetypeId } : {}),
        };
        return applied(event, [{
          kind: "entity/properties",
          entityId: entity.entityId,
          changes: changes.map((change) => ({ name: change.name, before: change.after, after: change.before })),
        }]);
      }
      case "entity/remove": {
        const previous = this.entities.get(command.entityId);
        if (!previous || !this.entities.delete(command.entityId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity "${command.entityId}" does not exist`);
        }
        const event: BlueprintEvent = { kind: "entityRemoved", entityId: command.entityId };
        return applied(event, [{ kind: "entity/place", entity: previous }]);
      }
      case "level/define": {
        const level = normalizeLevel(command.level);
        validateLevel(level);
        if (this.levels.has(level.levelId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Level "${level.levelId}" is already defined`);
        }
        this.levels.set(level.levelId, level);
        const event: BlueprintEvent = { kind: "levelDefined", level };
        return applied(event, [{ kind: "level/remove", levelId: level.levelId }]);
      }
      case "level/update": {
        const level = normalizeLevel(command.level);
        validateLevel(level);
        if (!this.levels.has(level.levelId)) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Level "${level.levelId}" does not exist — use level/define to create it`,
          );
        }
        const previous = this.levels.get(level.levelId)!;
        rejectNoop(valuesEqual(previous, level), command.kind);
        this.levels.set(level.levelId, level);
        const event: BlueprintEvent = { kind: "levelUpdated", level };
        return applied(event, [{ kind: "level/update", level: previous }]);
      }
      case "level/patch": {
        const current = this.levels.get(command.levelId);
        if (!current) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Level "${command.levelId}" does not exist`);
        }
        validateTransaction(command.transactionId, command.metadata);
        if (!Array.isArray(command.changes) || command.changes.length === 0) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `"changes" must be a non-empty array`);
        }
        const changes = immutableClone(command.changes);
        const seen = new Set<number>();
        for (const change of changes) {
          if (
            !Number.isInteger(change.index) || change.index < 0 || change.index >= current.intGrid.length ||
            !Number.isInteger(change.before) || !Number.isInteger(change.after) ||
            change.before < 0 || change.after < 0 || change.before > 32767 || change.after > 32767 ||
            change.before === change.after || seen.has(change.index)
          ) {
            throw new JsonRpcError(RpcErrorCode.InvalidParams, `level/patch changes require unique valid indices and distinct IntGrid values`);
          }
          seen.add(change.index);
          if (current.intGrid[change.index] !== change.before) {
            throw new JsonRpcError(
              RpcErrorCode.ProjectSessionConflict,
              `Level "${command.levelId}" cell ${change.index} changed before patch (expected ${change.before}, got ${current.intGrid[change.index]})`,
            );
          }
        }
        const intGrid = [...current.intGrid];
        for (const change of changes) intGrid[change.index] = change.after;
        const level = normalizeLevel({ ...current, intGrid });
        this.levels.set(level.levelId, level);
        return applied(
          { kind: "levelPatched", levelId: level.levelId, changes },
          [{
            kind: "level/patch",
            levelId: level.levelId,
            changes: changes.map((change) => ({ index: change.index, before: change.after, after: change.before })),
            transactionId: command.transactionId,
            metadata: command.metadata,
          }],
        );
      }
      case "level/palette": {
        const current = this.levels.get(command.levelId);
        if (!current) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Level "${command.levelId}" does not exist`);
        }
        if (!Array.isArray(command.changes) || command.changes.length === 0) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `"changes" must be a non-empty array`);
        }
        const changes = immutableClone(command.changes);
        const palette = new Map((current.palette ?? []).map((entry) => [entry.value, entry]));
        const seen = new Set<number>();
        for (const change of changes) {
          if (!Number.isInteger(change.value) || change.value < 1 || change.value > 32767 || seen.has(change.value)) {
            throw new JsonRpcError(RpcErrorCode.InvalidParams, `Palette changes require unique values in [1, 32767]`);
          }
          seen.add(change.value);
          const actual = palette.get(change.value) ?? null;
          if (!valuesEqual(actual, change.before)) {
            throw new JsonRpcError(RpcErrorCode.ProjectSessionConflict, `Palette value ${change.value} changed before patch`);
          }
          if (change.after === null) palette.delete(change.value);
          else {
            validatePaletteEntry(change.after, change.value);
            palette.set(change.value, immutableClone(change.after));
          }
        }
        rejectNoop(changes.every((change) => valuesEqual(change.before, change.after)), command.kind);
        const level = normalizeLevel({ ...current, palette: [...palette.values()].sort((a, b) => a.value - b.value) });
        this.levels.set(level.levelId, level);
        return applied(
          { kind: "levelPaletteChanged", levelId: level.levelId, changes },
          [{
            kind: "level/palette",
            levelId: level.levelId,
            changes: changes.map((change) => ({ value: change.value, before: change.after, after: change.before })),
          }],
        );
      }
      case "level/remove": {
        const previous = this.levels.get(command.levelId);
        if (!previous || !this.levels.delete(command.levelId)) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Level "${command.levelId}" does not exist`);
        }
        const previousPlacement = this.placements.get(command.levelId);
        this.placements.delete(command.levelId); // sai também do world map
        const event: BlueprintEvent = { kind: "levelRemoved", levelId: command.levelId };
        return applied(event, [
          { kind: "level/define", level: previous },
          ...(previousPlacement ? [{ kind: "world/place", placement: previousPlacement } as BlueprintCommand] : []),
        ]);
      }
      case "world/place": {
        const placement = immutableClone(command.placement);
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
        const previous = this.placements.get(placement.levelId);
        rejectNoop(previous !== undefined && valuesEqual(previous, placement), command.kind);
        this.placements.set(placement.levelId, placement);
        const event: BlueprintEvent = { kind: "worldLevelPlaced", placement };
        return applied(event, previous
          ? [{ kind: "world/place", placement: previous }]
          : [{ kind: "world/unplace", levelId: placement.levelId }]);
      }
      case "world/unplace": {
        const previous = this.placements.get(command.levelId);
        if (!previous || !this.placements.delete(command.levelId)) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Level "${command.levelId}" is not placed on the world map`,
          );
        }
        const event: BlueprintEvent = { kind: "worldLevelUnplaced", levelId: command.levelId };
        return applied(event, [{ kind: "world/place", placement: previous }]);
      }
      case "skeleton/define": {
        const s = immutableClone(command.skeleton);
        validateSkeleton(s);
        if (this.skeletons.has(s.skeletonId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Skeleton "${s.skeletonId}" is already defined`);
        }
        this.skeletons.set(s.skeletonId, s);
        const event: BlueprintEvent = { kind: "skeletonDefined", skeleton: s };
        return applied(event, []);
      }
      case "mesh/bind": {
        const b = immutableClone(command.binding);
        validateBinding(b);
        if (!this.skeletons.has(b.skeletonId)) {
          throw new JsonRpcError(RpcErrorCode.UnknownSkeleton, `Skeleton "${b.skeletonId}" is not defined`);
        }
        if (this.meshes.has(b.meshId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Mesh "${b.meshId}" is already bound`);
        }
        this.meshes.set(b.meshId, b);
        const event: BlueprintEvent = { kind: "meshBound", binding: b };
        return applied(event, []);
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

function applied(
  event: BlueprintEvent,
  inverse: readonly BlueprintCommand[],
): BlueprintApplyResult {
  return Object.freeze({
    event: immutableClone(event),
    inverse: immutableClone(inverse),
  });
}

function rejectNoop(noop: boolean, kind: BlueprintCommand["kind"]): void {
  if (noop) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `"${kind}" does not change the Blueprint`,
    );
  }
}

function normalizeLevel(level: LevelSpec): LevelSpec {
  const normalized = immutableClone({
    ...level,
    palette: [...(level.palette ?? [])].sort((a, b) => a.value - b.value),
  });
  validateLevel(normalized);
  return normalized;
}

function validatePaletteEntry(entry: LevelPaletteEntry, expectedValue = entry.value): void {
  if (
    !Number.isInteger(entry.value) || entry.value !== expectedValue ||
    entry.value < 1 || entry.value > 32767 ||
    typeof entry.name !== "string" || entry.name.trim().length === 0 ||
    typeof entry.color !== "string" || !/^#[0-9a-fA-F]{6}$/u.test(entry.color)
  ) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `Palette entries require value in [1, 32767], non-empty name and "#rrggbb" color`,
    );
  }
}

function validateTransaction(transactionId: string, metadata: CommandMetadata): void {
  if (typeof transactionId !== "string" || transactionId.trim().length === 0 || transactionId.length > 128) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"transactionId" must contain 1..128 characters`);
  }
  if (!metadata || !["human", "agent", "pipeline"].includes(metadata.actor)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `command metadata requires a valid actor`);
  }
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/** Igualdade estrutural limitada aos valores JSON aceitos pelo Blueprint. */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (
    left === null || right === null ||
    typeof left !== "object" || typeof right !== "object"
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]));
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
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
    const values = new Set<number>();
    for (const entry of level.palette ?? []) {
      validatePaletteEntry(entry);
      if (values.has(entry.value)) {
        throw new Error(`Duplicate palette value ${entry.value}`);
      }
      values.add(entry.value);
    }
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
  if (def.spriteRenderer !== undefined) {
    if (
      typeof def.spriteRenderer !== "object" ||
      typeof def.spriteRenderer.assetId !== "string" ||
      def.spriteRenderer.assetId.length === 0
    ) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"spriteRenderer.assetId" must be a non-empty string`,
      );
    }
    if (
      def.spriteRenderer.defaultClip !== undefined &&
      (typeof def.spriteRenderer.defaultClip !== "string" ||
        def.spriteRenderer.defaultClip.length === 0)
    ) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"spriteRenderer.defaultClip" must be a non-empty string when present`,
      );
    }
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
