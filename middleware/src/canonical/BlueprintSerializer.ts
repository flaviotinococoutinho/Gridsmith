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

import {
  CELL_ORIGIN,
  ENTITY_ANCHOR,
  WORLD_POSITION_UNIT,
  WORLD_Y_AXIS,
  cellToWorldCenter,
} from "../leveldesign/GridCoordinates.js";
import { recognizeLegacyV2Document } from "./legacyBlueprintShapes.js";
import type {
  BlueprintCommand,
  BlueprintStore,
  CameraSettings,
  EntityDefinition,
  EntityInstance,
  LevelPaletteEntry,
  LevelSpec,
  LightSpec,
  MeshBinding,
  SkeletonBlueprint,
  WorldPlacement,
} from "../domain/BlueprintStore.js";
import type { CanonicalOrchestrator, DispatchResult } from "./CanonicalOrchestrator.js";

export const BLUEPRINT_DOCUMENT_VERSION = 4;

/**
 * Convenção espacial DECLARADA pelo documento (v3).
 *
 * Antes da v3 a unidade era um acordo tácito entre camadas — e um acordo
 * tácito foi exatamente o que permitiu ao template gravar célula onde o
 * contrato pedia pixel. Escrevendo a convenção no arquivo, qualquer leitor
 * (build futura, ferramenta externa, agente) sabe o que os números significam
 * sem precisar adivinhar pela magnitude.
 */
export interface ProjectSpatialConvention {
  readonly positionUnit: typeof WORLD_POSITION_UNIT;
  readonly cellOrigin: typeof CELL_ORIGIN;
  readonly yAxis: typeof WORLD_Y_AXIS;
  readonly entityAnchor: typeof ENTITY_ANCHOR;
}

/** Metadata de produto do projeto (v3). */
export interface ProjectMetadata {
  /** Nome exibível — o que a UI mostra em vez do `projectId`. */
  readonly name: string;
  /** Resolução de referência do projeto, em pixels. */
  readonly referenceResolution: { readonly width: number; readonly height: number };
  readonly spatial: ProjectSpatialConvention;
}

export const DEFAULT_PROJECT_SPATIAL: ProjectSpatialConvention = Object.freeze({
  positionUnit: WORLD_POSITION_UNIT,
  cellOrigin: CELL_ORIGIN,
  yAxis: WORLD_Y_AXIS,
  entityAnchor: ENTITY_ANCHOR,
});

export const DEFAULT_PROJECT_METADATA: ProjectMetadata = Object.freeze({
  name: "Projeto sem título",
  referenceResolution: Object.freeze({ width: 1280, height: 720 }),
  spatial: DEFAULT_PROJECT_SPATIAL,
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

/**
 * Snapshot declarativo completo do estado corrente do Blueprint.
 *
 * `metadata` é OBRIGATÓRIA de propósito, sem default. A metadata real vive na
 * sessão de projeto, e um default aqui seria uma armadilha silenciosa: uma
 * borda futura que exportasse documento sem passar `session.metadata`
 * compilaria, passaria nos testes e apagaria o nome escolhido pelo usuário no
 * primeiro save — perda de dado sem nenhum erro. Quem não tem sessão passa
 * `DEFAULT_PROJECT_METADATA` explicitamente, e essa explicitação é o ponto.
 *
 * `projectId` continua aceitando `undefined` (identidade legada derivada do
 * conteúdo), mas em posição obrigatória para que a escolha seja visível.
 */
export function exportBlueprint(
  store: BlueprintStore,
  projectId: string | undefined,
  metadata: ProjectMetadata,
): BlueprintDocument {
  const content = {
    schemaVersion: BLUEPRINT_DOCUMENT_VERSION,
    metadata: cloneProjectMetadata(metadata),
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
  // 2 → 3: declara a convenção espacial e a metadata de produto no próprio
  // arquivo e, SOMENTE para os documentos de origem reconhecida que estavam
  // em células, converte as posições para pixels do mundo. Ver a explicação
  // dos quatro ramos em `migrateToV3`.
  [2, migrateToV3],
  // 3 → 4: a paleta de significados deixa de ser constante de build do editor
  // e passa a ser dado do projeto.
  [3, migrateLevelPalette],
]);

/**
 * Paleta default: o mesmo vocabulário que o editor trazia hardcoded, agora
 * gravado no documento. Sem isto, abrir um projeto v3 no build v4 mostraria
 * um nível pintado com significados sem nome nem cor.
 */
const DEFAULT_PALETTE: readonly LevelPaletteEntry[] = Object.freeze([
  Object.freeze({ value: 1, name: "Chão", color: "#7a5230" }),
  Object.freeze({ value: 2, name: "Parede", color: "#5a6a7a" }),
  Object.freeze({ value: 3, name: "Perigo", color: "#b8433a" }),
]);

function migrateLevelPalette(document: Record<string, unknown>): Record<string, unknown> {
  const levels = (Array.isArray(document["levels"]) ? document["levels"] : []).map((raw) => {
    const level = raw as Record<string, unknown>;
    if (Array.isArray(level["palette"])) return level;

    const byValue = new Map<number, LevelPaletteEntry>(
      DEFAULT_PALETTE.map((entry) => [entry.value, entry]),
    );
    // Um projeto pode ter sido pintado por agente ou por edição manual com
    // valores fora da paleta do editor. Deixá-los sem entrada os tornaria
    // invisíveis na UI, então cada um ganha nome e cor DETERMINÍSTICOS.
    for (const value of Array.isArray(level["intGrid"]) ? level["intGrid"] : []) {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) continue;
      if (byValue.has(value)) continue;
      byValue.set(value, {
        value,
        name: `Significado ${value}`,
        color: deterministicPaletteColor(value),
      });
    }
    const palette = [...byValue.values()].sort((a, b) => a.value - b.value);
    return { ...level, palette };
  });

  return { ...document, levels, schemaVersion: 4 };
}

/** Cor estável por valor: o mesmo projeto sempre migra para as mesmas cores. */
function deterministicPaletteColor(value: number): string {
  const hash = Math.imul(value, 2_654_435_761) >>> 8;
  return `#${(hash & 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * Os QUATRO ramos da 2 → 3.
 *
 * (a) template de plataforma PRÉ-correção → converte posições e nomeia;
 * (b) template de plataforma PÓS-correção → só nomeia;
 * (c) template top-down → só nomeia;
 * (d) qualquer outro documento → NUNCA converte nada; recebe metadata
 *     genérica.
 *
 * O ramo (d) é o mais importante e o mais fácil de errar. É tentador
 * "detectar" coordenadas de célula pela magnitude — todo número menor que o
 * tileSize seria célula. Essa heurística destrói projeto de usuário: uma
 * entidade legitimamente em [3, 7] pixels viraria [56, 120]. Documento de
 * origem desconhecida sai da migração com as posições BIT A BIT idênticas.
 */
function migrateToV3(document: Record<string, unknown>): Record<string, unknown> {
  const declared = normalizeLegacyMetadata(document["metadata"]);
  if (declared) {
    // Documento que já traz metadata válida atravessa intacto: nada a inferir.
    return { ...document, metadata: declared, schemaVersion: 3 };
  }

  // A impressão digital compara o documento v2 INTEIRO. A partir da v4 os
  // factories e fixtures de teste que simulam v2 podem carregar `palette` —
  // um campo que não existia na v2 —, e o hash deixaria de casar: a conversão
  // de coordenadas do template pré-correção pararia de disparar EM SILÊNCIO,
  // corrompendo posições de projetos legados sem nenhum erro visível. Por
  // isso o strip entra JUNTO com a v4, não antes: antes dela seria código
  // morto impossível de testar.
  const origin = recognizeLegacyV2Document(withoutLevelPalettes(document));
  if (!origin) {
    return {
      ...document,
      metadata: { ...DEFAULT_PROJECT_METADATA, name: "Projeto importado" },
      schemaVersion: 3,
    };
  }

  const converted = origin.positionsInCells ? withWorldPixelPositions(document) : document;
  return {
    ...converted,
    metadata: { ...DEFAULT_PROJECT_METADATA, name: origin.projectName },
    schemaVersion: 3,
  };
}

/**
 * Converte as posições de célula para pixels do mundo. Só é chamada para
 * documento de origem RECONHECIDA — nunca especula.
 */
/** Remove `palette` de cada nível — só para efeito de impressão digital. */
function withoutLevelPalettes(document: Record<string, unknown>): Record<string, unknown> {
  const levels = Array.isArray(document["levels"]) ? document["levels"] : undefined;
  if (!levels?.some((raw) => (raw as Record<string, unknown>)["palette"] !== undefined)) {
    return document;
  }
  return {
    ...document,
    levels: levels.map((raw) => {
      const { palette: _ignored, ...rest } = raw as Record<string, unknown>;
      return rest;
    }),
  };
}

function withWorldPixelPositions(document: Record<string, unknown>): Record<string, unknown> {
  const tileSize = soleLevelTileSize(document);

  const entities = asArray(document["entities"]).map((raw) => {
    const entity = raw as Record<string, unknown>;
    const cell = asPair(entity["position"]);
    if (!cell) return entity;
    // Entidade vive em célula INTEIRA: cellToWorldCenter recusa fração, e essa
    // recusa é a guarda de que o documento reconhecido é mesmo o esperado.
    return { ...entity, position: [...cellToWorldCenter({ x: cell[0], y: cell[1] }, tileSize)] };
  });

  const lights = asArray(document["lights"]).map((raw) => {
    const light = raw as Record<string, unknown>;
    const cell = asPair(light["position"]);
    if (!cell) return light;
    return {
      ...light,
      position: [legacyAxisToWorld(cell[0], tileSize), legacyAxisToWorld(cell[1], tileSize)],
    };
  });

  return { ...document, entities, lights };
}

/**
 * Mesma fórmula escalar que o template corrigido usa hoje.
 *
 * ESCOLHA REGISTRADA, e ela não é óbvia: a luz do template legado foi escrita
 * em MEIA célula — `[16 / 2, 9 / 2]` = `[8, 4.5]`. `cellToWorldCenter` recusa
 * fração de propósito, então havia dois candidatos:
 *
 *   • arredondar a célula para baixo → `[136, 72]`;
 *   • aplicar a fórmula escalar do template corrigido → `[136, 80]`.
 *
 * Vale `[136, 80]`, porque é o que o template EMITE hoje: assim, abrir um
 * projeto antigo e criar um projeto novo produzem o mesmo documento, e a
 * migração não move nada de lugar. Arredondar deslocaria a luz 8 px e faria
 * projeto migrado divergir de projeto novo — uma diferença invisível no
 * código e visível na tela.
 *
 * (Nota separada: `[136, 80]` também não é o centro geométrico do nível, que
 * seria `[128, 72]`. Isso é um desvio do próprio template, anterior a esta
 * etapa e fora do escopo dela; corrigi-lo aqui moveria a luz de todo projeto
 * novo dentro de um PR de migração. Está registrado como pendência.)
 */
function legacyAxisToWorld(cellAxis: number, tileSize: number): number {
  return cellAxis * tileSize + tileSize / 2;
}

function soleLevelTileSize(document: Record<string, unknown>): number {
  const levels = asArray(document["levels"]);
  const tileSize = (levels[0] as Record<string, unknown> | undefined)?.["tileSize"];
  if (levels.length !== 1 || !Number.isInteger(tileSize) || (tileSize as number) < 1) {
    // Inalcançável pelos documentos reconhecidos (todos têm exatamente um
    // nível). Falhar alto aqui é melhor do que converter com tileSize errado.
    throw new BlueprintDocumentError(
      "Legacy coordinate migration expects exactly one level with a valid tileSize",
    );
  }
  return tileSize as number;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asPair(value: unknown): [number, number] | undefined {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number")
    ? [value[0] as number, value[1] as number]
    : undefined;
}

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
  if (!normalizeLegacyMetadata(document["metadata"])) {
    throw new BlueprintDocumentError(
      'Blueprint document requires a valid "metadata" (name, referenceResolution, spatial)',
    );
  }
}

/**
 * Aceita a metadata se ela for íntegra; devolve `undefined` para qualquer
 * coisa ausente ou malformada, para o chamador decidir (a migração deriva, a
 * validação recusa). Não CORRIGE metadata pela metade: um documento com
 * `spatial` inconsistente afirma uma convenção que talvez não seja a dos seus
 * números, e adivinhar aí é o mesmo erro que a v3 existe para eliminar.
 */
function normalizeLegacyMetadata(value: unknown): ProjectMetadata | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const metadata = value as Record<string, unknown>;

  const name = metadata["name"];
  if (typeof name !== "string" || name.trim().length === 0) return undefined;

  const resolution = metadata["referenceResolution"] as Record<string, unknown> | undefined;
  const width = resolution?.["width"];
  const height = resolution?.["height"];
  if (!isPositiveInteger(width) || !isPositiveInteger(height)) return undefined;

  const spatial = metadata["spatial"] as Record<string, unknown> | undefined;
  if (
    spatial?.["positionUnit"] !== WORLD_POSITION_UNIT ||
    spatial["cellOrigin"] !== CELL_ORIGIN ||
    spatial["yAxis"] !== WORLD_Y_AXIS ||
    spatial["entityAnchor"] !== ENTITY_ANCHOR
  ) {
    return undefined;
  }

  return Object.freeze({
    name,
    referenceResolution: Object.freeze({ width, height }),
    spatial: DEFAULT_PROJECT_SPATIAL,
  });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Cópia congelada — a metadata da sessão nunca é aliasada pelo documento. */
export function cloneProjectMetadata(metadata: ProjectMetadata): ProjectMetadata {
  const normalized = normalizeLegacyMetadata(metadata);
  if (!normalized) {
    throw new BlueprintDocumentError(
      'Invalid project metadata (name, referenceResolution, spatial)',
    );
  }
  return normalized;
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
