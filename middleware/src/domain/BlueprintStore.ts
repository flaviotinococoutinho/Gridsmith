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

/**
 * Arte de uma definição de entidade (documento v6).
 *
 * Reusa DELIBERADAMENTE o atlas que a F1 entregou: o par (`tilesetId`,
 * `tileId`) já é canônico, já atravessa o fio e já tem a tabela em grade que
 * canvas e host amostram juntos. Um segundo caminho de arte — caminho de
 * imagem por entidade, por exemplo — daria ao editor duas formas de dizer a
 * mesma coisa e duas formas de divergir do que a engine desenha.
 */
export interface EntitySprite {
  readonly tilesetId: string;
  /** Índice do tile no atlas; a região é fórmula sobre tileSize/columns. */
  readonly tileId: number;
}

export interface EntityDefinition {
  readonly entityDefId: string;
  readonly fields: readonly EntityFieldDef[];
  /**
   * Arte que o runtime desenha para as instâncias desta definição. Ausente =
   * sem arte, e o desenho cai na cor determinística — a MESMA dos dois lados.
   */
  readonly sprite?: EntitySprite;
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
 * Significado pintável do nível: o vocabulário CURADO do projeto.
 *
 * Antes da v4 a paleta era constante de build no frontend — o usuário podia
 * pintar três significados fixos e nada mais. Trazendo-a para o documento, a
 * paleta passa a ser dado do projeto: versionada, diffável e editável.
 */
export interface LevelPaletteEntry {
  /** Valor do IntGrid que esta entrada nomeia (1..32767; 0 é sempre "vazio"). */
  readonly value: number;
  readonly name: string;
  /** Cor de exibição no editor, "#rrggbb". */
  readonly color: string;
}

/**
 * Atlas de arte do projeto (documento v5): a tabela que dá IMAGEM a um
 * `tileId` resolvido.
 *
 * O atlas é uma GRADE, de propósito (convenção LDtk/Tiled): a região de um
 * `tileId` é matemática pura — coluna `tileId % columns`, linha
 * `tileId / columns`, célula de `tileSize` px. Não há tabela de regiões por
 * tile para divergir entre o canvas do editor e o host gráfico: os dois lados
 * derivam a região da MESMA fórmula com os MESMOS quatro números, e a
 * paridade visual (ADR-022) compara listas de quads que só podem discordar se
 * estes números discordarem.
 *
 * Um `tileId` fora de `[0, tileCount)` não tem arte: vira projeção `skipped`
 * com razão, nunca exceção — falha de conteúdo não derruba o documento.
 */
export interface TilesetSpec {
  readonly tilesetId: string;
  /**
   * Referência da imagem do atlas (caminho relativo ao projeto ou id de
   * artefato). O documento NÃO embute bytes de imagem: arte pesada viaja pelo
   * pipeline de assets, não pelo blueprint.
   */
  readonly image: string;
  /** Lado da célula do atlas, em pixels da imagem. */
  readonly tileSize: number;
  readonly columns: number;
  /** Total de tiles válidos; ids válidos são `0..tileCount-1`. */
  readonly tileCount: number;
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
  /** Ordenada por `value`; ausente em documentos anteriores à v4. */
  readonly palette?: readonly LevelPaletteEntry[];
  /**
   * Atlas que dá arte aos tiles resolvidos deste nível; ausente em documentos
   * anteriores à v5 (e em níveis que ainda não escolheram arte — o canvas e o
   * host desenham cor determinística nesse caso, JUNTOS).
   */
  readonly tilesetId?: string;
}

/** Faixa de valores pintáveis do IntGrid (0 é o vazio implícito). */
export const MIN_PALETTE_VALUE = 1;
export const MAX_PALETTE_VALUE = 32767;

/** Limite alinhado ao TilemapStore da engine (256×256). */
export const MAX_LEVEL_CELLS = 256 * 256;

/**
 * Quem originou o comando. A proveniência é definida pela BORDA confiável
 * (gateway, MCP, IPC), NUNCA pelo payload — payload não escolhe quem é.
 */
export type CommandActor = "human" | "agent" | "pipeline";

export interface CommandMetadata {
  readonly actor: CommandActor;
  /** Rótulo humano do gesto ("Mover Player"), para o histórico da UI. */
  readonly label?: string;
  /** Comando sem inverso: o histórico não desfaz além dele. */
  readonly barrier?: boolean;
}

/**
 * Contexto que acompanha todo comando canônico. `transactionId` agrupa os
 * comandos de UM gesto do usuário (um arrasto vira um item de histórico, não
 * trinta), e é o que o coalescing da etapa seguinte usa.
 */
export interface CommandContext {
  readonly transactionId?: string;
  readonly metadata?: CommandMetadata;
}

/** Mudança de UMA célula do IntGrid, com o valor anterior explícito. */
export interface LevelCellChange {
  /** Índice linha-maior na grade (`y * width + x`). */
  readonly index: number;
  readonly before: number;
  readonly after: number;
}

/** Mudança de UMA entrada da paleta; `null` significa ausência. */
export interface LevelPaletteChange {
  readonly value: number;
  readonly before: LevelPaletteEntry | null;
  readonly after: LevelPaletteEntry | null;
}

/** Mudança de um campo tipado de instância, com o valor anterior explícito. */
export interface EntityPropertyChange {
  readonly name: string;
  readonly before: unknown;
  readonly after: unknown;
}

type Command =
  | { readonly kind: "skeleton/define"; readonly skeleton: SkeletonBlueprint }
  | { readonly kind: "mesh/bind"; readonly binding: MeshBinding }
  | {
      readonly kind: "camera/configure";
      readonly settings: CameraSettings;
      /** `true` substitui a configuração inteira em vez de mesclar — é o que o inverso precisa. */
      readonly replace?: boolean;
    }
  | { readonly kind: "light/add"; readonly light: LightSpec }
  | { readonly kind: "light/update"; readonly light: LightSpec }
  | { readonly kind: "light/remove"; readonly lightId: string }
  | { readonly kind: "entitydef/define"; readonly definition: EntityDefinition }
  | { readonly kind: "entitydef/update"; readonly definition: EntityDefinition }
  | { readonly kind: "entitydef/remove"; readonly entityDefId: string }
  | { readonly kind: "entity/place"; readonly entity: EntityInstance }
  | { readonly kind: "entity/move"; readonly entityId: string; readonly position: readonly [number, number] }
  | {
      readonly kind: "entity/properties";
      readonly entityId: string;
      readonly changes: readonly EntityPropertyChange[];
    }
  | { readonly kind: "entity/remove"; readonly entityId: string }
  | { readonly kind: "tileset/define"; readonly tileset: TilesetSpec }
  | { readonly kind: "tileset/remove"; readonly tilesetId: string }
  | { readonly kind: "level/define"; readonly level: LevelSpec }
  | { readonly kind: "level/update"; readonly level: LevelSpec }
  | {
      readonly kind: "level/patch";
      readonly levelId: string;
      readonly changes: readonly LevelCellChange[];
    }
  | {
      readonly kind: "level/palette";
      readonly levelId: string;
      readonly changes: readonly LevelPaletteChange[];
    }
  | { readonly kind: "level/remove"; readonly levelId: string }
  | { readonly kind: "world/place"; readonly placement: WorldPlacement }
  | { readonly kind: "world/unplace"; readonly levelId: string };

export type BlueprintCommand = Command & CommandContext;

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
  | { readonly kind: "lightUpdated"; readonly light: LightSpec }
  | { readonly kind: "lightRemoved"; readonly lightId: string }
  | { readonly kind: "entityDefDefined"; readonly definition: EntityDefinition }
  | { readonly kind: "entityDefUpdated"; readonly definition: EntityDefinition }
  | { readonly kind: "entityDefRemoved"; readonly entityDefId: string }
  | {
      readonly kind: "entityPropertiesChanged";
      readonly entity: EntityInstance;
      readonly changes: readonly EntityPropertyChange[];
      readonly archetypeId?: string;
    }
  // evento enriquecido: a projeção precisa do archetype sem consultar o store
  | { readonly kind: "entityPlaced"; readonly entity: EntityInstance; readonly archetypeId?: string }
  | { readonly kind: "entityMoved"; readonly entity: EntityInstance; readonly archetypeId?: string }
  | { readonly kind: "entityRemoved"; readonly entityId: string }
  | { readonly kind: "tilesetDefined"; readonly tileset: TilesetSpec }
  | { readonly kind: "tilesetRemoved"; readonly tilesetId: string }
  | { readonly kind: "levelDefined"; readonly level: LevelSpec }
  | { readonly kind: "levelUpdated"; readonly level: LevelSpec }
  | {
      readonly kind: "levelPatched";
      readonly level: LevelSpec;
      readonly changes: readonly LevelCellChange[];
    }
  | {
      readonly kind: "levelPaletteChanged";
      readonly level: LevelSpec;
      readonly changes: readonly LevelPaletteChange[];
    }
  | { readonly kind: "levelRemoved"; readonly levelId: string }
  | { readonly kind: "worldLevelPlaced"; readonly placement: WorldPlacement }
  | { readonly kind: "worldLevelUnplaced"; readonly levelId: string };

/** Resultado de um comando: o evento e como desfazê-lo. */
export interface AppliedCommand {
  readonly event: BlueprintEvent;
  /**
   * Comandos que restauram o estado anterior, na ordem em que devem ser
   * aplicados. Vazio significa BARREIRA: o comando não é desfazível e o
   * histórico para nele.
   */
  readonly inverse: readonly BlueprintCommand[];
  readonly barrier: boolean;
}

/**
 * Lote planejado mas ainda não comitado. O estado real só muda em
 * `commitBatch`, e só se a versão base ainda for a corrente.
 */
export interface BatchPlan {
  readonly source: BlueprintStore;
  readonly baseVersion: number;
  readonly draft: BlueprintStore;
  readonly results: readonly AppliedCommand[];
}

/**
 * Estado canônico sem publicação própria. `apply` devolve o evento ao
 * orquestrador; somente o ProjectSessionManager publica depois que store e
 * CommandHistory foram confirmados como um único commit.
 *
 * TRANSACIONAL: um lote é validado inteiro num rascunho privado
 * (`planBatch`) e só então adotado de uma vez (`commitBatch`). Falha no
 * terceiro comando NUNCA deixa os dois primeiros aplicados — antes disto, um
 * replay que falhasse no meio deixava o documento pela metade, e a única
 * proteção era o chamador lembrar de usar um store temporário.
 */
export class BlueprintStore {
  private skeletons = new Map<string, SkeletonBlueprint>();
  private meshes = new Map<string, MeshBinding>();
  private lights = new Map<string, LightSpec>();
  private entityDefs = new Map<string, EntityDefinition>();
  private entities = new Map<string, EntityInstance>();
  private tilesets = new Map<string, TilesetSpec>();
  private levels = new Map<string, LevelSpec>();
  private placements = new Map<string, WorldPlacement>();
  private camera: CameraSettings = {};

  /**
   * Relógio de mutação, usado como compare-and-swap INTERNO do lote: um plano
   * preparado sobre a versão N só pode ser comitado enquanto a versão ainda
   * for N. Distinto do `commandSequence` do histórico, que é o relógio lógico
   * publicado nos eventos.
   */
  private version = 0;

  get mutationVersion(): number {
    return this.version;
  }

  /** Rascunho independente com o MESMO conteúdo. Valores já são congelados. */
  fork(): BlueprintStore {
    const draft = new BlueprintStore();
    draft.skeletons = new Map(this.skeletons);
    draft.meshes = new Map(this.meshes);
    draft.lights = new Map(this.lights);
    draft.entityDefs = new Map(this.entityDefs);
    draft.entities = new Map(this.entities);
    draft.tilesets = new Map(this.tilesets);
    draft.levels = new Map(this.levels);
    draft.placements = new Map(this.placements);
    draft.camera = this.camera;
    draft.version = this.version;
    return draft;
  }

  /**
   * Valida e aplica o lote inteiro num rascunho. Qualquer comando que falhe
   * lança e o rascunho é descartado — este store não foi tocado.
   */
  planBatch(commands: readonly BlueprintCommand[]): BatchPlan {
    const draft = this.fork();
    const results = commands.map((command) => draft.applyMutable(command));
    return Object.freeze({ source: this, baseVersion: this.version, draft, results });
  }

  /**
   * Adota o rascunho de uma vez, SINCRONAMENTE. Recusa plano de outro store ou
   * preparado sobre uma versão que já mudou — sem isso, dois lotes concorrentes
   * sobrescreveriam um ao outro em silêncio.
   */
  commitBatch(plan: BatchPlan): void {
    if (plan.source !== this) {
      throw new JsonRpcError(
        RpcErrorCode.ProjectSessionConflict,
        "Batch plan was prepared by a different BlueprintStore",
      );
    }
    if (plan.baseVersion !== this.version) {
      throw new JsonRpcError(
        RpcErrorCode.ProjectSessionConflict,
        `Batch plan is stale (prepared over version ${plan.baseVersion}, store is at ${this.version})`,
      );
    }
    const draft = plan.draft;
    this.skeletons = draft.skeletons;
    this.meshes = draft.meshes;
    this.lights = draft.lights;
    this.entityDefs = draft.entityDefs;
    this.entities = draft.entities;
    this.tilesets = draft.tilesets;
    this.levels = draft.levels;
    this.placements = draft.placements;
    this.camera = draft.camera;
    this.version += 1;
  }

  /** Aplica um comando e devolve evento + inverso. */
  applyWithInverse(command: BlueprintCommand): AppliedCommand {
    const plan = this.planBatch([command]);
    this.commitBatch(plan);
    return plan.results[0]!;
  }

  /** Fachada histórica: só o evento. */
  apply(command: BlueprintCommand): BlueprintEvent {
    return this.applyWithInverse(command).event;
  }

  private applyMutable(command: BlueprintCommand): AppliedCommand {
    switch (command.kind) {
      case "camera/configure": {
        validateCameraSettings(command.settings);
        const previous = this.camera;
        const next = Object.freeze(
          command.replace === true ? { ...command.settings } : { ...previous, ...command.settings },
        );
        rejectNoop(valuesEqual(previous, next), "camera/configure would not change anything");
        this.camera = next;
        return applied({ kind: "cameraConfigured", settings: next }, [
          { kind: "camera/configure", settings: previous, replace: true },
        ]);
      }
      case "light/add": {
        const light = command.light;
        validateLight(light);
        if (this.lights.has(light.lightId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Light "${light.lightId}" already exists`);
        }
        this.lights.set(light.lightId, Object.freeze({ ...light }));
        return applied({ kind: "lightAdded", light }, [
          { kind: "light/remove", lightId: light.lightId },
        ]);
      }
      case "light/update": {
        const light = command.light;
        validateLight(light);
        const previous = this.lights.get(light.lightId);
        if (!previous) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Light "${light.lightId}" does not exist — use light/add to create it`,
          );
        }
        rejectNoop(valuesEqual(previous, light), `light/update would not change "${light.lightId}"`);
        // substituição integral (mesma forma de level/update): o inverso é
        // exato e a ordem de inserção do Map — logo a ordem do documento
        // exportado — não muda, o que remove+add não garantiria.
        this.lights.set(light.lightId, Object.freeze({ ...light }));
        return applied({ kind: "lightUpdated", light }, [
          { kind: "light/update", light: previous },
        ]);
      }
      case "light/remove": {
        const previous = this.lights.get(command.lightId);
        if (!previous) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Light "${command.lightId}" does not exist`);
        }
        this.lights.delete(command.lightId);
        return applied({ kind: "lightRemoved", lightId: command.lightId }, [
          { kind: "light/add", light: previous },
        ]);
      }
      case "entitydef/define": {
        const definition = command.definition;
        validateEntityDefinition(definition);
        this.requireEntitySprite(definition);
        if (this.entityDefs.has(definition.entityDefId)) {
          throw new JsonRpcError(
            RpcErrorCode.DuplicateId,
            `Entity definition "${definition.entityDefId}" already exists`,
          );
        }
        this.entityDefs.set(definition.entityDefId, Object.freeze({ ...definition }));
        return applied({ kind: "entityDefDefined", definition }, [
          { kind: "entitydef/remove", entityDefId: definition.entityDefId },
        ]);
      }
      case "entitydef/update": {
        const definition = command.definition;
        validateEntityDefinition(definition);
        const previous = this.entityDefs.get(definition.entityDefId);
        if (!previous) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Entity definition "${definition.entityDefId}" does not exist — use entitydef/define to create it`,
          );
        }
        rejectNoop(
          valuesEqual(previous, definition),
          `entitydef/update would not change "${definition.entityDefId}"`,
        );
        this.requireEntitySprite(definition);

        const live = [...this.entities.values()].filter(
          (entity) => entity.entityDefId === definition.entityDefId,
        );
        if (live.length > 0 && previous.archetypeId !== definition.archetypeId) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Cannot change the archetype of "${definition.entityDefId}" while ${live.length} instance(s) exist — ` +
              `remove the instances first, or create a new definition`,
          );
        }
        // Uma atualização que mudaria IMPLICITAMENTE os campos já resolvidos
        // das instâncias é recusada: reescrever instância por tabela é uma
        // migração de conteúdo, não um update de definição.
        for (const entity of live) {
          let resolved: EntityInstance;
          try {
            resolved = resolveEntityFields(entity, definition);
          } catch (error) {
            throw new JsonRpcError(
              RpcErrorCode.InvalidParams,
              `Entity "${entity.entityId}" would become invalid under the new definition: ` +
                (error instanceof Error ? error.message : String(error)),
            );
          }
          if (!valuesEqual(resolved.fields, entity.fields)) {
            throw new JsonRpcError(
              RpcErrorCode.InvalidParams,
              `Entity "${entity.entityId}" would have its resolved fields changed implicitly — ` +
                `update the instances with entity/properties first`,
            );
          }
        }

        this.entityDefs.set(definition.entityDefId, Object.freeze({ ...definition }));
        return applied({ kind: "entityDefUpdated", definition }, [
          { kind: "entitydef/update", definition: previous },
        ]);
      }
      case "entitydef/remove": {
        const previous = this.entityDefs.get(command.entityDefId);
        if (!previous) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Entity definition "${command.entityDefId}" does not exist`,
          );
        }
        const live = [...this.entities.values()].filter(
          (entity) => entity.entityDefId === command.entityDefId,
        );
        if (live.length > 0) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Entity definition "${command.entityDefId}" still has ${live.length} instance(s) — ` +
              `remove them before removing the definition`,
          );
        }
        this.entityDefs.delete(command.entityDefId);
        return applied({ kind: "entityDefRemoved", entityDefId: command.entityDefId }, [
          { kind: "entitydef/define", definition: previous },
        ]);
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
        return applied(
          {
            kind: "entityPlaced",
            entity,
            ...(definition.archetypeId !== undefined ? { archetypeId: definition.archetypeId } : {}),
          },
          [{ kind: "entity/remove", entityId: entity.entityId }],
        );
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
        rejectNoop(
          valuesEqual(current.position, position),
          `entity/move would leave "${command.entityId}" in the same position`,
        );
        const entity: EntityInstance = Object.freeze({
          ...current,
          position: [position[0]!, position[1]!] as readonly [number, number],
        });
        this.entities.set(entity.entityId, entity);
        const definition = this.entityDefs.get(entity.entityDefId);
        return applied(
          {
            kind: "entityMoved",
            entity,
            ...(definition?.archetypeId !== undefined ? { archetypeId: definition.archetypeId } : {}),
          },
          [{ kind: "entity/move", entityId: entity.entityId, position: current.position }],
        );
      }
      case "entity/properties": {
        const current = this.entities.get(command.entityId);
        if (!current) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity "${command.entityId}" does not exist`);
        }
        const definition = this.entityDefs.get(current.entityDefId);
        if (!definition) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Entity definition "${current.entityDefId}" is not defined`,
          );
        }
        if (!Array.isArray(command.changes) || command.changes.length === 0) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `"changes" must be a non-empty array`);
        }

        const byName = new Map(definition.fields.map((field) => [field.name, field]));
        const fields: Record<string, unknown> = { ...current.fields };
        let effective = 0;
        for (const change of command.changes) {
          const field = byName.get(change.name);
          if (!field) {
            throw new JsonRpcError(
              RpcErrorCode.InvalidParams,
              `Field "${change.name}" is not declared in "${definition.entityDefId}"`,
            );
          }
          // `before` desatualizado significa que o cliente editou sobre uma
          // leitura velha: é conflito, não parâmetro inválido.
          if (!valuesEqual(fields[change.name], change.before)) {
            throw new JsonRpcError(
              RpcErrorCode.ProjectSessionConflict,
              `Field "${change.name}" of "${command.entityId}" changed since it was read`,
            );
          }
          validateFieldValue(field, change.after, `"${change.name}" of entity "${command.entityId}"`);
          if (!valuesEqual(change.before, change.after)) effective++;
          fields[change.name] = change.after;
        }
        rejectNoop(effective === 0, `entity/properties would not change "${command.entityId}"`);

        const entity: EntityInstance = Object.freeze({ ...current, fields: Object.freeze(fields) });
        this.entities.set(entity.entityId, entity);
        return applied(
          {
            kind: "entityPropertiesChanged",
            entity,
            changes: command.changes,
            ...(definition.archetypeId !== undefined ? { archetypeId: definition.archetypeId } : {}),
          },
          [
            {
              kind: "entity/properties",
              entityId: command.entityId,
              changes: command.changes.map((change) => ({
                name: change.name,
                before: change.after,
                after: change.before,
              })),
            },
          ],
        );
      }
      case "entity/remove": {
        const previous = this.entities.get(command.entityId);
        if (!previous) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Entity "${command.entityId}" does not exist`);
        }
        this.entities.delete(command.entityId);
        return applied({ kind: "entityRemoved", entityId: command.entityId }, [
          { kind: "entity/place", entity: previous },
        ]);
      }
      case "tileset/define": {
        const tileset = command.tileset;
        validateTileset(tileset);
        if (this.tilesets.has(tileset.tilesetId)) {
          throw new JsonRpcError(
            RpcErrorCode.DuplicateId,
            `Tileset "${tileset.tilesetId}" already exists`,
          );
        }
        this.tilesets.set(tileset.tilesetId, Object.freeze({ ...tileset }));
        return applied({ kind: "tilesetDefined", tileset: this.tilesets.get(tileset.tilesetId)! }, [
          { kind: "tileset/remove", tilesetId: tileset.tilesetId },
        ]);
      }
      case "tileset/remove": {
        const previous = this.tilesets.get(command.tilesetId);
        if (!previous) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Tileset "${command.tilesetId}" does not exist`,
          );
        }
        // Remoção enquanto referenciado é recusada, não cascateada: cascatear
        // reescreveria níveis por efeito colateral, e o inverso deixaria de
        // ser um único define — a mesma regra do entitydef com instâncias.
        const referenced = [...this.levels.values()].filter(
          (level) => level.tilesetId === command.tilesetId,
        );
        if (referenced.length > 0) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Tileset "${command.tilesetId}" is still used by ${referenced.length} level(s) — ` +
              `update the levels first (level/update without tilesetId)`,
          );
        }
        this.tilesets.delete(command.tilesetId);
        return applied({ kind: "tilesetRemoved", tilesetId: command.tilesetId }, [
          { kind: "tileset/define", tileset: previous },
        ]);
      }
      case "level/define": {
        const level = command.level;
        validateLevel(level);
        this.requireTileset(level);
        if (this.levels.has(level.levelId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Level "${level.levelId}" is already defined`);
        }
        this.levels.set(level.levelId, normalizeLevel(level));
        return applied({ kind: "levelDefined", level: this.levels.get(level.levelId)! }, [
          { kind: "level/remove", levelId: level.levelId },
        ]);
      }
      case "level/update": {
        const level = command.level;
        validateLevel(level);
        this.requireTileset(level);
        const previous = this.levels.get(level.levelId);
        if (!previous) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Level "${level.levelId}" does not exist — use level/define to create it`,
          );
        }
        rejectNoop(
          valuesEqual(previous, normalizeLevel(level)),
          `level/update would not change "${level.levelId}"`,
        );
        this.levels.set(level.levelId, normalizeLevel(level));
        return applied({ kind: "levelUpdated", level: this.levels.get(level.levelId)! }, [
          { kind: "level/update", level: previous },
        ]);
      }
      case "level/patch": {
        const previous = this.levels.get(command.levelId);
        if (!previous) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Level "${command.levelId}" does not exist`);
        }
        // Um patch é um GESTO (uma pincelada), não um comando avulso: sem
        // transactionId o histórico não teria como coalescer as centenas de
        // células de um arrasto num único item desfazível.
        if (typeof command.transactionId !== "string" || command.transactionId.length === 0) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `"level/patch" requires a transactionId identifying the gesture`,
          );
        }
        if (!Array.isArray(command.changes) || command.changes.length === 0) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `"changes" must be a non-empty array`);
        }

        const cells = [...previous.intGrid];
        let effective = 0;
        for (const change of command.changes) {
          if (!Number.isInteger(change.index) || change.index < 0 || change.index >= cells.length) {
            throw new JsonRpcError(
              RpcErrorCode.InvalidParams,
              `Cell index ${String(change.index)} is outside level "${command.levelId}"`,
            );
          }
          if (!Number.isInteger(change.after) || change.after < 0 || change.after > MAX_PALETTE_VALUE) {
            throw new JsonRpcError(
              RpcErrorCode.InvalidParams,
              `Cell value must be an integer between 0 and ${MAX_PALETTE_VALUE}`,
            );
          }
          // `before` divergente = o cliente pintou sobre uma leitura velha.
          if (cells[change.index] !== change.before) {
            throw new JsonRpcError(
              RpcErrorCode.ProjectSessionConflict,
              `Cell ${change.index} of "${command.levelId}" changed since it was read`,
            );
          }
          if (change.before !== change.after) effective++;
          cells[change.index] = change.after;
        }
        rejectNoop(effective === 0, `level/patch would not change "${command.levelId}"`);

        const level: LevelSpec = Object.freeze({ ...previous, intGrid: Object.freeze(cells) });
        this.levels.set(level.levelId, level);
        return applied({ kind: "levelPatched", level, changes: command.changes }, [
          {
            kind: "level/patch",
            levelId: command.levelId,
            transactionId: command.transactionId,
            changes: command.changes.map((change) => ({
              index: change.index,
              before: change.after,
              after: change.before,
            })),
          },
        ]);
      }
      case "level/palette": {
        const previous = this.levels.get(command.levelId);
        if (!previous) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Level "${command.levelId}" does not exist`);
        }
        if (!Array.isArray(command.changes) || command.changes.length === 0) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `"changes" must be a non-empty array`);
        }

        const byValue = new Map((previous.palette ?? []).map((entry) => [entry.value, entry]));
        let effective = 0;
        for (const change of command.changes) {
          validatePaletteValue(change.value);
          if (change.after !== null) validatePaletteEntry(change.after, change.value);
          const current = byValue.get(change.value) ?? null;
          if (!valuesEqual(current, change.before)) {
            throw new JsonRpcError(
              RpcErrorCode.ProjectSessionConflict,
              `Palette entry ${change.value} of "${command.levelId}" changed since it was read`,
            );
          }
          if (!valuesEqual(change.before, change.after)) effective++;
          if (change.after === null) byValue.delete(change.value);
          else byValue.set(change.value, Object.freeze({ ...change.after }));
        }
        rejectNoop(effective === 0, `level/palette would not change "${command.levelId}"`);

        const level = normalizeLevel({ ...previous, palette: [...byValue.values()] });
        this.levels.set(level.levelId, level);
        return applied({ kind: "levelPaletteChanged", level, changes: command.changes }, [
          {
            kind: "level/palette",
            levelId: command.levelId,
            changes: command.changes.map((change) => ({
              value: change.value,
              before: change.after,
              after: change.before,
            })),
          },
        ]);
      }
      case "level/remove": {
        const previous = this.levels.get(command.levelId);
        if (!previous) {
          throw new JsonRpcError(RpcErrorCode.InvalidParams, `Level "${command.levelId}" does not exist`);
        }
        const placement = this.placements.get(command.levelId);
        this.levels.delete(command.levelId);
        this.placements.delete(command.levelId); // sai também do world map
        // o inverso restaura TAMBÉM a posição no world map: sem o segundo
        // comando, desfazer a remoção devolveria o nível sem lugar nenhum
        const inverse: BlueprintCommand[] = [{ kind: "level/define", level: previous }];
        if (placement) inverse.push({ kind: "world/place", placement });
        return applied({ kind: "levelRemoved", levelId: command.levelId }, inverse);
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
        const previous = this.placements.get(placement.levelId);
        rejectNoop(
          previous !== undefined && valuesEqual(previous, placement),
          `world/place would leave "${placement.levelId}" in the same spot`,
        );
        // re-posicionar é permitido (drag-n-drop): substitui a colocação
        this.placements.set(placement.levelId, Object.freeze({ ...placement }));
        return applied({ kind: "worldLevelPlaced", placement }, [
          previous
            ? { kind: "world/place", placement: previous }
            : { kind: "world/unplace", levelId: placement.levelId },
        ]);
      }
      case "world/unplace": {
        const previous = this.placements.get(command.levelId);
        if (!previous) {
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `Level "${command.levelId}" is not placed on the world map`,
          );
        }
        this.placements.delete(command.levelId);
        return applied({ kind: "worldLevelUnplaced", levelId: command.levelId }, [
          { kind: "world/place", placement: previous },
        ]);
      }
      case "skeleton/define": {
        const s = command.skeleton;
        validateSkeleton(s);
        if (this.skeletons.has(s.skeletonId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Skeleton "${s.skeletonId}" is already defined`);
        }
        this.skeletons.set(s.skeletonId, deepFreezeSkeleton(s));
        // BARREIRA: não existe skeleton/remove no domínio, então não há
        // inverso. Inventar um comando só para "completar" o par criaria um
        // kind sem DoD e sem projeção.
        return applied({ kind: "skeletonDefined", skeleton: s }, [], true);
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
        return applied({ kind: "meshBound", binding: b }, [], true); // BARREIRA, idem
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

  getTileset(tilesetId: string): TilesetSpec | undefined {
    return this.tilesets.get(tilesetId);
  }

  listTilesets(): readonly TilesetSpec[] {
    return [...this.tilesets.values()];
  }

  /**
   * Um nível que aponta para um tileset inexistente é recusado NA ESCRITA. A
   * alternativa — aceitar e degradar na projeção — deixaria o erro aparecer
   * longe da causa, num frame desenhado em cor chapada sem explicação.
   */
  /**
   * O sprite aponta para arte que EXISTE.
   *
   * Aqui a regra é mais dura que a do tilemap, e de propósito. O `tileId` de
   * uma célula é DERIVADO pelo AutoTiler: um id fora do atlas é possível sem
   * ninguém ter errado, então os dois lados degradam juntos para a cor
   * determinística. O sprite é ESCOLHIDO — alguém apontou para um tile. Aceitar
   * um índice que o atlas não tem transformaria o engano num quadrado colorido
   * que o usuário passaria a vida tentando entender.
   */
  private requireEntitySprite(definition: EntityDefinition): void {
    const sprite = definition.sprite;
    if (sprite === undefined) return;
    const tileset = this.tilesets.get(sprite.tilesetId);
    if (!tileset) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Tileset "${sprite.tilesetId}" is not defined — use tileset/define first`,
      );
    }
    if (sprite.tileId >= tileset.tileCount) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Tile ${sprite.tileId} is outside tileset "${sprite.tilesetId}" (${tileset.tileCount} tiles)`,
      );
    }
  }

  private requireTileset(level: LevelSpec): void {
    if (level.tilesetId === undefined) return;
    if (typeof level.tilesetId !== "string" || level.tilesetId.length === 0) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"tilesetId" must be a non-empty string when present`,
      );
    }
    if (!this.tilesets.has(level.tilesetId)) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Tileset "${level.tilesetId}" is not defined — use tileset/define first`,
      );
    }
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

function validateTileset(tileset: TilesetSpec): void {
  if (typeof tileset.tilesetId !== "string" || tileset.tilesetId.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"tilesetId" must be a non-empty string`);
  }
  if (typeof tileset.image !== "string" || tileset.image.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"image" must be a non-empty string`);
  }
  if (!Number.isInteger(tileset.tileSize) || tileset.tileSize < 1) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"tileSize" must be a positive integer`);
  }
  if (!Number.isInteger(tileset.columns) || tileset.columns < 1) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"columns" must be a positive integer`);
  }
  if (!Number.isInteger(tileset.tileCount) || tileset.tileCount < 1) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"tileCount" must be a positive integer`);
  }
  // um atlas com menos tiles que uma linha completa é legítimo; mais colunas
  // que tiles não é — a fórmula produziria uma primeira linha com buracos
  if (tileset.tileCount < tileset.columns) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `"tileCount" (${tileset.tileCount}) must be at least "columns" (${tileset.columns})`,
    );
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
  if (level.palette !== undefined) {
    if (!Array.isArray(level.palette)) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"palette" must be an array`);
    }
    const seen = new Set<number>();
    for (const entry of level.palette) {
      validatePaletteEntry(entry);
      if (seen.has(entry.value)) {
        throw new JsonRpcError(
          RpcErrorCode.InvalidParams,
          `Duplicate palette value ${entry.value}`,
        );
      }
      seen.add(entry.value);
    }
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
  if (def.sprite !== undefined) {
    if (typeof def.sprite !== "object" || def.sprite === null) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"sprite" must be an object when present`);
    }
    if (typeof def.sprite.tilesetId !== "string" || def.sprite.tilesetId.length === 0) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"sprite.tilesetId" must be a non-empty string`,
      );
    }
    if (!Number.isInteger(def.sprite.tileId) || def.sprite.tileId < 0) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"sprite.tileId" must be a non-negative integer`,
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

/**
 * Forma canônica do nível: paleta ordenada por `value` e congelada.
 *
 * Ordenar na entrada, e não na leitura, é o que torna a comparação estrutural
 * de `level/update` confiável — sem isso, dois níveis idênticos com a paleta
 * em ordens diferentes pareceriam distintos e o no-op não seria detectado.
 */
function normalizeLevel(level: LevelSpec): LevelSpec {
  if (level.palette === undefined) return Object.freeze({ ...level });
  const palette = [...level.palette]
    .sort((a, b) => a.value - b.value)
    .map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({ ...level, palette: Object.freeze(palette) });
}

function validatePaletteValue(value: unknown): void {
  if (
    !Number.isInteger(value) ||
    (value as number) < MIN_PALETTE_VALUE ||
    (value as number) > MAX_PALETTE_VALUE
  ) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `Palette value must be an integer between ${MIN_PALETTE_VALUE} and ${MAX_PALETTE_VALUE} ` +
        `(0 is the implicit empty cell)`,
    );
  }
}

function validatePaletteEntry(entry: LevelPaletteEntry, expectedValue?: number): void {
  validatePaletteValue(entry.value);
  if (expectedValue !== undefined && entry.value !== expectedValue) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `Palette entry declares value ${entry.value} but the change targets ${expectedValue}`,
    );
  }
  if (typeof entry.name !== "string" || entry.name.trim().length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `Palette entry requires a non-empty "name"`);
  }
  if (typeof entry.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(entry.color)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `Palette "color" must be "#rrggbb"`);
  }
}

/** Empacota evento + inverso. `barrier` marca comando que não se desfaz. */
function applied(
  event: BlueprintEvent,
  inverse: readonly BlueprintCommand[],
  barrier = false,
): AppliedCommand {
  return Object.freeze({ event, inverse: Object.freeze([...inverse]), barrier });
}

/**
 * Recusa comando que não muda nada.
 *
 * Não é preciosismo: um no-op aceito viraria uma entrada de histórico vazia,
 * e o usuário apertaria Ctrl+Z sem que nada acontecesse na tela — parecendo
 * que o desfazer quebrou. Melhor recusar na borda do domínio.
 */
function rejectNoop(isNoop: boolean, message: string): void {
  if (isNoop) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, message);
  }
}

/**
 * Igualdade ESTRUTURAL por valor. Comparar por referência não serve: os
 * comandos chegam desserializados do fio, então dois objetos equivalentes
 * nunca são o mesmo objeto.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => valuesEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // chaves com valor `undefined` são equivalentes a chaves ausentes: o
  // JSON do fio não distingue as duas
  const keys = (o: Record<string, unknown>): string[] =>
    Object.keys(o).filter((key) => o[key] !== undefined);
  const leftKeys = keys(left);
  const rightKeys = keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => rightKeys.includes(key) && valuesEqual(left[key], right[key]),
  );
}

function deepFreezeSkeleton(s: SkeletonBlueprint): SkeletonBlueprint {
  for (const bone of s.bones) {
    Object.freeze(bone.inverseBindMatrix);
    Object.freeze(bone);
  }
  Object.freeze(s.bones);
  return Object.freeze(s);
}
