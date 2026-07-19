/**
 * Gateway do editor (Fase 4): o endpoint IPC que o Electron (e qualquer
 * cliente de edição) usa para operar o modelo canônico.
 *
 * Vive em um pipe separado do canal da engine (`<nome>-editor`) e expõe:
 * - `editor/handshake`     — identidade + versão de protocolo;
 * - `blueprint/dispatch`   — comandos canônicos via CanonicalOrchestrator
 *                            (filters → AST → actions → projeção no runtime);
 * - `blueprint/query`      — projeções somente-leitura do Blueprint;
 * - `experience/resolve`   — matriz de decisões da governança de runtime;
 * - notification `blueprint/event` — broadcast de todo evento do AST para
 *   todos os editores handshakeados (multi-janela/multi-cliente coerente).
 */

import { EventEmitter } from "node:events";
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { EditorSurface } from "../canonical/EditorSurface.js";
import type { EventEnvelope, EventJournal } from "../transport/EventJournal.js";
import { JsonRpcPeer } from "./JsonRpcPeer.js";
import { resolvePipePath } from "./PipeEndpoint.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../protocol/jsonrpc.js";
import { timingSafeTokenEqual, validateTransportAuthToken } from "../transport/auth.js";
import {
  prepareUnixSocketPath,
  removeOwnedUnixSocketPath,
  restrictUnixSocketPathPermissions,
} from "./UnixSocketLifecycle.js";

export interface EditorSession {
  sessionId: string;
  clientName: string;
  peer: JsonRpcPeer;
}

export interface EditorGatewayOptions {
  /** Nome base do canal; o gateway escuta em `<pipeName>-editor`. */
  pipeName: string;
  /** A mesma superfície usada por GraphQL, gRPC e MCP. */
  surface: EditorSurface;
  /** Diário session-aware compartilhado por todas as bordas. */
  journal: EventJournal;
  /** Segredo efêmero compartilhado apenas entre o Electron e este processo. */
  authToken: string;
  requestTimeoutMs?: number;
}

/**
 * Eventos: "session" (EditorSession), "sessionClosed" (EditorSession, Error).
 *
 * Desde a introdução dos transports do app (GraphQL/gRPC — ADR-016/017),
 * este gateway delega toda a superfície na EditorSurface compartilhada:
 * três bordas, um único fluxo canônico.
 */
export class EditorGateway extends EventEmitter {
  private readonly server: net.Server;
  private readonly sessions = new Map<string, EditorSession>();
  private readonly options: EditorGatewayOptions;
  private readonly surface: EditorSurface;
  private readonly broadcastEvent: (event: EventEnvelope) => void;
  readonly pipePath: string;

  constructor(options: EditorGatewayOptions) {
    super();
    this.options = { ...options, authToken: validateTransportAuthToken(options.authToken) };
    this.surface = options.surface;
    this.pipePath = resolvePipePath(`${options.pipeName}-editor`);
    this.server = net.createServer((socket) => this.onConnection(socket));

    // Broadcast do envelope session-aware: eventos de uma sessão temporária
    // nunca entram no journal e, portanto, nunca vazam para os clientes.
    this.broadcastEvent = (event: EventEnvelope): void => {
      const serialized = serializeEvent(event);
      for (const session of this.sessions.values()) {
        session.peer.notify("blueprint/event", serialized);
      }
    };
    options.journal.on("event", this.broadcastEvent);
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
    this.options.journal.removeListener("event", this.broadcastEvent);
    for (const session of this.sessions.values()) session.peer.close();
    this.sessions.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (process.platform !== "win32") removeOwnedUnixSocketPath(this.pipePath);
  }

  get activeSessions(): readonly EditorSession[] {
    return [...this.sessions.values()];
  }

  private onConnection(socket: net.Socket): void {
    socket.setNoDelay?.(true);
    const peer = new JsonRpcPeer(socket, {
      label: "editor-connection",
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
    });
    let session: EditorSession | undefined;

    peer.registerMethod("editor/handshake", (params) => {
      const p = params as { clientName?: unknown; protocolVersion?: unknown; authToken?: unknown };
      if (typeof p?.clientName !== "string" || p.clientName.length === 0 ||
          typeof p?.protocolVersion !== "string" || typeof p?.authToken !== "string") {
        throw new JsonRpcError(
          RpcErrorCode.InvalidParams,
          `editor/handshake requires "clientName", "protocolVersion" and "authToken"`,
        );
      }
      if (!timingSafeTokenEqual(this.options.authToken, p.authToken)) {
        throw new JsonRpcError(
          RpcErrorCode.AuthenticationFailed,
          "editor transport authentication failed",
        );
      }
      const [major] = p.protocolVersion.split(".");
      if (major !== PROTOCOL_VERSION.split(".")[0]) {
        throw new JsonRpcError(
          RpcErrorCode.ProtocolMismatch,
          `Protocol major version mismatch: editor=${p.protocolVersion}, middleware=${PROTOCOL_VERSION}`,
        );
      }
      session = { sessionId: randomUUID(), clientName: p.clientName, peer };
      this.sessions.set(session.sessionId, session);
      this.emit("session", session);
      return {
        sessionId: session.sessionId,
        serverName: "p7m-middleware",
        protocolVersion: PROTOCOL_VERSION,
        project: this.surface.projectStatus(),
      };
    });

    peer.registerMethod("blueprint/dispatch", async (params) => {
      this.requireHandshake(session);
      const p = params as { kind?: unknown; payload?: unknown; requestId?: unknown };
      return this.surface.dispatchByKind(
        p?.kind as string,
        p?.payload,
        p?.requestId as string | undefined,
      );
    });

    peer.registerMethod("blueprint/query", (params) => {
      this.requireHandshake(session);
      const p = params as { projection?: unknown };
      return this.surface.query(p?.projection as string);
    });

    peer.registerMethod("blueprint/load", async (params) => {
      this.requireHandshake(session);
      const p = params as { document?: unknown; expectedProjectSessionId?: unknown };
      return (await this.surface.projectOpenDocument(
        p?.document,
        p?.expectedProjectSessionId,
      )).summary;
    });

    peer.registerMethod("project/templates", () => {
      this.requireHandshake(session);
      return { templates: this.surface.listTemplates() };
    });

    peer.registerMethod("project/new", async (params) => {
      this.requireHandshake(session);
      const p = (params ?? {}) as {
        templateId?: unknown;
        expectedProjectSessionId?: unknown;
      };
      const templateId = p.templateId as string;
      const result = await this.surface.projectCreate(
        undefined,
        templateId,
        p.expectedProjectSessionId,
      );
      const template = this.surface.listTemplates().find((item) => item.id === templateId);
      return {
        templateId,
        name: template?.label ?? templateId,
        ...result.summary,
      };
    });

    peer.registerMethod("project/create", async (params) => {
      this.requireHandshake(session);
      const p = (params ?? {}) as {
        projectId?: unknown;
        templateId?: unknown;
        expectedProjectSessionId?: unknown;
      };
      return this.surface.projectCreate(
        p.projectId as string | undefined,
        p.templateId as string | undefined,
        p.expectedProjectSessionId,
      );
    });

    peer.registerMethod("project/openDocument", async (params) => {
      this.requireHandshake(session);
      const p = (params ?? {}) as {
        document?: unknown;
        expectedProjectSessionId?: unknown;
      };
      return this.surface.projectOpenDocument(p.document, p.expectedProjectSessionId);
    });

    peer.registerMethod("project/close", async (params) => {
      this.requireHandshake(session);
      const p = (params ?? {}) as { expectedProjectSessionId?: unknown };
      return this.surface.projectClose(p.expectedProjectSessionId as string | undefined);
    });

    peer.registerMethod("project/status", () => {
      this.requireHandshake(session);
      return this.surface.projectStatus();
    });

    peer.registerMethod("experience/resolve", (params) => {
      this.requireHandshake(session);
      const p = (params ?? {}) as { family?: string; version?: string };
      return this.surface.resolveExperience(p.family, p.version);
    });

    peer.on("close", (reason: Error) => {
      if (session) {
        this.sessions.delete(session.sessionId);
        this.emit("sessionClosed", session, reason);
      }
    });
  }

  private requireHandshake(session: EditorSession | undefined): void {
    if (!session) {
      throw new JsonRpcError(
        RpcErrorCode.EngineNotReady,
        "editor/handshake must complete before other calls",
      );
    }
  }
}

function serializeEvent(event: EventEnvelope): Record<string, unknown> {
  return {
    seq: event.seq.toString(),
    projectSessionId: event.projectSessionId,
    projectId: event.projectId,
    commandSequence: event.commandSequence.toString(),
    kind: event.kind,
    payload: event.payload,
  };
}
