/**
 * Cliente do gateway do editor: conecta o processo main do Electron ao
 * endpoint `<pipe>-editor` do middleware, reutilizando o peer JSON-RPC e o
 * resolvedor de pipe do próprio pacote do middleware (mesmo framing, mesma
 * semântica — nenhuma reimplementação de protocolo no frontend).
 */

import net from "node:net";
import { JsonRpcPeer } from "@p7m/middleware/dist/ipc/JsonRpcPeer.js";
import { resolvePipePath } from "@p7m/middleware/dist/ipc/PipeEndpoint.js";
import { PROTOCOL_VERSION } from "@p7m/middleware/dist/protocol/jsonrpc.js";
import type { ResolvedExperienceLike } from "../core/experienceGate.js";

export interface BlueprintEventPayload {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface DispatchOutcome {
  readonly event: BlueprintEventPayload;
  readonly projection?: { status: string; reason?: string };
}

export class EditorClient {
  private peer: JsonRpcPeer | undefined;
  private readonly eventListeners = new Set<(event: BlueprintEventPayload) => void>();

  constructor(
    private readonly pipeName: string,
    private readonly clientName = "p7m-electron-editor",
  ) {}

  get isConnected(): boolean {
    return this.peer !== undefined && !this.peer.isClosed;
  }

  async connect(): Promise<{ sessionId: string }> {
    const path = resolvePipePath(`${this.pipeName}-editor`);
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(path);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });

    const peer = new JsonRpcPeer(socket, { label: this.clientName });
    // O peer descarta notifications sem handler: registra o receptor do broadcast.
    peer.registerMethod("blueprint/event", (params) => {
      for (const listener of this.eventListeners) {
        listener(params as BlueprintEventPayload);
      }
    });
    this.peer = peer;

    return peer.request<{ sessionId: string }>("editor/handshake", {
      clientName: this.clientName,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  /** Assina o broadcast de eventos do Blueprint. Retorna a função de remoção. */
  onBlueprintEvent(listener: (event: BlueprintEventPayload) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  dispatch(kind: string, payload: Record<string, unknown>): Promise<DispatchOutcome> {
    return this.request<DispatchOutcome>("blueprint/dispatch", { kind, payload });
  }

  query<T = unknown>(projection: string): Promise<T> {
    return this.request<T>("blueprint/query", { projection });
  }

  resolveExperience(family?: string, version?: string): Promise<ResolvedExperienceLike> {
    return this.request<ResolvedExperienceLike>("experience/resolve", {
      ...(family !== undefined ? { family } : {}),
      ...(version !== undefined ? { version } : {}),
    });
  }

  /** Snapshot completo do projeto (Save/Save As escrevem isto em disco). */
  async saveDocument(): Promise<unknown> {
    const { document } = await this.request<{ document: unknown }>("blueprint/query", {
      projection: "document",
    });
    return document;
  }

  /**
   * Reproduz um documento salvo pelo caminho canônico (Open). Exige
   * blueprint vazio — "novo projeto" é estado explícito do ciclo de vida.
   */
  loadDocument(document: unknown): Promise<{
    applied: number;
    projected: number;
    deferred: number;
    skipped: number;
  }> {
    return this.request("blueprint/load", { document });
  }

  close(): void {
    this.peer?.close();
    this.peer = undefined;
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.peer || this.peer.isClosed) {
      return Promise.reject(new Error("EditorClient is not connected"));
    }
    return this.peer.request<T>(method, params);
  }
}
