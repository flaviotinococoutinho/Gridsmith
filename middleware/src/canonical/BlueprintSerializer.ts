/**
 * Persistência do Blueprint (docs/GOVERNANCE.md, DoD "projeto salvável").
 *
 * O documento exportado é DECLARATIVO e versionado (`schemaVersion`) — um
 * artefato de projeto diffável em git. O load NUNCA escreve estado
 * diretamente: reconstrói a lista de comandos canônicos em ordem de
 * dependência e a REPRODUZ pelo orquestrador — mesma validação, mesmos
 * hooks, mesma projeção no runtime de qualquer edição manual.
 */

import { createHash } from "node:crypto";

import type {
  BlueprintCommand,
  BlueprintStore,
  CameraSettings,
  EntityDefinition,
  EntityInstance,
  LevelSpec,
  LevelPaletteEntry,
  LightSpec,
  MeshBinding,
  SkeletonBlueprint,
  WorldPlacement,
} from "../domain/BlueprintStore.js";
import type { CanonicalOrchestrator, DispatchResult } from "./CanonicalOrchestrator.js";
import {
  CELL_ORIGIN,
  ENTITY_ANCHOR,
  WORLD_POSITION_UNIT,
  WORLD_Y_AXIS,
  cellToWorldCenter,
} from "../leveldesign/GridCoordinates.js";

export const BLUEPRINT_DOCUMENT_VERSION = 4;

export interface ProjectMetadata {
  readonly name: string;
  readonly referenceResolution: {
    readonly width: number;
    readonly height: number;
  };
  readonly spatial: {
    readonly positionUnit: typeof WORLD_POSITION_UNIT;
    readonly cellOrigin: typeof CELL_ORIGIN;
    readonly yAxis: typeof WORLD_Y_AXIS;
    readonly entityAnchor: typeof ENTITY_ANCHOR;
  };
}

export const DEFAULT_PROJECT_METADATA: ProjectMetadata = Object.freeze({
  name: "Projeto sem título",
  referenceResolution: Object.freeze({ width: 1280, height: 720 }),
  spatial: Object.freeze({
    positionUnit: WORLD_POSITION_UNIT,
    cellOrigin: CELL_ORIGIN,
    yAxis: WORLD_Y_AXIS,
    entityAnchor: ENTITY_ANCHOR,
  }),
});

export interface BlueprintDocument {
  readonly schemaVersion: number;
  readonly projectId: string;
  readonly metadata: ProjectMetadata;
  readonly skeletons: readonly SkeletonBlueprint[];
  readonly meshes: readonly MeshBinding[];
  readonly camera: CameraSettings;
  readonly lights: readonly LightSpec[];
  readonly entityDefs: readonly EntityDefinition[];
  readonly entities: readonly EntityInstance[];
  readonly levels: readonly LevelSpec[];
  readonly placements: readonly WorldPlacement[];
}

export class BlueprintDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintDocumentError";
  }
}

/** Snapshot declarativo completo do estado corrente do Blueprint. */
export function exportBlueprint(
  store: BlueprintStore,
  projectId?: string,
  metadata: ProjectMetadata = DEFAULT_PROJECT_METADATA,
): BlueprintDocument {
  const content = {
    schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
    skeletons: store.listSkeletons(),
    meshes: store.listMeshes(),
    camera: store.cameraSettings,
    lights: store.listLights(),
    entityDefs: store.listEntityDefs(),
    entities: store.listEntities(),
    levels: store.listLevels(),
    placements: store.listPlacements(),
  };
  return {
    ...content,
    projectId: projectId ?? deriveLegacyProjectId(content),
    metadata,
  };
}

/**
 * Uma migração leva um documento da versão N para N+1. Registre uma entrada
 * sempre que `BLUEPRINT_DOCUMENT_VERSION` subir, para que projetos salvos por
 * builds anteriores continuem abrindo.
 */
export type BlueprintMigration = (document: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS = new Map<number, BlueprintMigration>([
  // 0 → 1: documentos anteriores ao campo `schemaVersion`. Normaliza a forma
  // (garante que todo domínio exista como array) e carimba a versão.
  [
    0,
    (document) => ({
      skeletons: [],
      meshes: [],
      camera: {},
      lights: [],
      entityDefs: [],
      entities: [],
      levels: [],
      placements: [],
      ...document,
      schemaVersion: 1,
    }),
  ],
  // 1 → 2: introduz identidade persistente do projeto. Para documentos
  // legados o id é derivado deterministicamente do conteúdo; ao salvar, ele
  // passa a fazer parte do documento e permanece estável.
  [
    1,
    (document) => ({
      ...document,
      projectId:
        typeof document["projectId"] === "string" && document["projectId"].length > 0
          ? document["projectId"]
          : deriveLegacyProjectId(document),
      schemaVersion: 2,
    }),
  ],
  // 2 → 3: explicita metadata de produto e, sobretudo, a unidade espacial.
  // Posições genéricas já eram projetadas em pixels do mundo; a única exceção
  // publicada (factory histórico do template) é reconhecida exatamente.
  [
    2,
    (document) => {
      const isLegacyPlatformer = isKnownLegacyPlatformerTemplate(document);
      const spatiallyNormalized = isLegacyPlatformer
        ? migrateKnownLegacyTemplateCoordinates(document)
        : document;
      return {
        ...spatiallyNormalized,
        metadata: normalizeLegacyMetadata(spatiallyNormalized, isLegacyPlatformer),
        schemaVersion: 3,
      };
    },
  ],
  // 3 → 4: a paleta deixa de ser constante local do renderer e passa a
  // pertencer a cada nível. Valores já pintados recebem entradas determinísticas.
  [
    3,
    (document) => ({
      ...document,
      levels: Array.isArray(document["levels"])
        ? document["levels"].map((level) => migrateLevelPalette(level))
        : document["levels"],
      schemaVersion: 4,
    }),
  ],
]);

/** Etapa explícita de parse; objetos já desserializados atravessam sem cópia. */
export function parseBlueprintDocument(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BlueprintDocumentError(
      `Blueprint document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Normaliza um documento (possivelmente de uma versão anterior) para a versão
 * corrente. Documentos mais NOVOS que este build são recusados com erro claro;
 * os mais antigos são migrados passo a passo pelo registro acima.
 */
export function migrateBlueprintDocument(raw: unknown): BlueprintDocument {
  if (raw === null || typeof raw !== "object") {
    throw new BlueprintDocumentError("Blueprint document must be an object");
  }

  let document = raw as Record<string, unknown>;
  const declared = document["schemaVersion"];
  let version = typeof declared === "number" && Number.isInteger(declared) ? declared : 0;

  if (version > BLUEPRINT_DOCUMENT_VERSION) {
    throw new BlueprintDocumentError(
      `Unsupported blueprint document schemaVersion ${version} ` +
        `(this build reads version ${BLUEPRINT_DOCUMENT_VERSION}; update the app to open it)`,
    );
  }

  while (version < BLUEPRINT_DOCUMENT_VERSION) {
    const migrate = MIGRATIONS.get(version);
    if (!migrate) {
      throw new BlueprintDocumentError(
        `No migration path from blueprint schemaVersion ${version} to ${BLUEPRINT_DOCUMENT_VERSION}`,
      );
    }
    document = migrate(document);
    version += 1;
  }

  validateBlueprintDocumentShape(document);
  return document as unknown as BlueprintDocument;
}

/** Validação estrutural anterior ao replay; regras semânticas ficam no store. */
export function validateBlueprintDocumentShape(document: Record<string, unknown>): void {
  if (typeof document["projectId"] !== "string" || document["projectId"].trim().length === 0) {
    throw new BlueprintDocumentError('Blueprint document requires a non-empty "projectId"');
  }
  for (const field of [
    "skeletons",
    "meshes",
    "lights",
    "entityDefs",
    "entities",
    "levels",
    "placements",
  ] as const) {
    if (!Array.isArray(document[field])) {
      throw new BlueprintDocumentError(`Blueprint document field "${field}" must be an array`);
    }
  }
  const camera = document["camera"];
  if (camera === null || typeof camera !== "object" || Array.isArray(camera)) {
    throw new BlueprintDocumentError('Blueprint document field "camera" must be an object');
  }
  validateProjectMetadata(document["metadata"]);
}

/**
 * Documento → comandos canônicos em ordem de dependência. Aceita documentos de
 * versões anteriores (migrados de forma transparente) e recusa versões futuras.
 */
export function documentToCommands(rawDocument: unknown): BlueprintCommand[] {
  const document = migrateBlueprintDocument(rawDocument);

  const commands: BlueprintCommand[] = [];
  for (const skeleton of document.skeletons ?? []) commands.push({ kind: "skeleton/define", skeleton });
  for (const binding of document.meshes ?? []) commands.push({ kind: "mesh/bind", binding });
  if (document.camera && Object.keys(document.camera).length > 0) {
    commands.push({ kind: "camera/configure", settings: document.camera });
  }
  for (const light of document.lights ?? []) commands.push({ kind: "light/add", light });
  for (const definition of document.entityDefs ?? []) commands.push({ kind: "entitydef/define", definition });
  for (const entity of document.entities ?? []) commands.push({ kind: "entity/place", entity });
  for (const level of document.levels ?? []) commands.push({ kind: "level/define", level });
  for (const placement of document.placements ?? []) commands.push({ kind: "world/place", placement });
  return commands;
}

export interface ReplaySummary {
  readonly applied: number;
  readonly projected: number;
  readonly deferred: number;
  readonly skipped: number;
}

/**
 * Reproduz um documento pelo caminho canônico no store fornecido. A garantia
 * de substituição vem do ProjectSessionManager: o caller prepara um store
 * temporário e nunca usa o store da sessão ativa como alvo.
 */
export async function replayDocument(
  document: BlueprintDocument,
  store: BlueprintStore,
  orchestrator: CanonicalOrchestrator,
): Promise<ReplaySummary> {
  const results: DispatchResult[] = [];
  for (const command of documentToCommands(document)) {
    results.push(await orchestrator.dispatch(command, { mode: "prepare" }));
  }

  const byStatus = (status: string): number =>
    results.filter((r) => r.projection?.status === status).length;
  return {
    applied: results.length,
    projected: byStatus("projected"),
    deferred: byStatus("deferred"),
    skipped: byStatus("skipped"),
  };
}

function deriveLegacyProjectId(document: unknown): string {
  const digest = createHash("sha256").update(stableJson(document)).digest("hex").slice(0, 24);
  return `legacy-${digest}`;
}

function normalizeLegacyMetadata(
  document: Record<string, unknown>,
  isLegacyPlatformer = false,
): ProjectMetadata {
  const legacy = document["metadata"];
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    try {
      validateProjectMetadata(legacy);
      return legacy as ProjectMetadata;
    } catch {
      // v2 nunca declarou esta estrutura; campos parciais não são confiáveis.
    }
  }
  const projectId = typeof document["projectId"] === "string" ? document["projectId"] : "";
  return Object.freeze({
    name:
      isLegacyPlatformer || projectId === "template-platformer-2d"
        ? "Plataforma 2D"
        : "Projeto importado",
    // V2 não possuía resolução de referência. Dimensão do grid × tile size é
    // tamanho do nível, não resolução de viewport; inferi-la mudaria intenção.
    referenceResolution: DEFAULT_PROJECT_METADATA.referenceResolution,
    spatial: DEFAULT_PROJECT_METADATA.spatial,
  });
}

function migrateLevelPalette(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (Array.isArray(value["palette"])) return value;
  // O renderer v3 oferecia estes três significados para TODO nível, mesmo
  // quando ainda não apareciam no IntGrid. Preservá-los evita que migrar um
  // documento parcialmente pintado remova ferramentas que o usuário tinha.
  // Valores customizados já usados também ganham uma entrada determinística.
  const used = new Set<number>([1, 2, 3]);
  if (Array.isArray(value["intGrid"])) {
    for (const cell of value["intGrid"]) {
      if (typeof cell === "number" && Number.isInteger(cell) && cell > 0 && cell <= 32767) used.add(cell);
    }
  }
  const palette = [...used].sort((a, b) => a - b).map(defaultPaletteEntry);
  return { ...value, palette };
}

function defaultPaletteEntry(value: number): LevelPaletteEntry {
  if (value === 1) return { value, name: "Chão", color: "#7a5230" };
  if (value === 2) return { value, name: "Parede", color: "#5a6a7a" };
  if (value === 3) return { value, name: "Perigo", color: "#b8433a" };
  // Cor determinística e suficientemente distinta para documentos legados.
  const rgb = (Math.imul(value, 2654435761) >>> 8) & 0xffffff;
  return { value, name: `Valor ${value}`, color: `#${rgb.toString(16).padStart(6, "0")}` };
}

/**
 * O único documento v2 publicado pelo repositório com coordenadas em célula
 * foi o factory inicial de Plataforma 2D. O fluxo histórico substituía seu
 * `projectId` fixo por um UUID, por isso a identificação usa a forma completa
 * publicada (exceto projectId), não o ID. Posições/documentos editados ficam
 * fora da impressão digital e permanecem numericamente intactos.
 */
function isKnownLegacyPlatformerTemplate(document: Record<string, unknown>): boolean {
  // Fixtures/factories correntes podem carregar `palette` ao simular v2; o
  // campo não existia no wire v2 e não participa da impressão histórica.
  return LEGACY_PLATFORMER_V2_FINGERPRINTS.has(stableJson(withoutLevelPalettes(document)));
}

function withoutLevelPalettes(document: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(document["levels"])) return document;
  return {
    ...document,
    levels: document["levels"].map((level) => {
      if (!isRecord(level)) return level;
      const { palette: _palette, ...legacy } = level;
      return legacy;
    }),
  };
}

function migrateKnownLegacyTemplateCoordinates(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const levels = Array.isArray(document["levels"])
    ? document["levels"] as Array<Record<string, unknown>>
    : [];
  const level = levels.find((candidate) => candidate["levelId"] === "level-1");
  const tileSize = positiveInteger(level?.["tileSize"]);
  if (!tileSize || level?.["width"] !== 16 || level["height"] !== 9) return document;

  const entities = Array.isArray(document["entities"])
    ? (document["entities"] as unknown[]).map((value) => {
        if (!isRecord(value)) return value;
        if (
          value["entityId"] === "player-1" &&
          value["entityDefId"] === "player" &&
          tupleEquals(value["position"], 2, 7)
        ) {
          return { ...value, position: cellToWorldCenter({ x: 2, y: 7 }, tileSize) };
        }
        return value;
      })
    : document["entities"];
  const lights = Array.isArray(document["lights"])
    ? (document["lights"] as unknown[]).map((value) => {
        if (!isRecord(value)) return value;
        if (value["lightId"] === "key-light" && tupleEquals(value["position"], 8, 4.5)) {
          return { ...value, position: cellToWorldCenter({ x: 8, y: 4 }, tileSize) };
        }
        return value;
      })
    : document["lights"];
  return { ...document, entities, lights };
}

const LEGACY_PLATFORMER_V2_FINGERPRINTS = new Set([
  // Factory cru, antes do replay.
  stableJson(legacyPlatformerV2Shape({})),
  // Documento realmente exportado pelo store histórico: defaults da
  // definição já materializados na instância durante o replay.
  stableJson(legacyPlatformerV2Shape({ speed: 90, jumpVelocity: 320 })),
]);

function legacyPlatformerV2Shape(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 2,
    projectId: "ignored-by-stable-json",
    skeletons: [],
    meshes: [],
    camera: { frequency: 2, damping: 1, response: 2, anticipationSeconds: 0.15 },
    lights: [{
      lightId: "key-light",
      type: "point",
      position: [8, 4.5],
      height: 1,
      color: [1, 1, 1],
      intensity: 1.2,
      radius: 240,
    }],
    entityDefs: [{
      entityDefId: "player",
      archetypeId: "player",
      tags: ["player"],
      editor: { color: "#3aa0ff" },
      fields: [
        { name: "speed", type: "float", default: 90 },
        { name: "jumpVelocity", type: "float", default: 320 },
      ],
    }],
    entities: [{
      entityId: "player-1",
      entityDefId: "player",
      position: [2, 7],
      fields,
    }],
    levels: [{
      levelId: "level-1",
      width: 16,
      height: 9,
      tileSize: 16,
      seed: 1,
      intGrid: legacyPlatformerIntGrid(),
      rules: [{ patternSize: 1, pattern: [1], tileIds: [1] }],
    }],
    placements: [{ levelId: "level-1", x: 0, y: 0 }],
  };
}

function legacyPlatformerIntGrid(): number[] {
  const grid = new Array<number>(16 * 9).fill(0);
  for (let x = 0; x < 16; x += 1) grid[(9 - 1) * 16 + x] = 1;
  for (let y = 0; y < 9; y += 1) {
    grid[y * 16] = 1;
    grid[y * 16 + 15] = 1;
  }
  return grid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tupleEquals(value: unknown, x: number, y: number): boolean {
  return Array.isArray(value) && value.length === 2 && value[0] === x && value[1] === y;
}

export function validateProjectMetadata(value: unknown): asserts value is ProjectMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BlueprintDocumentError('Blueprint document field "metadata" must be an object');
  }
  const metadata = value as Record<string, unknown>;
  if (typeof metadata["name"] !== "string" || metadata["name"].trim().length === 0) {
    throw new BlueprintDocumentError('Blueprint metadata requires a non-empty "name"');
  }
  const resolution = metadata["referenceResolution"] as Record<string, unknown> | undefined;
  if (
    !resolution ||
    !positiveInteger(resolution["width"]) ||
    !positiveInteger(resolution["height"])
  ) {
    throw new BlueprintDocumentError(
      'Blueprint metadata "referenceResolution" requires positive integer width/height',
    );
  }
  const spatial = metadata["spatial"] as Record<string, unknown> | undefined;
  if (
    !spatial ||
    spatial["positionUnit"] !== WORLD_POSITION_UNIT ||
    spatial["cellOrigin"] !== CELL_ORIGIN ||
    spatial["yAxis"] !== WORLD_Y_AXIS ||
    spatial["entityAnchor"] !== ENTITY_ANCHOR
  ) {
    throw new BlueprintDocumentError(
      'Blueprint metadata "spatial" must declare world-pixel/top-left/down/center',
    );
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => key !== "projectId")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
