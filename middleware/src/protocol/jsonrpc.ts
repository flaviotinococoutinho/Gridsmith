/**
 * Tipos e constantes do plano de controle JSON-RPC 2.0.
 * Espelha os contratos de `contracts/schemas/` — fonte única de verdade.
 */

export const JSONRPC_VERSION = "2.0" as const;

/** Versão negociada no handshake. MAJOR incompatível recusa a conexão. */
export const PROTOCOL_VERSION = "1.0";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
  id?: JsonRpcId;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  result: unknown;
  id: JsonRpcId | null;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  error: JsonRpcErrorObject;
  id: JsonRpcId | null;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

/** Códigos padrão da especificação JSON-RPC 2.0. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Faixa de domínio -32000..-32099 (ver contracts/schemas/error-codes.md)
  EngineNotReady: -32000,
  ProtocolMismatch: -32001,
  UnknownSkeleton: -32002,
  UnknownMesh: -32003,
  SharedMemoryUnavailable: -32004,
  InvalidBinaryLayout: -32005,
  DuplicateId: -32006,
  AuthenticationFailed: -32007,
  ProjectNotOpen: -32008,
  ProjectSessionConflict: -32009,
} as const;

/** Erro lançável por handlers; convertido em resposta de erro JSON-RPC. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !("method" in msg) && ("result" in msg || "error" in msg);
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && typeof (msg as JsonRpcRequest).method === "string";
}

/** Valida a forma externa de uma mensagem recebida do fio. */
export function parseMessage(raw: unknown): JsonRpcMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new JsonRpcError(RpcErrorCode.InvalidRequest, "Message must be a JSON object");
  }
  const msg = raw as Record<string, unknown>;
  if (msg["jsonrpc"] !== JSONRPC_VERSION) {
    throw new JsonRpcError(RpcErrorCode.InvalidRequest, `Missing or invalid "jsonrpc": expected "${JSONRPC_VERSION}"`);
  }
  const hasMethod = typeof msg["method"] === "string";
  const hasResult = "result" in msg;
  const hasError = "error" in msg;
  if (hasMethod && !hasResult && !hasError) return msg as unknown as JsonRpcRequest;
  if (!hasMethod && (hasResult !== hasError)) return msg as unknown as JsonRpcResponse;
  throw new JsonRpcError(RpcErrorCode.InvalidRequest, "Message is neither a valid request nor a valid response");
}
