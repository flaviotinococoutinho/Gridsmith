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
  LightSpec,
  MeshBinding,
  SkeletonBlueprint,
  WorldPlacement,
} from "../domain/BlueprintStore.js";
import type { CanonicalOrchestrator, DispatchResult } from "./CanonicalOrchestrator.js";

export const BLUEPRINT_DOCUMENT_VERSION = 2;

export interface BlueprintDocument {
  readonly schemaVersion: number;
  readonly projectId: string;
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
export function exportBlueprint(store: BlueprintStore, projectId?: string): BlueprintDocument {
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
