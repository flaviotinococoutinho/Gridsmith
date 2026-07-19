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

/** Snapshot completo e coerente de todas as projeções nomeadas do editor. */
export type CompleteProjectionSnapshot = Readonly<
  Record<QueryableProjection, Record<string, unknown>>
>;

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

interface InFlightDispatch {
  readonly fingerprint: string;
  readonly promise: Promise<DispatchResult>;
}

interface CompletedDispatch {
  readonly fingerprint: string;
  readonly outcome:
    | { readonly ok: true; readonly value: DispatchResult }
    | { readonly ok: false; readonly error: unknown };
}

const MAX_IN_FLIGHT_DISPATCHES = 1_024;
const MAX_COMPLETED_DISPATCHES = 1_024;

export class EditorSurface {
  private readonly inFlightDispatches = new Map<string, InFlightDispatch>();
  private readonly completedDispatches = new Map<string, CompletedDispatch>();

  constructor(private readonly options: EditorSurfaceOptions) {}

  /** Dispatch canônico a partir do par transportável (kind, payload). */
  async dispatchByKind(
    kind: string,
    payload: unknown,
    requestId?: string,
  ): Promise<DispatchResult> {
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
    if (requestId === undefined) return this.options.orchestrator.dispatch(command);
    if (
      typeof requestId !== "string" ||
      requestId.trim().length === 0 ||
      requestId.length > 128
    ) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"requestId" must be a non-empty string with at most 128 characters`,
      );
    }

    const fingerprint = stableJson(command);
    const completed = this.completedDispatches.get(requestId);
    if (completed) {
      this.assertSameRequest(requestId, completed.fingerprint, fingerprint);
      // Reinsere para manter uma LRU simples e deterministicamente limitada.
      this.completedDispatches.delete(requestId);
      this.completedDispatches.set(requestId, completed);
      if (completed.outcome.ok) return completed.outcome.value;
      throw completed.outcome.error;
    }
    const inFlight = this.inFlightDispatches.get(requestId);
    if (inFlight) {
      this.assertSameRequest(requestId, inFlight.fingerprint, fingerprint);
      return inFlight.promise;
    }
    if (this.inFlightDispatches.size >= MAX_IN_FLIGHT_DISPATCHES) {
      throw new JsonRpcError(
        RpcErrorCode.InternalError,
        `Too many in-flight idempotent dispatches`,
      );
    }

    const promise = this.options.orchestrator.dispatch(command);
    this.inFlightDispatches.set(requestId, { fingerprint, promise });
    void promise.then(
      (value) => this.completeDispatch(requestId, fingerprint, { ok: true, value }),
      (error: unknown) => this.completeDispatch(requestId, fingerprint, { ok: false, error }),
    );
    return promise;
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

  /**
   * Captura todas as projeções sem `await`. No event loop do Node isso forma um
   * ponto de leitura atômico; a borda carimba o cursor do journal logo depois,
   * ainda no mesmo turno síncrono.
   */
  snapshot(): CompleteProjectionSnapshot {
    return Object.freeze(
      Object.fromEntries(
        QUERYABLE_PROJECTIONS.map((projection) => [projection, this.query(projection)]),
      ) as Record<QueryableProjection, Record<string, unknown>>,
    );
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

  private assertSameRequest(requestId: string, expected: string, actual: string): void {
    if (expected !== actual) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `requestId "${requestId}" was already used for a different command`,
      );
    }
  }

  private completeDispatch(
    requestId: string,
    fingerprint: string,
    outcome: CompletedDispatch["outcome"],
  ): void {
    const current = this.inFlightDispatches.get(requestId);
    if (!current || current.fingerprint !== fingerprint) return;
    this.inFlightDispatches.delete(requestId);
    this.completedDispatches.set(requestId, { fingerprint, outcome });
    while (this.completedDispatches.size > MAX_COMPLETED_DISPATCHES) {
      const oldest = this.completedDispatches.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completedDispatches.delete(oldest);
    }
  }
}

/** JSON canônico suficiente para detectar reutilização indevida de requestId. */
function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  }
  if (typeof value === "undefined") return "null";
  if (typeof value !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `command payload must not be cyclic`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
