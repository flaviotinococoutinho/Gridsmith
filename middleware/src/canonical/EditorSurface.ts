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
  type ReplaySummary,
} from "./BlueprintSerializer.js";
import { getProjectTemplate, PROJECT_TEMPLATES } from "./ProjectTemplates.js";
import type { DispatchResult, HistoryDispatchResult } from "./CanonicalOrchestrator.js";

// As bordas de transporte só podem importar a SUPERFÍCIE (regra R12), então os
// tipos que elas serializam são reexportados por aqui em vez de obrigá-las a
// alcançar o orquestrador.
export type { DispatchResult, HistoryDispatchResult } from "./CanonicalOrchestrator.js";
export type { HistoryStatus, HistoryEntrySummary } from "./CommandHistory.js";
import {
  ProjectNotOpenError,
  ProjectSessionConflictError,
  type ProjectActivationResult,
  type ProjectSessionManager,
  type ProjectStatus,
  type SessionDispatchResult,
} from "./ProjectSessionManager.js";
import { COMMAND_KINDS, reshapeCommand } from "./commandShape.js";
import {
  HistoryBarrierError,
  HistoryConflictError,
  HistoryUnavailableError,
  type HistoryStatus,
} from "./CommandHistory.js";
import type { BlueprintCommand, CommandActor } from "../domain/BlueprintStore.js";
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

export interface EditorSnapshot {
  readonly projections: CompleteProjectionSnapshot;
  readonly status: ProjectStatus;
}

export interface ProjectTemplateInfo {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface EditorSurfaceOptions {
  sessions: ProjectSessionManager;
  governor: ExperienceGovernor;
  adapter: RuntimeAdapter;
}

interface InFlightDispatch {
  readonly projectSessionId: string;
  readonly fingerprint: string;
  readonly promise: Promise<DispatchResult>;
}

interface CompletedDispatch {
  readonly projectSessionId: string;
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

  /**
   * Dispatch canônico a partir do par transportável (kind, payload).
   *
   * `actor` é a PROVENIÊNCIA, decidida pela borda e nunca pelo payload. O
   * default é "human" porque as bordas do app (JSON-RPC, GraphQL, gRPC)
   * servem a UI; a fachada MCP passa "agent" explicitamente. Uma borda futura
   * com informação melhor (um runner de pipeline, por exemplo) passa a sua.
   */
  async dispatchByKind(
    kind: string,
    payload: unknown,
    requestId?: string,
    actor: CommandActor = "human",
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
    const projectSessionId = this.readCurrentSession()?.sessionId;
    if (!projectSessionId) {
      throw new JsonRpcError(RpcErrorCode.ProjectNotOpen, "No project session is active");
    }
    if (requestId === undefined) {
      return this.dispatchInSession(command, projectSessionId, actor);
    }
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
      this.assertSameProjectSession(requestId, completed.projectSessionId, projectSessionId);
      this.assertSameRequest(requestId, completed.fingerprint, fingerprint);
      // Reinsere para manter uma LRU simples e deterministicamente limitada.
      this.completedDispatches.delete(requestId);
      this.completedDispatches.set(requestId, completed);
      if (completed.outcome.ok) return completed.outcome.value;
      throw completed.outcome.error;
    }
    const inFlight = this.inFlightDispatches.get(requestId);
    if (inFlight) {
      this.assertSameProjectSession(requestId, inFlight.projectSessionId, projectSessionId);
      this.assertSameRequest(requestId, inFlight.fingerprint, fingerprint);
      return inFlight.promise;
    }
    if (this.inFlightDispatches.size >= MAX_IN_FLIGHT_DISPATCHES) {
      throw new JsonRpcError(
        RpcErrorCode.InternalError,
        `Too many in-flight idempotent dispatches`,
      );
    }

    const promise = this.dispatchInSession(command, projectSessionId, actor);
    this.inFlightDispatches.set(requestId, { projectSessionId, fingerprint, promise });
    void promise.then(
      (value) => this.completeDispatch(
        requestId,
        projectSessionId,
        fingerprint,
        { ok: true, value },
      ),
      (error: unknown) => this.completeDispatch(
        requestId,
        projectSessionId,
        fingerprint,
        { ok: false, error },
      ),
    );
    return promise;
  }

  /** Projeções de leitura do Blueprint (shape idêntico entre transports). */
  query(projection: string): Record<string, unknown> {
    const session = this.readCurrentSession();
    if (!session) {
      throw new JsonRpcError(RpcErrorCode.ProjectNotOpen, "No project session is active");
    }
    const store = session.store;
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
        // metadata da SESSÃO, não a default: é o que faz o nome do projeto
        // sobreviver ao ciclo abrir → editar → salvar
        return { document: exportBlueprint(store, session.projectId, session.metadata) };
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
  snapshot(): EditorSnapshot {
    const session = this.readCurrentSession();
    const projections = !session
      ? emptyProjectionSnapshot()
      : Object.freeze(
          Object.fromEntries(
            QUERYABLE_PROJECTIONS.map((projection) => [projection, this.query(projection)]),
          ) as Record<QueryableProjection, Record<string, unknown>>,
        );
    return Object.freeze({ projections, status: this.projectStatus() });
  }

  projectStatus(): ProjectStatus {
    // A identidade/progresso precisa pertencer ao mesmo ponto observável das
    // projeções e do journal; durante commit/staging o caller deve tentar de novo.
    this.readCurrentSession();
    return this.options.sessions.status;
  }

  /** Estado do histórico para a aba Histórico e para os botões de desfazer. */
  historyStatus(limit?: unknown): Promise<HistoryStatus> {
    const normalized = limit === undefined ? 50 : limit;
    if (typeof normalized !== "number" || !Number.isInteger(normalized) || normalized < 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"limit" must be a non-negative integer`);
    }
    return this.runHistory(() => this.options.sessions.historyStatus(normalized));
  }

  /**
   * `historyCursor` é o compare-and-swap do desfazer: o cliente manda o cursor
   * que viu, e se outro cliente editou nesse meio-tempo o pedido é recusado em
   * vez de desfazer uma ação que o usuário nem sabe que existe.
   */
  undo(expectedHistoryCursor?: unknown, expectedProjectSessionId?: unknown): Promise<HistoryDispatchResult> {
    return this.runHistory(() =>
      this.options.sessions.historyUndo(
        optionalId(expectedHistoryCursor, "historyCursor"),
        optionalId(expectedProjectSessionId, "expectedProjectSessionId"),
      ),
    );
  }

  redo(expectedHistoryCursor?: unknown, expectedProjectSessionId?: unknown): Promise<HistoryDispatchResult> {
    return this.runHistory(() =>
      this.options.sessions.historyRedo(
        optionalId(expectedHistoryCursor, "historyCursor"),
        optionalId(expectedProjectSessionId, "expectedProjectSessionId"),
      ),
    );
  }

  private async runHistory<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.toApplicationError(error);
    }
  }

  async projectCreate(
    projectId?: unknown,
    templateId?: unknown,
    expectedProjectSessionId?: unknown,
  ): Promise<ProjectActivationResult> {
    if (projectId !== undefined && (typeof projectId !== "string" || projectId.length === 0)) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"projectId" must be a non-empty string`);
    }
    if (templateId !== undefined && (typeof templateId !== "string" || templateId.length === 0)) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"templateId" must be a non-empty string`);
    }
    this.validateExpectedSessionId(expectedProjectSessionId);
    try {
      const prepared = templateId
        ? await this.options.sessions.createFromTemplate(templateId as string, projectId as string | undefined)
        : this.options.sessions.createEmptySession(projectId as string | undefined);
      return await this.options.sessions.replaceAtomically(
        prepared,
        expectedProjectSessionId as string | undefined,
      );
    } catch (error) {
      throw this.toApplicationError(error);
    }
  }

  async projectOpenDocument(
    document: unknown,
    expectedProjectSessionId?: unknown,
  ): Promise<ProjectActivationResult> {
    if ((typeof document !== "object" || document === null) && typeof document !== "string") {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"document" must be a blueprint document object or JSON string`,
      );
    }
    this.validateExpectedSessionId(expectedProjectSessionId);
    try {
      const prepared = await this.options.sessions.prepareFromDocument(document);
      return await this.options.sessions.replaceAtomically(
        prepared,
        expectedProjectSessionId as string | undefined,
      );
    } catch (error) {
      throw this.toApplicationError(error);
    }
  }

  async projectClose(expectedProjectSessionId?: unknown): Promise<ProjectStatus> {
    if (
      expectedProjectSessionId !== undefined &&
      (typeof expectedProjectSessionId !== "string" || expectedProjectSessionId.length === 0)
    ) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"expectedProjectSessionId" must be a non-empty string`,
      );
    }
    try {
      return await this.options.sessions.close(expectedProjectSessionId as string | undefined);
    } catch (error) {
      throw this.toApplicationError(error);
    }
  }

  /** Alias compatível; a implementação agora é transacional e substitui A por B. */
  async loadDocument(document: unknown, expectedProjectSessionId?: unknown): Promise<ReplaySummary> {
    return (await this.projectOpenDocument(document, expectedProjectSessionId)).summary;
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
    expectedProjectSessionId?: unknown,
  ): Promise<ReplaySummary & { templateId: string; name: string }> {
    if (typeof templateId !== "string" || templateId.length === 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"templateId" must be a non-empty string`);
    }
    const template = getProjectTemplate(templateId);
    if (!template) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Unknown project template "${templateId}"`);
    }
    const activation = await this.projectCreate(undefined, template.id, expectedProjectSessionId);
    return { templateId: template.id, name: template.label, ...activation.summary };
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

  private async dispatchInSession(
    command: BlueprintCommand,
    projectSessionId: string,
    actor: CommandActor,
  ): Promise<SessionDispatchResult> {
    try {
      return await this.options.sessions.dispatch(command, projectSessionId, actor);
    } catch (error) {
      throw this.toApplicationError(error);
    }
  }

  private readCurrentSession() {
    try {
      return this.options.sessions.readCurrent();
    } catch (error) {
      throw this.toApplicationError(error);
    }
  }

  private validateExpectedSessionId(value: unknown): void {
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `"expectedProjectSessionId" must be a non-empty string`,
      );
    }
  }

  private toApplicationError(error: unknown): unknown {
    if (error instanceof BlueprintDocumentError) {
      return new JsonRpcError(RpcErrorCode.InvalidParams, error.message);
    }
    if (error instanceof ProjectNotOpenError) {
      return new JsonRpcError(RpcErrorCode.ProjectNotOpen, error.message);
    }
    if (error instanceof ProjectSessionConflictError) {
      return new JsonRpcError(RpcErrorCode.ProjectSessionConflict, error.message);
    }
    // Conflito e barreira de histórico são estados de negócio previstos, não
    // falhas internas: cada um vira um código estável que a UI sabe traduzir
    // ("outra pessoa editou" × "não há mais o que desfazer").
    if (error instanceof HistoryConflictError) {
      return new JsonRpcError(RpcErrorCode.ProjectSessionConflict, error.message);
    }
    if (error instanceof HistoryBarrierError || error instanceof HistoryUnavailableError) {
      return new JsonRpcError(RpcErrorCode.InvalidParams, error.message);
    }
    return error;
  }

  private assertSameRequest(requestId: string, expected: string, actual: string): void {
    if (expected !== actual) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `requestId "${requestId}" was already used for a different command`,
      );
    }
  }

  private assertSameProjectSession(
    requestId: string,
    expected: string,
    actual: string,
  ): void {
    if (expected !== actual) {
      throw new JsonRpcError(
        RpcErrorCode.ProjectSessionConflict,
        `requestId "${requestId}" belongs to project session ${expected}; ` +
          `the active session is ${actual}`,
      );
    }
  }

  private completeDispatch(
    requestId: string,
    projectSessionId: string,
    fingerprint: string,
    outcome: CompletedDispatch["outcome"],
  ): void {
    const current = this.inFlightDispatches.get(requestId);
    if (
      !current ||
      current.projectSessionId !== projectSessionId ||
      current.fingerprint !== fingerprint
    ) return;
    this.inFlightDispatches.delete(requestId);
    this.completedDispatches.set(requestId, { projectSessionId, fingerprint, outcome });
    while (this.completedDispatches.size > MAX_COMPLETED_DISPATCHES) {
      const oldest = this.completedDispatches.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completedDispatches.delete(oldest);
    }
  }
}

function emptyProjectionSnapshot(): CompleteProjectionSnapshot {
  return Object.freeze({
    skeletons: { skeletons: [] },
    meshes: { meshes: [] },
    lights: { lights: [] },
    entityDefs: { entityDefs: [] },
    entities: { entities: [] },
    camera: { camera: {} },
    levels: { levels: [] },
    world: { placements: [], neighbors: {} },
    document: { document: null },
  });
}

/** JSON canônico suficiente para detectar reutilização indevida de requestId. */
/** Id opcional vindo do fio: string não vazia, ou ausente. */
function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"${field}" must be a non-empty string`);
  }
  return value;
}

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
