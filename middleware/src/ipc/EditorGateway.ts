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
import { CanonicalOrchestrator } from "../canonical/CanonicalOrchestrator.js";
import { COMMAND_KINDS, reshapeCommand } from "../canonical/commandShape.js";
import type { BlueprintCommand, BlueprintEvent, BlueprintStore } from "../domain/BlueprintStore.js";
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

const QUERYABLE_PROJECTIONS = [
  "skeletons",
  "meshes",
  "lights",
  "entityDefs",
  "entities",
  "camera",
  "levels",
  "world",
] as const;

/**
 * Eventos: "session" (EditorSession), "sessionClosed" (EditorSession, Error).
 */
export class EditorGateway extends EventEmitter {
  private readonly server: net.Server;
  private readonly sessions = new Map<string, EditorSession>();
  private readonly options: EditorGatewayOptions;
  readonly pipePath: string;

  constructor(options: EditorGatewayOptions) {
    super();
    this.options = options;
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
      if (
        typeof p?.kind !== "string" ||
        !(COMMAND_KINDS as readonly string[]).includes(p.kind) ||
        typeof p?.payload !== "object" || p.payload === null
      ) {
        throw new JsonRpcError(
          RpcErrorCode.InvalidParams,
          `"kind" must be one of [${COMMAND_KINDS.join(", ")}] and "payload" an object`,
        );
      }
      const command = reshapeCommand(
        p.kind as BlueprintCommand["kind"],
        p.payload as Record<string, unknown>,
      );
      return this.options.orchestrator.dispatch(command);
    });

    peer.registerMethod("blueprint/query", (params) => {
      this.requireHandshake(session);
      const p = params as { projection?: unknown };
      const store = this.options.store;
      switch (p?.projection) {
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
        default:
          throw new JsonRpcError(
            RpcErrorCode.InvalidParams,
            `"projection" must be one of [${QUERYABLE_PROJECTIONS.join(", ")}]`,
          );
      }
    });

    peer.registerMethod("experience/resolve", (params) => {
      this.requireHandshake(session);
      const p = (params ?? {}) as { family?: string; version?: string };
      const identity = this.options.adapter.identify();
      return this.options.governor.resolve(
        p.family ?? identity?.family ?? this.options.adapter.family,
        p.version ?? identity?.version ?? "999.0.0",
      );
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
