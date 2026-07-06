import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { FrameDecoder, FrameProtocolError, encodeFrame } from "../protocol/framing.js";
import {
  JSONRPC_VERSION,
  JsonRpcError,
  RpcErrorCode,
  isRequest,
  isResponse,
  parseMessage,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../protocol/jsonrpc.js";

export type RpcHandler = (params: unknown, peer: JsonRpcPeer) => unknown | Promise<unknown>;

export interface JsonRpcPeerOptions {
  /** Timeout (ms) para requests originados localmente. Default: 10_000. */
  requestTimeoutMs?: number;
  /** Rótulo usado em mensagens de erro/log. */
  label?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Peer JSON-RPC 2.0 full-duplex e simétrico sobre um stream Duplex
 * (Named Pipe, Unix Domain Socket ou par loopback em testes).
 *
 * Ambos os lados podem emitir requests (aguardam resposta correlacionada
 * por id) e notifications (fire-and-forget). Handlers são registrados por
 * nome de método; exceções `JsonRpcError` viram respostas de erro tipadas.
 *
 * Eventos: "notification" (method, params), "close", "protocolError" (Error).
 */
export class JsonRpcPeer extends EventEmitter {
  private readonly decoder = new FrameDecoder();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private closed = false;

  private readonly requestTimeoutMs: number;
  readonly label: string;

  constructor(
    private readonly stream: Duplex,
    options: JsonRpcPeerOptions = {},
  ) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.label = options.label ?? "peer";

    stream.on("data", (chunk: Buffer) => this.onData(chunk));
    stream.on("error", (err: Error) => this.teardown(err));
    stream.on("close", () => this.teardown(new Error(`${this.label}: transport closed`)));
  }

  /** Registra o handler de um método. Registro duplicado é um erro de programação. */
  registerMethod(method: string, handler: RpcHandler): void {
    if (this.handlers.has(method)) {
      throw new Error(`Handler already registered for method "${method}"`);
    }
    this.handlers.set(method, handler);
  }

  /** Envia um request e aguarda a resposta correlacionada. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`${this.label}: peer is closed`));
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, method, id, ...(params !== undefined ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: request "${method}" (id ${id}) timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(message);
    });
  }

  /** Envia uma notification (sem id, sem resposta). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: JSONRPC_VERSION, method, ...(params !== undefined ? { params } : {}) });
  }

  close(): void {
    this.teardown(new Error(`${this.label}: closed locally`));
    this.stream.destroy();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private send(message: unknown): void {
    if (this.closed || this.stream.destroyed) return;
    this.stream.write(encodeFrame(JSON.stringify(message)));
  }

  private onData(chunk: Buffer): void {
    let bodies: string[];
    try {
      bodies = this.decoder.push(chunk);
    } catch (err) {
      // Frame acima do limite: viola o protocolo, encerra a conexão.
      if (err instanceof FrameProtocolError) {
        this.emit("protocolError", err);
        this.close();
        return;
      }
      throw err;
    }
    for (const body of bodies) void this.dispatch(body);
  }

  private async dispatch(body: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      this.send({
        jsonrpc: JSONRPC_VERSION,
        error: { code: RpcErrorCode.ParseError, message: "Parse error" },
        id: null,
      });
      return;
    }

    let message;
    try {
      message = parseMessage(raw);
    } catch (err) {
      const rpcErr = err instanceof JsonRpcError ? err : new JsonRpcError(RpcErrorCode.InvalidRequest, "Invalid request");
      const id = (raw as { id?: JsonRpcId })?.id ?? null;
      this.send({ jsonrpc: JSONRPC_VERSION, error: { code: rpcErr.code, message: rpcErr.message }, id });
      return;
    }

    if (isResponse(message)) {
      this.onResponse(message);
      return;
    }
    if (isRequest(message)) {
      await this.onRequest(message);
    }
  }

  private onResponse(response: JsonRpcResponse): void {
    if (response.id === null || response.id === undefined) {
      // Erro não correlacionável (ex.: parse error remoto) — apenas sinaliza.
      this.emit("protocolError", new Error(`${this.label}: uncorrelated error response: ${JSON.stringify(response)}`));
      return;
    }
    const entry = this.pending.get(response.id);
    if (!entry) return; // resposta tardia de request expirado
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if ("error" in response) {
      entry.reject(new JsonRpcError(response.error.code, response.error.message, response.error.data));
    } else {
      entry.resolve(response.result);
    }
  }

  private async onRequest(request: JsonRpcRequest): Promise<void> {
    const isNotification = request.id === undefined;
    const handler = this.handlers.get(request.method);

    if (!handler) {
      if (isNotification) return; // notifications desconhecidas são ignoradas por contrato
      this.send({
        jsonrpc: JSONRPC_VERSION,
        error: { code: RpcErrorCode.MethodNotFound, message: `Method not found: "${request.method}"` },
        id: request.id!,
      });
      return;
    }

    if (isNotification) {
      try {
        await handler(request.params, this);
        this.emit("notification", request.method, request.params);
      } catch (err) {
        this.emit("protocolError", err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    try {
      const result = await handler(request.params, this);
      this.send({ jsonrpc: JSONRPC_VERSION, result: result ?? null, id: request.id! });
    } catch (err) {
      const rpcErr =
        err instanceof JsonRpcError
          ? err
          : new JsonRpcError(RpcErrorCode.InternalError, err instanceof Error ? err.message : "Internal error");
      this.send({
        jsonrpc: JSONRPC_VERSION,
        error: { code: rpcErr.code, message: rpcErr.message, ...(rpcErr.data !== undefined ? { data: rpcErr.data } : {}) },
        id: request.id!,
      });
    }
  }

  private teardown(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    this.pending.clear();
    this.emit("close", reason);
  }
}
