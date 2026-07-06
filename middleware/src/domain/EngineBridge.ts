/**
 * Ponte de alto nível middleware → engine.
 *
 * Aplica comandos ao BlueprintStore (fonte de verdade) e propaga o efeito
 * para a sessão ativa da engine via JSON-RPC. A engine é uma projeção
 * materializada do AST: se não houver sessão, o comando fica registrado no
 * store e é reidratado quando a engine (re)conecta.
 */

import type { EnginePipeServer, EngineSession } from "../ipc/EnginePipeServer.js";
import {
  BlueprintStore,
  type MeshBinding,
  type SkeletonBlueprint,
} from "./BlueprintStore.js";

export interface SkeletonInitializeResult {
  skeletonId: string;
  boneCount: number;
  status: "initialized";
}

export interface MeshBindResult {
  meshId: string;
  mappedBytes?: number;
  status: "bound" | "deferred";
}

export interface PingResult {
  echo: string;
  receivedAtUnixMs?: number;
}

export interface MeshInspectResult {
  meshId: string;
  vertexCount: number;
  strideInBytes: number;
  frameIndex: number;
  checksumFnv1a: number;
  sample: {
    index: number;
    position: [number, number];
    uv: [number, number];
    boneIndices: [number, number, number, number];
    boneWeights: [number, number, number, number];
  };
}

export class EngineBridge {
  constructor(
    private readonly server: EnginePipeServer,
    readonly store: BlueprintStore = new BlueprintStore(),
  ) {
    server.on("session", (session: EngineSession) => {
      void this.rehydrate(session);
    });
  }

  get isEngineConnected(): boolean {
    return this.server.currentSession !== undefined;
  }

  /** Define o esqueleto no AST e o inicializa na engine conectada (se houver). */
  async initializeSkeleton(skeleton: SkeletonBlueprint): Promise<SkeletonInitializeResult> {
    this.store.apply({ kind: "skeleton/define", skeleton });
    const session = this.server.currentSession;
    if (!session) {
      return { skeletonId: skeleton.skeletonId, boneCount: skeleton.bones.length, status: "initialized" };
    }
    return session.peer.request<SkeletonInitializeResult>("skeleton/initialize", {
      skeletonId: skeleton.skeletonId,
      bones: skeleton.bones,
    });
  }

  /** Registra o bind de shared memory no AST e o aplica na engine conectada. */
  async bindMeshSharedMemory(binding: MeshBinding): Promise<MeshBindResult> {
    this.store.apply({ kind: "mesh/bind", binding });
    const session = this.server.currentSession;
    if (!session) {
      return { meshId: binding.meshId, status: "deferred" };
    }
    return session.peer.request<MeshBindResult>("mesh/bind_shared_memory", binding);
  }

  /**
   * Inspeção de diagnóstico do plano de dados: snapshot estável, checksum
   * FNV-1a e amostra de vértice lidos pela engine do buffer compartilhado.
   */
  async inspectMesh(meshId: string, sampleIndex = 0): Promise<MeshInspectResult> {
    const session = this.requireSession();
    return session.peer.request<MeshInspectResult>("mesh/inspect", { meshId, sampleIndex });
  }

  /** Round-trip de vitalidade middleware → engine. */
  async pingEngine(payload: string): Promise<PingResult> {
    const session = this.requireSession();
    return session.peer.request<PingResult>("engine/ping", {
      payload,
      sentAtUnixMs: Date.now(),
    });
  }

  /** Reenvia o AST inteiro para uma sessão recém-conectada. */
  private async rehydrate(session: EngineSession): Promise<void> {
    for (const skeleton of this.store.listSkeletons()) {
      await session.peer.request("skeleton/initialize", {
        skeletonId: skeleton.skeletonId,
        bones: skeleton.bones,
      });
    }
    for (const binding of this.store.listMeshes()) {
      await session.peer.request("mesh/bind_shared_memory", binding);
    }
  }

  private requireSession(): EngineSession {
    const session = this.server.currentSession;
    if (!session) {
      throw new Error("No engine session is connected");
    }
    return session;
  }
}
