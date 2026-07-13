/**
 * Persistência do Blueprint (docs/GOVERNANCE.md, DoD "projeto salvável").
 *
 * O documento exportado é DECLARATIVO e versionado (`schemaVersion`) — um
 * artefato de projeto diffável em git. O load NUNCA escreve estado
 * diretamente: reconstrói a lista de comandos canônicos em ordem de
 * dependência e a REPRODUZ pelo orquestrador — mesma validação, mesmos
 * hooks, mesma projeção no runtime de qualquer edição manual.
 */

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

export const BLUEPRINT_DOCUMENT_VERSION = 1;

export interface BlueprintDocument {
  readonly schemaVersion: number;
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
export function exportBlueprint(store: BlueprintStore): BlueprintDocument {
  return {
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
]);

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

  return document as unknown as BlueprintDocument;
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
 * Reproduz um documento pelo caminho canônico. O Blueprint alvo deve estar
 * VAZIO — carregar sobre um projeto aberto produziria colisões de id
 * silenciosas; "novo projeto" é um estado explícito.
 */
export async function replayDocument(
  document: BlueprintDocument,
  store: BlueprintStore,
  orchestrator: CanonicalOrchestrator,
): Promise<ReplaySummary> {
  if (!store.isEmpty) {
    throw new BlueprintDocumentError("Blueprint must be empty before loading a document");
  }

  const results: DispatchResult[] = [];
  for (const command of documentToCommands(document)) {
    results.push(await orchestrator.dispatch(command));
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
