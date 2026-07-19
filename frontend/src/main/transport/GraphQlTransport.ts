/**
 * Transporte GraphQL do app — a superfície COMPLETA (baseline) do editor
 * (ADR-016) e o fallback do caminho quente. HTTP/1.1 sobre UDS (POSIX) ou
 * 127.0.0.1 (Windows); endpoints resolvidos pelo MESMO módulo do middleware
 * (`@p7m/middleware/dist/transport/endpoints.js`) — nenhuma convenção
 * duplicada. Sem Electron aqui (portável a drivers e testes headless).
 */

import http from "node:http";
import {
  resolveTransportEndpoint,
  type TransportEndpoint,
} from "@p7m/middleware/dist/transport/endpoints.js";
import {
  AUTHENTICATION_ERROR_CODE,
  bearerAuthorization,
  loadTransportAuthToken,
} from "@p7m/middleware/dist/transport/auth.js";
import type { Logger } from "../../core/logging.js";

export interface GraphQlErrorShape {
  message: string;
  extensions?: { code?: number };
}

/** Erro de DOMÍNIO vindo do GraphQL (extensão `code` estável do JSON-RPC). */
export class GraphQlDomainError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "GraphQlDomainError";
  }
}

/** Falha de credencial local; nunca deve ser tratada como indisponibilidade. */
export class GraphQlAuthenticationError extends Error {
  readonly code = AUTHENTICATION_ERROR_CODE;
  readonly statusCode = 401;

  constructor(message = "editor transport authentication failed") {
    super(message);
    this.name = "GraphQlAuthenticationError";
  }
}

export class GraphQlTransport {
  readonly endpoint: TransportEndpoint;

  constructor(
    pipeName: string,
    private readonly log: Logger,
    private readonly timeoutMs = 10_000,
    private readonly authToken = loadTransportAuthToken(),
  ) {
    this.endpoint = resolveTransportEndpoint(pipeName, "graphql");
  }

  /**
   * Executa uma operação GraphQL. Erros de socket/timeout sobem como erros de
   * TRANSPORTE (code string de socket); erros GraphQL de domínio viram
   * GraphQlDomainError com o código estável.
   */
  async execute<T>(
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string,
  ): Promise<T> {
    this.log.trace("graphql execute", { operationName });
    const body = JSON.stringify({ query, variables, operationName });
    const { statusCode, body: raw } = await this.post(body);
    if (statusCode === 401 || statusCode === 403) {
      throw new GraphQlAuthenticationError();
    }
    const parsed = JSON.parse(raw) as { data?: T; errors?: GraphQlErrorShape[] };
    if (parsed.errors && parsed.errors.length > 0) {
      const first = parsed.errors[0]!;
      throw new GraphQlDomainError(first.message, first.extensions?.code);
    }
    if (parsed.data === undefined) {
      throw new GraphQlDomainError("GraphQL response without data");
    }
    return parsed.data;
  }

  private post(body: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        method: "POST",
        path: "/graphql",
        headers: {
          authorization: bearerAuthorization(this.authToken),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: this.timeoutMs,
        ...(this.endpoint.family === "uds"
          ? { socketPath: this.endpoint.address }
          : { host: this.endpoint.address, port: this.endpoint.port }),
      };
      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      req.on("timeout", () => {
        req.destroy(Object.assign(new Error("graphql request timeout"), { code: "ETIMEDOUT" }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }
}
