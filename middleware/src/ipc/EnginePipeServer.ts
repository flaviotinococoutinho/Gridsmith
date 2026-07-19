import { EventEmitter } from "node:events";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { JsonRpcPeer } from "./JsonRpcPeer.js";
import { resolvePipePath } from "./PipeEndpoint.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../protocol/jsonrpc.js";
import {
  prepareUnixSocketPath,
  removeOwnedUnixSocketPath,
  restrictUnixSocketPathPermissions,
} from "./UnixSocketLifecycle.js";

export interface HandshakeParams {
  clientName: string;
  clientVersion: string;
  protocolVersion: string;
  capabilities?: string[];
}

export interface EngineSession {
  sessionId: string;
  clientName: string;
  clientVersion: string;
  capabilities: string[];
  peer: JsonRpcPeer;
  connectedAtUnixMs: number;
}

export interface EngineLogEntry {
  level: "trace" | "debug" | "info" | "warn" | "error";
  message: string;
  category?: string;
  unixMs?: number;
}

export interface EnginePipeServerOptions {
  pipeName?: string;
  /** Capacidades que o middleware aceita anunciar de volta no handshake. */
  supportedCapabilities?: string[];
  requestTimeoutMs?: number;
}

const SERVER_NAME = "p7m-middleware";

/**
 * Endpoint do plano de controle: aceita conexões da engine via Named Pipe
 * (Windows) ou Unix Domain Socket (Linux/macOS), executa o handshake de
 * protocolo e mantém o registro de sessões ativas.
 *
 * Eventos:
 * - "session"      (session: EngineSession)  — handshake concluído
 * - "sessionClosed"(session: EngineSession, reason: Error)
 * - "engineLog"    (session: EngineSession, entry: EngineLogEntry)
 */
export class EnginePipeServer extends EventEmitter {
  private readonly server: net.Server;
  private readonly sessions = new Map<string, EngineSession>();
  private readonly options: EnginePipeServerOptions;
  readonly pipePath: string;

  constructor(options: EnginePipeServerOptions = {}) {
    super();
    this.options = options;
    this.pipePath = resolvePipePath(options.pipeName);
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  async listen(): Promise<void> {
    if (process.platform !== "win32") await prepareUnixSocketPath(this.pipePath);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.pipePath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") restrictUnixSocketPathPermissions(this.pipePath);
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.peer.close();
    this.sessions.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (process.platform !== "win32") removeOwnedUnixSocketPath(this.pipePath);
  }

  get activeSessions(): readonly EngineSession[] {
    return [...this.sessions.values()];
  }

  /** Sessão ativa mais recente — a projeção materializada corrente da engine. */
  get currentSession(): EngineSession | undefined {
    return this.activeSessions.at(-1);
  }

  private onConnection(socket: net.Socket): void {
    socket.setNoDelay?.(true);
    const peer = new JsonRpcPeer(socket, {
      label: "engine-connection",
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
    });
    let session: EngineSession | undefined;

    peer.registerMethod("engine/handshake", (params) => {
      const p = validateHandshake(params);
      const [major] = p.protocolVersion.split(".");
      const [serverMajor] = PROTOCOL_VERSION.split(".");
      if (major !== serverMajor) {
        throw new JsonRpcError(
          RpcErrorCode.ProtocolMismatch,
          `Protocol major version mismatch: engine=${p.protocolVersion}, middleware=${PROTOCOL_VERSION}`,
        );
      }
      const supported = new Set(this.options.supportedCapabilities ?? []);
      const accepted = (p.capabilities ?? []).filter((c) => supported.has(c));
      session = {
        sessionId: randomUUID(),
        clientName: p.clientName,
        clientVersion: p.clientVersion,
        capabilities: accepted,
        peer,
        connectedAtUnixMs: Date.now(),
      };
      this.sessions.set(session.sessionId, session);
      this.emit("session", session);
      return {
        sessionId: session.sessionId,
        serverName: SERVER_NAME,
        protocolVersion: PROTOCOL_VERSION,
        acceptedCapabilities: accepted,
      };
    });

    peer.registerMethod("engine/ping", (params) => {
      const p = (params ?? {}) as { payload?: unknown };
      if (typeof p.payload !== "string") {
        throw new JsonRpcError(RpcErrorCode.InvalidParams, `"payload" must be a string`);
      }
      return { echo: p.payload, receivedAtUnixMs: Date.now() };
    });

    peer.registerMethod("engine/log", (params) => {
      if (!session) return; // logs antes do handshake são descartados
      const entry = params as EngineLogEntry;
      if (typeof entry?.message === "string" && typeof entry?.level === "string") {
        this.emit("engineLog", session, entry);
      }
    });

    peer.on("close", (reason: Error) => {
      if (session) {
        this.sessions.delete(session.sessionId);
        this.emit("sessionClosed", session, reason);
      }
    });
  }
}

function validateHandshake(params: unknown): HandshakeParams {
  const p = params as Partial<HandshakeParams> | undefined;
  if (
    !p ||
    typeof p.clientName !== "string" ||
    p.clientName.length === 0 ||
    typeof p.clientVersion !== "string" ||
    typeof p.protocolVersion !== "string" ||
    !/^\d+\.\d+$/.test(p.protocolVersion)
  ) {
    throw new JsonRpcError(
      RpcErrorCode.InvalidParams,
      `engine/handshake requires "clientName", "clientVersion" and "protocolVersion" (MAJOR.MINOR)`,
    );
  }
  if (p.capabilities !== undefined && !Array.isArray(p.capabilities)) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"capabilities" must be an array of strings`);
  }
  return p as HandshakeParams;
}
