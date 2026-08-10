/**
 * Gateway GraphQL do editor — transporte de FALLBACK do app (ADR-016).
 *
 * Fachada fina: o SDL vem de contracts/graphql/editor.schema.graphql (copiado
 * para dist/ no build; paridade garantida por teste) e todo campo resolve na
 * EditorSurface — nenhuma lógica de domínio aqui (mesma regra do MCP, R1).
 *
 * Transporte: HTTP/1.1 sobre Unix Domain Socket (POSIX) ou 127.0.0.1
 * (Windows), POST /graphql {query, variables}. Eventos por polling
 * incremental (eventsSince) sobre o EventJournal — streaming pertence ao gRPC.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSchema, graphql, type GraphQLSchema } from "graphql";
import type { EditorSurface, HistoryDispatchResult } from "../canonical/EditorSurface.js";
import type {
  EventEnvelope,
  EnvelopeProjection,
  EventJournal,
  JournalReadResult,
} from "../transport/EventJournal.js";
import {
  normalizeEndpointListenError,
  prepareTransportEndpoint,
  removeOwnedUnixSocket,
  resolveTransportEndpoint,
  restrictUnixSocketPermissions,
  type TransportEndpoint,
} from "../transport/endpoints.js";
import {
  bearerTokenMatches,
  validateTransportAuthToken,
} from "../transport/auth.js";
import { JsonRpcError, RpcErrorCode } from "../protocol/jsonrpc.js";
import type { Logger } from "../util/log.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * SDL: em dist/ (cópia do build — o que um pacote instala) ou, rodando de
 * src/ via tsx, direto da fonte contracts/ do repositório.
 */
export const SDL_CANDIDATE_PATHS = [
  path.join(dirname, "../contracts/graphql/editor.schema.graphql"),
  path.join(dirname, "../../../contracts/graphql/editor.schema.graphql"),
] as const;

export function resolveSdlPath(): string {
  const found = SDL_CANDIDATE_PATHS.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `editor.schema.graphql not found (tried: ${SDL_CANDIDATE_PATHS.join(", ")}) — run "npm run build"`,
    );
  }
  return found;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024; // espelha MAX_FRAME_BYTES do plano de controle

export interface GraphQlGatewayOptions {
  pipeName: string;
  surface: EditorSurface;
  journal: EventJournal;
  log: Logger;
  authToken: string;
}

/** Enum GraphQL não admite '/': skeleton_define ⇄ skeleton/define. */
export function graphqlKindToCanonical(kind: string): string {
  return kind.replace("_", "/");
}

function serializeEvent(event: EventEnvelope): {
  seq: string;
  projectSessionId: string;
  projectId: string;
  commandSequence: string;
  kind: string;
  payload: unknown;
  projection?: EnvelopeProjection;
  transactionId: string | null;
  documentStateId: string;
  historyEntryId: string | null;
  actor: string;
  historyAction: string;
  historyCursor: string;
} {
  return {
    seq: event.seq.toString(),
    projectSessionId: event.projectSessionId,
    projectId: event.projectId,
    commandSequence: event.commandSequence.toString(),
    kind: event.kind,
    payload: event.payload,
    ...(event.projection ? { projection: event.projection } : {}),
    // Eventos de controle (troca de sessão) não têm trilha: publicam o
    // baseline em vez de mentir um cursor.
    transactionId: event.history?.transactionId ?? null,
    documentStateId: event.history?.documentStateId ?? "baseline",
    historyEntryId: event.history?.historyEntryId ?? null,
    actor: event.history?.actor ?? "human",
    historyAction: event.history?.action ?? "apply",
    historyCursor: event.history?.historyCursor ?? "0",
  };
}

/** Um gesto desfeito rende N eventos; o resultado os publica em ordem. */
function serializeHistoryOperation(
  result: HistoryDispatchResult,
  events: readonly EventEnvelope[],
): Record<string, unknown> {
  return {
    action: result.action,
    historyEntryId: result.entry.id,
    label: result.entry.label,
    events: events.map(serializeEvent),
    documentStateId: result.documentStateId,
    historyCursor: result.historyCursor,
  };
}

function serializeBatch(result: JournalReadResult): Record<string, unknown> {
  return {
    middlewareInstanceId: result.middlewareInstanceId,
    projectSessionId: result.projectSessionId,
    projectId: result.projectId,
    commandSequence: result.commandSequence.toString(),
    firstAvailableSeq: result.firstAvailableSeq.toString(),
    lastEventSeq: result.lastEventSeq.toString(),
    resyncRequired: result.resyncRequired,
    resyncReason: result.resyncReason ?? null,
    events: result.events.map(serializeEvent),
  };
}

export class GraphQlGateway {
  private readonly schema: GraphQLSchema;
  private readonly server: http.Server;
  readonly endpoint: TransportEndpoint;

  constructor(private readonly options: GraphQlGatewayOptions) {
    validateTransportAuthToken(options.authToken);
    this.schema = buildSchema(fs.readFileSync(resolveSdlPath(), "utf8"));
    this.endpoint = resolveTransportEndpoint(options.pipeName, "graphql");
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
  }

  async listen(): Promise<void> {
    await prepareTransportEndpoint(this.endpoint);
    try {
      await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      this.server.once("error", failed);
      const done = (): void => {
        this.server.removeListener("error", failed);
        resolve();
      };
      if (this.endpoint.family === "uds") this.server.listen(this.endpoint.address, done);
      else this.server.listen(this.endpoint.port!, this.endpoint.address, done);
      });
      restrictUnixSocketPermissions(this.endpoint);
    } catch (error) {
      throw normalizeEndpointListenError(this.endpoint, error);
    }
    this.options.log.info("graphql gateway listening", { endpoint: this.endpoint.grpcTarget });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    removeOwnedUnixSocket(this.endpoint);
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/graphql") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "POST /graphql only" }] }));
      return;
    }
    if (!bearerTokenMatches(req.headers.authorization, this.options.authToken)) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      });
      res.end(JSON.stringify({ errors: [{ message: "authentication failed" }] }));
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: (err as Error).message }] }));
      return;
    }

    let parsed: { query?: unknown; variables?: unknown; operationName?: unknown };
    try {
      parsed = JSON.parse(body.toString("utf8")) as typeof parsed;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "body must be JSON {query, variables}" }] }));
      return;
    }
    if (typeof parsed.query !== "string") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: `"query" must be a string` }] }));
      return;
    }

    this.options.log.debug("graphql request", { operationName: parsed.operationName });
    const result = await graphql({
      schema: this.schema,
      source: parsed.query,
      rootValue: this.rootValue(),
      variableValues: (parsed.variables ?? undefined) as Record<string, unknown> | undefined,
      operationName: typeof parsed.operationName === "string" ? parsed.operationName : undefined,
    });

    // JsonRpcError vira extensão {code} — código estável cruza o transporte
    const payload = {
      ...result,
      errors: result.errors?.map((e) => ({
        message: e.message,
        path: e.path,
        extensions:
          e.originalError instanceof JsonRpcError
            ? { code: e.originalError.code }
            : e.extensions,
      })),
    };
    if (payload.errors === undefined) delete (payload as { errors?: unknown }).errors;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  /** Resolvers raiz — cada campo delega 1:1 para a EditorSurface. */
  private rootValue(): Record<string, unknown> {
    const { surface, journal } = this.options;
    return {
      health: () => {
        const position = journal.position;
        return {
          ok: true,
          engineConnected: surface.isEngineConnected,
          middlewareInstanceId: position.middlewareInstanceId,
          projectSessionId: position.projectSessionId,
          projectId: position.projectId,
          commandSequence: position.commandSequence.toString(),
          firstAvailableSeq: position.firstAvailableSeq.toString(),
          lastEventSeq: position.lastEventSeq.toString(),
        };
      },
      projection: (args: { name: string }) => surface.query(args.name),
      snapshot: () => {
        // `snapshot()` e a leitura da posição são síncronas: não há mutação
        // intercalada no event loop entre a projeção e o cursor carimbado.
        const snapshot = surface.snapshot();
        const position = journal.position;
        return {
          projections: snapshot.projections,
          status: snapshot.status,
          middlewareInstanceId: position.middlewareInstanceId,
          projectSessionId: position.projectSessionId,
          projectId: position.projectId,
          commandSequence: position.commandSequence.toString(),
          firstAvailableSeq: position.firstAvailableSeq.toString(),
          lastEventSeq: position.lastEventSeq.toString(),
        };
      },
      experience: (args: { family?: string; version?: string }) =>
        surface.resolveExperience(args.family, args.version),
      templates: () => surface.listTemplates(),
      projectStatus: () => surface.projectStatus(),
      historyStatus: (args: { limit?: number }) => surface.historyStatus(args.limit),
      eventBatch: (args: {
        middlewareInstanceId: string;
        projectSessionId?: string;
        afterSeq: string;
      }) => serializeBatch(
        journal.readSince(args.middlewareInstanceId, args.projectSessionId, args.afterSeq),
      ),
      // Sem a identidade da sessão, um seq pode pertencer ao projeto anterior.
      // Preservamos o campo no SDL apenas para produzir uma falha explícita.
      eventsSince: () => {
        throw new JsonRpcError(
          RpcErrorCode.InvalidParams,
          `eventsSince is unsafe without projectSessionId; use eventBatch`,
        );
      },
      undo: async (args: { historyCursor?: string; expectedProjectSessionId?: string }) => {
        const before = journal.position.lastEventSeq;
        const result = await surface.undo(args.historyCursor, args.expectedProjectSessionId);
        return serializeHistoryOperation(result, journal.since(before));
      },
      redo: async (args: { historyCursor?: string; expectedProjectSessionId?: string }) => {
        const before = journal.position.lastEventSeq;
        const result = await surface.redo(args.historyCursor, args.expectedProjectSessionId);
        return serializeHistoryOperation(result, journal.since(before));
      },
      dispatch: async (args: { kind: string; payload: unknown; requestId?: string }) => {
        const result = await surface.dispatchByKind(
          graphqlKindToCanonical(args.kind),
          args.payload,
          args.requestId,
        );
        return {
          event: result.event,
          projection: result.projection ?? null,
        };
      },
      projectCreate: (args: {
        projectId?: string | null;
        templateId?: string | null;
        expectedProjectSessionId?: string | null;
      }) => surface.projectCreate(
        args.projectId ?? undefined,
        args.templateId ?? undefined,
        args.expectedProjectSessionId ?? undefined,
      ),
      projectOpenDocument: (args: {
        document: unknown;
        expectedProjectSessionId?: string | null;
      }) => surface.projectOpenDocument(
        args.document,
        args.expectedProjectSessionId ?? undefined,
      ),
      projectClose: (args: { expectedProjectSessionId?: string | null }) =>
        surface.projectClose(args.expectedProjectSessionId ?? undefined),
      // Aliases legados preservam o wire, mas usam a mesma troca transacional.
      loadDocument: async (args: {
        document: unknown;
        expectedProjectSessionId?: string | null;
      }) => (await surface.projectOpenDocument(
        args.document,
        args.expectedProjectSessionId ?? undefined,
      )).summary,
      newProjectFromTemplate: async (args: {
        templateId: string;
        expectedProjectSessionId?: string | null;
      }) => {
        const result = await surface.projectCreate(
          undefined,
          args.templateId,
          args.expectedProjectSessionId ?? undefined,
        );
        const template = surface.listTemplates().find((item) => item.id === args.templateId);
        return {
          templateId: args.templateId,
          name: template?.label ?? args.templateId,
          ...result.summary,
        };
      },
    };
  }
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
