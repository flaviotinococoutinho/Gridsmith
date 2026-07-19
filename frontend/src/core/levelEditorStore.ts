import type { BlueprintEventPayload } from "./editorCommands.js";
import { IntGridDocument, type CellChange } from "./intGridDocument.js";
import {
  selectLevelEditorProjection,
  type LevelEditorProjectionDocument,
  type ProjectedEntity,
  type ProjectedLevel,
  type ProjectedPaletteEntry,
} from "./levelEditorProjection.js";

export interface EditableLevelProjection extends Omit<ProjectedLevel, "intGrid"> {
  readonly intGrid: IntGridDocument;
}

export interface LevelEditorStoreSnapshot {
  readonly level: EditableLevelProjection | undefined;
  readonly entities: readonly ProjectedEntity[];
  readonly playerEntityDefinitionId: string | undefined;
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
  private levels = new Map<string, EditableLevelProjection>();
  private entities = new Map<string, ProjectedEntity>();
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
    this.levels = new Map(
      (document?.levels ?? []).map((level) => [level.levelId, editableLevel(level)]),
    );
    this.entities = new Map(
      selected.entities.map((entity) => [entity.entityId, cloneEntity(entity)]),
    );
    this.playerEntityDefinitionId = selected.playerEntityDefinitionId;
    this.preferredLevelId = selected.level?.levelId ?? preferredLevelId;
    this.activeProjectSessionId = cursor?.projectSessionId;
    this.lastCommandSequence = commandSequence;
    this.bufferedJournalEvents.clear();
    this.bufferedAcknowledgements.clear();
    this.notify();
  }

  select(levelId: string | undefined): void {
    if (levelId && this.levels.has(levelId)) this.preferredLevelId = levelId;
  }

  get snapshot(): LevelEditorStoreSnapshot {
    return {
      level:
        (this.preferredLevelId ? this.levels.get(this.preferredLevelId) : undefined) ??
        this.levels.values().next().value,
      entities: [...this.entities.values()].map(cloneEntity),
      playerEntityDefinitionId: this.playerEntityDefinitionId,
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
      case "entityMoved": {
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

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
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
  return { ...entity, position: [entity.position[0], entity.position[1]] };
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
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
  return {
    entityId: entity["entityId"],
    entityDefId: entity["entityDefId"],
    position: [position[0] as number, position[1] as number],
  };
}
