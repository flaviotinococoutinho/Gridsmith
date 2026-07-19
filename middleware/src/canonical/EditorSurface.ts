/**
 * Superfície de aplicação do editor, TRANSPORT-NEUTRA.
 *
 * As três bordas do app (gateway JSON-RPC, GraphQL e gRPC) e o MCP expõem o
 * MESMO conjunto de operações; esta classe é o único lugar onde essa
 * superfície existe — as bordas ficam fachadas finas de serialização
 * (princípio P-1: toda mutação passa pelo orquestrador; nenhuma borda
 * duplica fluxo).
 *
 * Erros saem como JsonRpcError (código estável): cada transporte traduz para
 * sua própria convenção (erro JSON-RPC, GraphQLError, status gRPC).
 */

import {
  BlueprintDocumentError,
  exportBlueprint,
  replayDocument,
  type BlueprintDocument,
  type ReplaySummary,
} from "./BlueprintSerializer.js";
import { getProjectTemplate, PROJECT_TEMPLATES } from "./ProjectTemplates.js";
import { CanonicalOrchestrator, type DispatchResult } from "./CanonicalOrchestrator.js";
import { COMMAND_KINDS, reshapeCommand } from "./commandShape.js";
import type { BlueprintCommand, BlueprintStore } from "../domain/BlueprintStore.js";
import type { ExperienceGovernor, ResolvedExperience } from "../runtime/ExperienceGovernor.js";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.js";
import { JsonRpcError, RpcErrorCode } from "../protocol/jsonrpc.js";

export const QUERYABLE_PROJECTIONS = [
  "skeletons",
  "meshes",
  "lights",
  "entityDefs",
  "entities",
  "camera",
  "levels",
  "world",
  "document",
] as const;

export type QueryableProjection = (typeof QUERYABLE_PROJECTIONS)[number];

export interface ProjectTemplateInfo {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface EditorSurfaceOptions {
  orchestrator: CanonicalOrchestrator;
  store: BlueprintStore;
  governor: ExperienceGovernor;
  adapter: RuntimeAdapter;
}

export class EditorSurface {
  constructor(private readonly options: EditorSurfaceOptions) {}

  /** Dispatch canônico a partir do par transportável (kind, payload). */
  async dispatchByKind(kind: string, payload: unknown): Promise<DispatchResult> {
    if (
      typeof kind !== "string" ||
      !(COMMAND_KINDS as readonly string[]).includes(kind) ||
      typeof payload !== "object" ||
      payload === null
    ) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"kind" must be one of [${COMMAND_KINDS.join(", ")}] and "payload" an object`,
      );
    }
    const command = reshapeCommand(
      kind as BlueprintCommand["kind"],
      payload as Record<string, unknown>,
    );
    return this.options.orchestrator.dispatch(command);
  }

  /** Projeções de leitura do Blueprint (shape idêntico entre transports). */
  query(projection: string): Record<string, unknown> {
    const store = this.options.store;
    switch (projection as QueryableProjection) {
      case "skeletons":
        return { skeletons: store.listSkeletons() };
      case "meshes":
        return { meshes: store.listMeshes() };
      case "lights":
        return { lights: store.listLights() };
      case "entityDefs":
        return { entityDefs: store.listEntityDefs() };
      case "entities":
        return { entities: store.listEntities() };
      case "camera":
        return { camera: store.cameraSettings };
      case "levels":
        return { levels: store.listLevels() };
      case "world": {
        const placements = store.listPlacements();
        return {
          placements,
          neighbors: Object.fromEntries(
            placements.map((p) => [p.levelId, store.neighborsOf(p.levelId)]),
          ),
        };
      }
      case "document":
        return { document: exportBlueprint(store) };
      default:
        throw new JsonRpcError(
          RpcErrorCode.InvalidParams,
          `"projection" must be one of [${QUERYABLE_PROJECTIONS.join(", ")}]`,
        );
    }
  }

  /** Replay canônico de um documento salvo (exige Blueprint vazio). */
  async loadDocument(document: unknown): Promise<ReplaySummary> {
    if (typeof document !== "object" || document === null) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"document" must be a blueprint document object`,
      );
    }
    try {
      return await replayDocument(
        document as BlueprintDocument,
        this.options.store,
        this.options.orchestrator,
      );
    } catch (err) {
      if (err instanceof BlueprintDocumentError) {
        throw new JsonRpcError(RpcErrorCode.InvalidParams, err.message);
      }
      throw err;
    }
  }

  listTemplates(): readonly ProjectTemplateInfo[] {
    return PROJECT_TEMPLATES.map((template) => ({
      id: template.id,
      label: template.label,
      description: template.description,
    }));
  }

  async newProjectFromTemplate(
    templateId: unknown,
  ): Promise<ReplaySummary & { templateId: string; name: string }> {
    if (typeof templateId !== "string" || templateId.length === 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"templateId" must be a non-empty string`);
    }
    const template = getProjectTemplate(templateId);
    if (!template) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Unknown project template "${templateId}"`);
    }
    try {
      const summary = await replayDocument(
        template.create(),
        this.options.store,
        this.options.orchestrator,
      );
      return { templateId: template.id, name: template.label, ...summary };
    } catch (err) {
      if (err instanceof BlueprintDocumentError) {
        throw new JsonRpcError(RpcErrorCode.InvalidParams, err.message);
      }
      throw err;
    }
  }

  resolveExperience(family?: string, version?: string): ResolvedExperience {
    const identity = this.options.adapter.identify();
    return this.options.governor.resolve(
      family ?? identity?.family ?? this.options.adapter.family,
      version ?? identity?.version ?? "999.0.0",
    );
  }

  get isEngineConnected(): boolean {
    return this.options.adapter.isConnected;
  }
}
