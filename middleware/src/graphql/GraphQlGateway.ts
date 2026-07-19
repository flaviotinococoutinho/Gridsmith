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
import type { EditorSurface } from "../canonical/EditorSurface.js";
import type { EventJournal } from "../transport/EventJournal.js";
import { resolveTransportEndpoint, type TransportEndpoint } from "../transport/endpoints.js";
import { JsonRpcError } from "../protocol/jsonrpc.js";
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
}

/** Enum GraphQL não admite '/': skeleton_define ⇄ skeleton/define. */
export function graphqlKindToCanonical(kind: string): string {
  return kind.replace("_", "/");
}

export class GraphQlGateway {
  private readonly schema: GraphQLSchema;
  private readonly server: http.Server;
  readonly endpoint: TransportEndpoint;

  constructor(private readonly options: GraphQlGatewayOptions) {
    this.schema = buildSchema(fs.readFileSync(resolveSdlPath(), "utf8"));
    this.endpoint = resolveTransportEndpoint(options.pipeName, "graphql");
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
  }

  async listen(): Promise<void> {
    if (this.endpoint.family === "uds" && fs.existsSync(this.endpoint.address)) {
      fs.unlinkSync(this.endpoint.address);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      const done = (): void => {
        this.server.removeListener("error", reject);
        resolve();
      };
      if (this.endpoint.family === "uds") this.server.listen(this.endpoint.address, done);
      else this.server.listen(this.endpoint.port!, this.endpoint.address, done);
    });
    this.options.log.info("graphql gateway listening", { endpoint: this.endpoint.grpcTarget });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.endpoint.family === "uds" && fs.existsSync(this.endpoint.address)) {
      fs.unlinkSync(this.endpoint.address);
    }
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/graphql") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "POST /graphql only" }] }));
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
      health: () => ({
        ok: true,
        engineConnected: surface.isEngineConnected,
        lastEventSeq: journal.lastSeq,
      }),
      projection: (args: { name: string }) => surface.query(args.name),
      experience: (args: { family?: string; version?: string }) =>
        surface.resolveExperience(args.family, args.version),
      templates: () => surface.listTemplates(),
      eventsSince: (args: { afterSeq: number }) =>
        journal.since(args.afterSeq).map((e) => ({ seq: e.seq, kind: e.kind, payload: e.payload })),
      dispatch: async (args: { kind: string; payload: unknown }) => {
        const result = await surface.dispatchByKind(graphqlKindToCanonical(args.kind), args.payload);
        return {
          event: result.event,
          projection: result.projection ?? null,
        };
      },
      loadDocument: (args: { document: unknown }) => surface.loadDocument(args.document),
      newProjectFromTemplate: (args: { templateId: string }) =>
        surface.newProjectFromTemplate(args.templateId),
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
