/**
 * Camada de DIAGNÓSTICO da engine MonoGame conectada.
 *
 * Desde a unificação canônica (Fase 4), toda MUTAÇÃO passa pelo
 * CanonicalOrchestrator (filters → AST → actions → projeção via
 * MonoGameAdapter) — inclusive a reidratação na reconexão
 * (MonoGameAdapter.rehydrateFrom). Este bridge expõe apenas operações de
 * leitura/inspeção e utilitários efêmeros que não pertencem ao Blueprint.
 */

import type { EnginePipeServer, EngineSession } from "../ipc/EnginePipeServer.js";
import type { BlueprintStore } from "./BlueprintStore.js";

export interface BlueprintStoreAccessor {
  readonly current: { readonly store: BlueprintStore } | undefined;
}

export interface PingResult {
  echo: string;
  receivedAtUnixMs?: number;
}

export interface CameraSimulateParams {
  steps: number;
  deltaSeconds: number;
  target: [number, number];
  targetVelocity?: [number, number];
  initial?: [number, number];
  trauma?: number;
}

export interface CameraSimulateResult {
  final: [number, number];
  finalVelocity: [number, number];
  samples: [number, number][];
  maxShakeMagnitude: number;
  finalTrauma: number;
}

export interface LightingInspectResult {
  count: number;
  capacity: number;
  lights: Array<{
    lightId: number;
    type: string;
    position: [number, number];
    height: number;
    direction: [number, number];
    color: [number, number, number];
    intensity: number;
    radius: number;
  }>;
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
    private readonly storeSource: BlueprintStore | BlueprintStoreAccessor,
  ) {}

  /** Compatibilidade de diagnóstico; em produção resolve a sessão no acesso. */
  get store(): BlueprintStore {
    if ("apply" in this.storeSource) return this.storeSource;
    const store = this.storeSource.current?.store;
    if (!store) throw new Error("No project session is active");
    return store;
  }

  get isEngineConnected(): boolean {
    return this.server.currentSession !== undefined;
  }

  /** Round-trip de vitalidade middleware → engine. */
  async pingEngine(payload: string): Promise<PingResult> {
    const session = this.requireSession();
    return session.peer.request<PingResult>("engine/ping", {
      payload,
      sentAtUnixMs: Date.now(),
    });
  }

  /** Snapshot estável + checksum + amostra do buffer compartilhado de uma malha. */
  async inspectMesh(meshId: string, sampleIndex = 0): Promise<MeshInspectResult> {
    const session = this.requireSession();
    return session.peer.request<MeshInspectResult>("mesh/inspect", { meshId, sampleIndex });
  }

  /** Simulação determinística da câmera (preview do editor; não muta estado). */
  async simulateCamera(params: CameraSimulateParams): Promise<CameraSimulateResult> {
    const session = this.requireSession();
    return session.peer.request<CameraSimulateResult>("camera/simulate", params);
  }

  /** Impulso transiente de screen shake (efêmero — não pertence ao Blueprint). */
  async triggerShake(trauma: number): Promise<{ trauma: number }> {
    const session = this.requireSession();
    return session.peer.request<{ trauma: number }>("camera/shake", { trauma });
  }

  async inspectLighting(): Promise<LightingInspectResult> {
    const session = this.requireSession();
    return session.peer.request<LightingInspectResult>("lighting/inspect");
  }

  /** Avaliação da equação de luz na engine (mesma fórmula do shader). */
  async evaluateLighting(
    surface: [number, number],
    normal: [number, number, number],
  ): Promise<{ rgb: [number, number, number] }> {
    const session = this.requireSession();
    return session.peer.request<{ rgb: [number, number, number] }>("lighting/evaluate", {
      surface,
      normal,
    });
  }

  private requireSession(): EngineSession {
    const session = this.server.currentSession;
    if (!session) {
      throw new Error("No engine session is connected");
    }
    return session;
  }
}
