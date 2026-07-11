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

/** Documento → comandos canônicos em ordem de dependência. */
export function documentToCommands(document: BlueprintDocument): BlueprintCommand[] {
  if (document?.schemaVersion !== BLUEPRINT_DOCUMENT_VERSION) {
    throw new BlueprintDocumentError(
      `Unsupported blueprint document schemaVersion ${document?.schemaVersion} ` +
        `(this build reads version ${BLUEPRINT_DOCUMENT_VERSION})`,
    );
  }

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
