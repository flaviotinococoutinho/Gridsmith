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
  type CameraSettings,
  type LightSpec,
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
  /** lightId do blueprint (string) → lightId da engine (slot) na sessão corrente. */
  private readonly engineLightIds = new Map<string, number>();

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

  /** Aplica configuração parcial de câmera ao AST e à engine conectada. */
  async configureCamera(settings: CameraSettings): Promise<CameraSettings> {
    this.store.apply({ kind: "camera/configure", settings });
    const session = this.server.currentSession;
    if (!session) {
      return this.store.cameraSettings;
    }
    return session.peer.request<CameraSettings>("camera/configure", this.store.cameraSettings);
  }

  /** Impulso transiente de screen shake (não entra no AST — é efêmero). */
  async triggerShake(trauma: number): Promise<{ trauma: number }> {
    const session = this.requireSession();
    return session.peer.request<{ trauma: number }>("camera/shake", { trauma });
  }

  /** Simulação determinística da câmera na engine (preview para o editor). */
  async simulateCamera(params: CameraSimulateParams): Promise<CameraSimulateResult> {
    const session = this.requireSession();
    return session.peer.request<CameraSimulateResult>("camera/simulate", params);
  }

  /** Adiciona uma luz ao AST e à engine; mantém o mapeamento de ids. */
  async addLight(light: LightSpec): Promise<{ lightId: string; engineLightId?: number }> {
    this.store.apply({ kind: "light/add", light });
    const session = this.server.currentSession;
    if (!session) {
      return { lightId: light.lightId };
    }
    const { lightId: engineLightId } = await session.peer.request<{ lightId: number }>(
      "lighting/add",
      toEngineLightParams(light),
    );
    this.engineLightIds.set(light.lightId, engineLightId);
    return { lightId: light.lightId, engineLightId };
  }

  async removeLight(lightId: string): Promise<void> {
    this.store.apply({ kind: "light/remove", lightId });
    const session = this.server.currentSession;
    const engineLightId = this.engineLightIds.get(lightId);
    this.engineLightIds.delete(lightId);
    if (session && engineLightId !== undefined) {
      await session.peer.request("lighting/remove", { lightId: engineLightId });
    }
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

    const camera = this.store.cameraSettings;
    if (Object.keys(camera).length > 0) {
      await session.peer.request("camera/configure", camera);
    }

    // Luzes ganham ids novos na engine nova — remapeia.
    this.engineLightIds.clear();
    for (const light of this.store.listLights()) {
      const { lightId: engineLightId } = await session.peer.request<{ lightId: number }>(
        "lighting/add",
        toEngineLightParams(light),
      );
      this.engineLightIds.set(light.lightId, engineLightId);
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

/** Converte a LightSpec do blueprint para os params do método lighting/add. */
function toEngineLightParams(light: LightSpec): Record<string, unknown> {
  return {
    type: light.type,
    ...(light.position !== undefined ? { position: light.position } : {}),
    ...(light.height !== undefined ? { height: light.height } : {}),
    ...(light.direction !== undefined ? { direction: light.direction } : {}),
    color: light.color,
    intensity: light.intensity,
    ...(light.radius !== undefined ? { radius: light.radius } : {}),
    ...(light.innerConeDegrees !== undefined ? { innerConeDegrees: light.innerConeDegrees } : {}),
    ...(light.outerConeDegrees !== undefined ? { outerConeDegrees: light.outerConeDegrees } : {}),
  };
}
