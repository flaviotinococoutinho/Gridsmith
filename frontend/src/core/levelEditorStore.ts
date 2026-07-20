import type { BlueprintEventPayload } from "./editorCommands.js";
import { IntGridDocument, type CellChange } from "./intGridDocument.js";
import type { CellSelection, Selection } from "./selectionService.js";
import {
  selectLevelEditorProjection,
  type LevelEditorProjectionDocument,
  type ProjectedCameraSettings,
  type ProjectedEntity,
  type ProjectedEntityDefinition,
  type ProjectedLight,
  type ProjectedLevel,
  type ProjectedMesh,
  type ProjectedProjectMetadata,
  type ProjectedPaletteEntry,
  type ProjectedSkeleton,
} from "./levelEditorProjection.js";

export interface EditableLevelProjection extends Omit<ProjectedLevel, "intGrid"> {
  readonly intGrid: IntGridDocument;
}

export interface LevelEditorStoreSnapshot {
  readonly projectId: string | undefined;
  readonly metadata: ProjectedProjectMetadata | undefined;
  readonly level: EditableLevelProjection | undefined;
  readonly levels: readonly EditableLevelProjection[];
  readonly entities: readonly ProjectedEntity[];
  readonly entityDefinitions: readonly ProjectedEntityDefinition[];
  readonly playerEntityDefinitionId: string | undefined;
  readonly camera: ProjectedCameraSettings;
  readonly lights: readonly ProjectedLight[];
  readonly skeletons: readonly ProjectedSkeleton[];
  readonly meshes: readonly ProjectedMesh[];
}

export interface LevelEditorProjectionCursor {
  readonly projectSessionId: string;
  readonly commandSequence: string;
}

/**
 * Projeção de sessão compartilhada entre painéis. Open/resync substituem a
 * base; eventos incrementais atualizam a mesma instância consumida pelo canvas.
 */
export class LevelEditorStore {
  private projectId: string | undefined;
  private metadata: ProjectedProjectMetadata | undefined;
  private levels = new Map<string, EditableLevelProjection>();
  private entities = new Map<string, ProjectedEntity>();
  private entityDefinitions = new Map<string, ProjectedEntityDefinition>();
  private camera: ProjectedCameraSettings = {};
  private lights = new Map<string, ProjectedLight>();
  private skeletons: readonly ProjectedSkeleton[] = [];
  private meshes: readonly ProjectedMesh[] = [];
  private playerEntityDefinitionId: string | undefined;
  private preferredLevelId: string | undefined;
  private activeProjectSessionId: string | undefined;
  private lastCommandSequence: bigint | undefined;
  /** Eventos do journal aguardando uma sequência intermediária/resync. */
  private readonly bufferedJournalEvents = new Map<bigint, BlueprintEventPayload>();
  /**
   * ACKs unary podem ultrapassar o journal local quando outro cliente acabou
   * de confirmar um comando. Eles jamais avançam o cursor do journal.
   */
  private readonly bufferedAcknowledgements = new Map<bigint, BlueprintEventPayload>();
  private readonly listeners = new Set<() => void>();

  replace(
    document: LevelEditorProjectionDocument | undefined,
    preferredLevelId: string | undefined,
    cursor: LevelEditorProjectionCursor | undefined,
  ): void {
    const commandSequence = cursor ? parseCommandSequence(cursor.commandSequence) : undefined;
    if (document && (!cursor || commandSequence === undefined)) {
      throw new Error("A level projection requires a valid project session cursor");
    }
    const selected = selectLevelEditorProjection(document, preferredLevelId);
    this.projectId = document?.projectId;
    this.metadata = document?.metadata ? cloneMetadata(document.metadata) : undefined;
    this.levels = new Map(
      (document?.levels ?? []).map((level) => [level.levelId, editableLevel(level)]),
    );
    this.entities = new Map(
      selected.entities.map((entity) => [entity.entityId, cloneEntity(entity)]),
    );
    this.entityDefinitions = new Map(
      (document?.entityDefs ?? []).map((definition) => [
        definition.entityDefId,
        cloneEntityDefinition(definition),
      ]),
    );
    this.camera = { ...(document?.camera ?? {}) };
    this.lights = new Map(
      (document?.lights ?? []).map((light) => [light.lightId, cloneLight(light)]),
    );
    this.skeletons = (document?.skeletons ?? []).map((skeleton) => ({ ...skeleton }));
    this.meshes = (document?.meshes ?? []).map((mesh) => ({ ...mesh }));
    this.playerEntityDefinitionId = selected.playerEntityDefinitionId;
    this.preferredLevelId = selected.level?.levelId ?? preferredLevelId;
    this.activeProjectSessionId = cursor?.projectSessionId;
    this.lastCommandSequence = commandSequence;
    this.bufferedJournalEvents.clear();
    this.bufferedAcknowledgements.clear();
    this.notify();
  }

  select(levelId: string | undefined): void {
    if (levelId && this.levels.has(levelId) && this.preferredLevelId !== levelId) {
      this.preferredLevelId = levelId;
      this.notify();
    }
  }

  get snapshot(): LevelEditorStoreSnapshot {
    return {
      projectId: this.projectId,
      metadata: this.metadata ? cloneMetadata(this.metadata) : undefined,
      level:
        (this.preferredLevelId ? this.levels.get(this.preferredLevelId) : undefined) ??
        this.levels.values().next().value,
      levels: [...this.levels.values()],
      entities: [...this.entities.values()].map(cloneEntity),
      entityDefinitions: [...this.entityDefinitions.values()].map(cloneEntityDefinition),
      playerEntityDefinitionId: this.playerEntityDefinitionId,
      camera: { ...this.camera },
      lights: [...this.lights.values()].map(cloneLight),
      skeletons: this.skeletons.map((skeleton) => ({ ...skeleton })),
      meshes: this.meshes.map((mesh) => ({ ...mesh })),
    };
  }

  get cursor(): LevelEditorProjectionCursor | undefined {
    return this.activeProjectSessionId !== undefined && this.lastCommandSequence !== undefined
      ? {
          projectSessionId: this.activeProjectSessionId,
          commandSequence: this.lastCommandSequence.toString(),
        }
      : undefined;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyEvent(event: BlueprintEventPayload): boolean {
    if (event.projectSessionId !== this.activeProjectSessionId) return false;
    const sequence = parseCommandSequence(event.commandSequence);
    if (sequence === undefined || this.lastCommandSequence === undefined) return false;
    if (sequence <= this.lastCommandSequence) {
      // Eco duplicado/atrasado só resolve uma camada local correspondente;
      // nunca reaplica estado velho.
      return this.settlePendingPatch(event);
    }

    const expected = this.lastCommandSequence + 1n;
    if (sequence > expected) {
      this.bufferedJournalEvents.set(sequence, event);
      return false;
    }

    let applied = this.applyJournalEvent(event, sequence);
    for (;;) {
      const nextSequence = this.lastCommandSequence! + 1n;
      const next = this.bufferedJournalEvents.get(nextSequence);
      if (!next) break;
      this.bufferedJournalEvents.delete(nextSequence);
      applied = this.applyJournalEvent(next, nextSequence) || applied;
    }

    // Depois de fechar o gap, o próximo ACK já pode confirmar a projeção
    // otimista. Ele continua armazenado até o eco do journal avançar o cursor.
    const acknowledgedNext = this.bufferedAcknowledgements.get(
      this.lastCommandSequence! + 1n,
    );
    if (acknowledgedNext) {
      applied = this.applyPayload(acknowledgedNext) || applied;
    }
    if (applied) this.notify();
    return applied;
  }

  /**
   * Confirmação da chamada unary. Pode atualizar a projeção otimista quando
   * é o próximo comando, mas nunca transforma o ACK em cursor de journal.
   */
  applyAcknowledgement(event: BlueprintEventPayload): boolean {
    if (event.projectSessionId !== this.activeProjectSessionId) return false;
    const sequence = parseCommandSequence(event.commandSequence);
    if (sequence === undefined || this.lastCommandSequence === undefined) return false;
    if (sequence <= this.lastCommandSequence) return this.settlePendingPatch(event);

    this.bufferedAcknowledgements.set(sequence, event);
    if (sequence !== this.lastCommandSequence + 1n) return false;
    const applied = this.applyPayload(event);
    if (applied) this.notify();
    return applied;
  }

  private applyJournalEvent(
    event: BlueprintEventPayload,
    sequence: bigint,
  ): boolean {
    this.lastCommandSequence = sequence;
    this.bufferedAcknowledgements.delete(sequence);
    return this.applyPayload(event);
  }

  private applyPayload(event: BlueprintEventPayload): boolean {
    let applied = false;
    switch (event.kind) {
      case "cameraConfigured": {
        const settings = objectField(event, "settings");
        if (settings) {
          this.camera = event["replace"] === true ? { ...settings } : { ...this.camera, ...settings };
          applied = true;
        }
        break;
      }
      case "skeletonDefined": {
        const skeleton = projectedSkeleton(event["skeleton"]);
        if (skeleton) {
          this.skeletons = [...this.skeletons.filter(({ skeletonId }) => skeletonId !== skeleton.skeletonId), skeleton];
          applied = true;
        }
        break;
      }
      case "meshBound": {
        const mesh = projectedMesh(event["binding"]);
        if (mesh) {
          this.meshes = [...this.meshes.filter(({ meshId }) => meshId !== mesh.meshId), mesh];
          applied = true;
        }
        break;
      }
      case "lightAdded":
      case "lightUpdated": {
        const light = projectedLight(event["light"]);
        if (light) {
          this.lights.set(light.lightId, light);
          applied = true;
        }
        break;
      }
      case "lightRemoved": {
        const lightId = stringField(event, "lightId");
        if (lightId) applied = this.lights.delete(lightId);
        break;
      }
      case "entityDefDefined":
      case "entityDefUpdated": {
        const definition = projectedEntityDefinition(event["definition"]);
        if (definition) {
          this.entityDefinitions.set(definition.entityDefId, definition);
          this.refreshPlayerEntityDefinition();
          applied = true;
        }
        break;
      }
      case "entityDefRemoved": {
        const definitionId = stringField(event, "entityDefId");
        if (definitionId) {
          applied = this.entityDefinitions.delete(definitionId);
          if (applied) this.refreshPlayerEntityDefinition();
        }
        break;
      }
      case "levelPatched": {
        const levelId = stringField(event, "levelId");
        const level = levelId ? this.levels.get(levelId) : undefined;
        const changes = cellChanges(event["changes"]);
        if (level && changes) {
          level.intGrid.applyCanonical(changes, event.transactionId);
          applied = true;
        }
        break;
      }
      case "levelDefined":
      case "levelUpdated": {
        const level = projectedLevel(event["level"]);
        if (level) {
          this.levels.set(level.levelId, editableLevel(level));
          this.preferredLevelId ??= level.levelId;
          applied = true;
        }
        break;
      }
      case "levelPaletteChanged": {
        const levelId = stringField(event, "levelId");
        const current = levelId ? this.levels.get(levelId) : undefined;
        const changes = paletteChanges(event["changes"]);
        if (levelId && current && changes && changes.length > 0) {
          const palette = new Map(
            (current.palette ?? []).map((entry) => [entry.value, { ...entry }]),
          );
          for (const change of changes) {
            if (change.after === null) palette.delete(change.value);
            else palette.set(change.value, { ...change.after });
          }
          this.levels.set(levelId, {
            ...current,
            palette: [...palette.values()].sort((left, right) => left.value - right.value),
          });
          applied = true;
        }
        break;
      }
      case "levelRemoved": {
        const levelId = stringField(event, "levelId");
        if (levelId) applied = this.levels.delete(levelId);
        if (levelId === this.preferredLevelId) this.preferredLevelId = undefined;
        break;
      }
      case "entityPlaced":
      case "entityMoved":
      case "entityPropertiesChanged": {
        const entity = projectedEntity(event["entity"]);
        if (entity) {
          this.entities.set(entity.entityId, entity);
          applied = true;
        }
        break;
      }
      case "entityRemoved": {
        const entityId = stringField(event, "entityId");
        if (entityId) applied = this.entities.delete(entityId);
        break;
      }
    }
    return applied;
  }

  rejectLevelPatch(levelId: string, transactionId: string): boolean {
    const rejected = this.levels.get(levelId)?.intGrid.reject(transactionId) ?? false;
    if (rejected) this.notify();
    return rejected;
  }

  private settlePendingPatch(event: BlueprintEventPayload): boolean {
    if (event.kind !== "levelPatched" || !event.transactionId) return false;
    const levelId = stringField(event, "levelId");
    const settled = levelId
      ? this.levels.get(levelId)?.intGrid.settlePending(event.transactionId) ?? false
      : false;
    if (settled) this.notify();
    return settled;
  }

  private refreshPlayerEntityDefinition(): void {
    this.playerEntityDefinitionId = [...this.entityDefinitions.values()].find((definition) =>
      definition.archetypeId === "player" || definition.tags?.includes("player"))?.entityDefId;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Reconcilia o conjunto inteiro de seleções com uma projeção substituída ou
 * redimensionada. Células são normalizadas para coordenadas válidas e índices
 * derivados novamente; alvos removidos desaparecem antes de qualquer Inspector
 * poder lê-los.
 */
export function reconcileSelectionsWithLevelProjection(
  selections: readonly Selection[],
  snapshot: LevelEditorStoreSnapshot,
): readonly Selection[] {
  const levels = new Map(snapshot.levels.map((level) => [level.levelId, level]));
  const entities = new Set(snapshot.entities.map(({ entityId }) => entityId));
  const definitions = new Set(snapshot.entityDefinitions.map(({ entityDefId }) => entityDefId));
  const lights = new Set(snapshot.lights.map(({ lightId }) => lightId));
  const reconciled: Selection[] = [];
  for (const selection of selections) {
    if (selection.projectId !== snapshot.projectId) continue;
    switch (selection.kind) {
      case "project":
      case "camera":
      case "problem":
        reconciled.push(selection);
        break;
      case "level":
        if (levels.has(selection.levelId)) reconciled.push(selection);
        break;
      case "cell": {
        const level = levels.get(selection.levelId);
        if (!level) break;
        const coordinates = new Map<string, { readonly x: number; readonly y: number; readonly index: number }>();
        for (const cell of selection.cells) {
          if (!validCell(cell.x, cell.y, level.width, level.height)) continue;
          coordinates.set(`${cell.x}:${cell.y}`, {
            x: cell.x,
            y: cell.y,
            index: cell.y * level.width + cell.x,
          });
        }
        const cells = [...coordinates.values()];
        if (cells.length === 0) break;
        const anchor = selection.anchor && validCell(
          selection.anchor.x,
          selection.anchor.y,
          level.width,
          level.height,
        )
          ? cells.find(({ x, y }) => x === selection.anchor!.x && y === selection.anchor!.y) ?? cells[0]
          : cells[0];
        reconciled.push({
          ...selection,
          cells,
          ...(anchor ? { anchor } : {}),
        } satisfies CellSelection);
        break;
      }
      case "entity-definition":
        if (definitions.has(selection.definitionId)) reconciled.push(selection);
        break;
      case "entity-instance":
        if (entities.has(selection.entityId)) reconciled.push(selection);
        break;
      case "asset":
        // O catálogo de importação é uma projeção separada do documento de
        // nível. O escopo da SelectionService já impede seleção cross-session;
        // a remoção é reconciliada pelo Asset Browser, não como skeleton/mesh.
        reconciled.push(selection);
        break;
      case "light":
        if (lights.has(selection.lightId)) reconciled.push(selection);
        break;
    }
  }
  return reconciled;
}

function validCell(x: number, y: number, width: number, height: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
}

function parseCommandSequence(value: string): bigint | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function editableLevel(level: ProjectedLevel): EditableLevelProjection {
  return {
    levelId: level.levelId,
    width: level.width,
    height: level.height,
    tileSize: level.tileSize,
    seed: level.seed,
    rules: level.rules,
    ...(level.palette ? { palette: level.palette.map((entry) => ({ ...entry })) } : {}),
    intGrid: new IntGridDocument(level.width, level.height, level.intGrid),
  };
}

function cloneEntity(entity: ProjectedEntity): ProjectedEntity {
  return {
    ...entity,
    position: [entity.position[0], entity.position[1]],
    ...(entity.fields ? { fields: { ...entity.fields } } : {}),
  };
}

function cloneEntityDefinition(definition: ProjectedEntityDefinition): ProjectedEntityDefinition {
  return {
    ...definition,
    ...(definition.tags ? { tags: [...definition.tags] } : {}),
    ...(definition.fields
      ? { fields: definition.fields.map((field) => ({
          ...field,
          ...(field.options ? { options: [...field.options] } : {}),
        })) }
      : {}),
    ...(definition.editor ? { editor: { ...definition.editor } } : {}),
    ...(definition.spriteRenderer
      ? { spriteRenderer: { ...definition.spriteRenderer } }
      : {}),
  };
}

function cloneLight(light: ProjectedLight): ProjectedLight {
  return {
    ...light,
    color: [light.color[0], light.color[1], light.color[2]],
    ...(light.position ? { position: [light.position[0], light.position[1]] } : {}),
    ...(light.direction ? { direction: [light.direction[0], light.direction[1]] } : {}),
  };
}

function cloneMetadata(metadata: ProjectedProjectMetadata): ProjectedProjectMetadata {
  return {
    ...metadata,
    ...(metadata.referenceResolution
      ? { referenceResolution: { ...metadata.referenceResolution } }
      : {}),
    ...(metadata.spatial ? { spatial: { ...metadata.spatial } } : {}),
  };
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function objectField(value: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const candidate = value[field];
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : undefined;
}

function projectedLight(value: unknown): ProjectedLight | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ProjectedLight>;
  if (typeof candidate.lightId !== "string" ||
      !["directional", "point", "spot"].includes(candidate.type ?? "") ||
      !Array.isArray(candidate.color) || candidate.color.length !== 3 ||
      typeof candidate.intensity !== "number") return undefined;
  return cloneLight(candidate as ProjectedLight);
}

function projectedEntityDefinition(value: unknown): ProjectedEntityDefinition | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ProjectedEntityDefinition>;
  return typeof candidate.entityDefId === "string"
    ? cloneEntityDefinition(candidate as ProjectedEntityDefinition)
    : undefined;
}

function cellChanges(value: unknown): readonly CellChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: CellChange[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    if (
      !Number.isInteger(record["index"]) ||
      !Number.isInteger(record["before"]) ||
      !Number.isInteger(record["after"])
    ) return undefined;
    changes.push({
      index: record["index"] as number,
      before: record["before"] as number,
      after: record["after"] as number,
    });
  }
  return changes;
}

interface ProjectedPaletteChange {
  readonly value: number;
  readonly before: ProjectedPaletteEntry | null;
  readonly after: ProjectedPaletteEntry | null;
}

function paletteChanges(value: unknown): readonly ProjectedPaletteChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: ProjectedPaletteChange[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    const paletteValue = record["value"];
    if (!Number.isInteger(paletteValue) || (paletteValue as number) < 1 || seen.has(paletteValue as number)) {
      return undefined;
    }
    const before = paletteChangeEntry(record["before"], paletteValue as number);
    const after = paletteChangeEntry(record["after"], paletteValue as number);
    if (before === undefined || after === undefined) return undefined;
    seen.add(paletteValue as number);
    changes.push({ value: paletteValue as number, before, after });
  }
  return changes;
}

function paletteChangeEntry(
  value: unknown,
  expectedValue: number,
): ProjectedPaletteEntry | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (
    entry["value"] !== expectedValue ||
    typeof entry["name"] !== "string" || entry["name"].length === 0 ||
    typeof entry["color"] !== "string" || !/^#[0-9a-fA-F]{6}$/u.test(entry["color"])
  ) return undefined;
  return {
    value: expectedValue,
    name: entry["name"],
    color: entry["color"],
  };
}

function projectedLevel(value: unknown): ProjectedLevel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const level = value as Record<string, unknown>;
  if (
    typeof level["levelId"] !== "string" ||
    !Number.isInteger(level["width"]) ||
    !Number.isInteger(level["height"]) ||
    !Number.isInteger(level["tileSize"]) ||
    !Number.isInteger(level["seed"]) ||
    !Array.isArray(level["intGrid"]) ||
    !Array.isArray(level["rules"])
  ) return undefined;
  return level as unknown as ProjectedLevel;
}

function projectedEntity(value: unknown): ProjectedEntity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entity = value as Record<string, unknown>;
  const position = entity["position"];
  if (
    typeof entity["entityId"] !== "string" ||
    typeof entity["entityDefId"] !== "string" ||
    !Array.isArray(position) ||
    position.length !== 2 ||
    !position.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) return undefined;
  const fields = entity["fields"];
  if (fields !== undefined && (!fields || typeof fields !== "object" || Array.isArray(fields))) return undefined;
  return {
    entityId: entity["entityId"],
    entityDefId: entity["entityDefId"],
    position: [position[0] as number, position[1] as number],
    ...(fields ? { fields: { ...(fields as Record<string, unknown>) } } : {}),
  };
}

function projectedSkeleton(value: unknown): ProjectedSkeleton | undefined {
  if (!value || typeof value !== "object") return undefined;
  const skeletonId = (value as Record<string, unknown>)["skeletonId"];
  return typeof skeletonId === "string" && skeletonId.length > 0 ? { skeletonId } : undefined;
}

function projectedMesh(value: unknown): ProjectedMesh | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["meshId"] === "string" && candidate["meshId"].length > 0 &&
    typeof candidate["skeletonId"] === "string" && candidate["skeletonId"].length > 0
    ? { meshId: candidate["meshId"], skeletonId: candidate["skeletonId"] }
    : undefined;
}
