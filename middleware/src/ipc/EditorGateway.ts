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
import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { EditorSurface } from "../canonical/EditorSurface.js";
import { CanonicalOrchestrator } from "../canonical/CanonicalOrchestrator.js";
import type { BlueprintEvent, BlueprintStore } from "../domain/BlueprintStore.js";
import type { ExperienceGovernor } from "../runtime/ExperienceGovernor.js";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.js";
import { JsonRpcPeer } from "./JsonRpcPeer.js";
import { resolvePipePath } from "./PipeEndpoint.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../protocol/jsonrpc.js";

export interface EditorSession {
  sessionId: string;
  clientName: string;
  peer: JsonRpcPeer;
}

export interface EditorGatewayOptions {
  /** Nome base do canal; o gateway escuta em `<pipeName>-editor`. */
  pipeName: string;
  orchestrator: CanonicalOrchestrator;
  store: BlueprintStore;
  governor: ExperienceGovernor;
  adapter: RuntimeAdapter;
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
  readonly pipePath: string;

  constructor(options: EditorGatewayOptions) {
    super();
    this.options = options;
    this.surface = new EditorSurface(options);
    this.pipePath = resolvePipePath(`${options.pipeName}-editor`);
    this.server = net.createServer((socket) => this.onConnection(socket));

    // Broadcast: qualquer evento do AST (deste ou de outro cliente, MCP ou
    // reidratação) chega a todos os editores — coerência multi-janela.
    options.store.on("event", (event: BlueprintEvent) => {
      for (const session of this.sessions.values()) {
        session.peer.notify("blueprint/event", event);
      }
    });
  }

  async listen(): Promise<void> {
    if (process.platform !== "win32" && fs.existsSync(this.pipePath)) {
      fs.unlinkSync(this.pipePath);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.pipePath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.peer.close();
    this.sessions.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (process.platform !== "win32" && fs.existsSync(this.pipePath)) {
      fs.unlinkSync(this.pipePath);
    }
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
      const p = params as { clientName?: unknown; protocolVersion?: unknown };
      if (typeof p?.clientName !== "string" || p.clientName.length === 0 ||
          typeof p?.protocolVersion !== "string") {
        throw new JsonRpcError(
          RpcErrorCode.InvalidParams,
          `editor/handshake requires "clientName" and "protocolVersion"`,
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
      };
    });

    peer.registerMethod("blueprint/dispatch", async (params) => {
      this.requireHandshake(session);
      const p = params as { kind?: unknown; payload?: unknown };
      return this.surface.dispatchByKind(p?.kind as string, p?.payload);
    });

    peer.registerMethod("blueprint/query", (params) => {
      this.requireHandshake(session);
      const p = params as { projection?: unknown };
      return this.surface.query(p?.projection as string);
    });

    peer.registerMethod("blueprint/load", async (params) => {
      this.requireHandshake(session);
      const p = params as { document?: unknown };
      return this.surface.loadDocument(p?.document);
    });

    peer.registerMethod("project/templates", () => {
      this.requireHandshake(session);
      return { templates: this.surface.listTemplates() };
    });

    peer.registerMethod("project/new", async (params) => {
      this.requireHandshake(session);
      const p = (params ?? {}) as { templateId?: unknown };
      return this.surface.newProjectFromTemplate(p?.templateId);
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
