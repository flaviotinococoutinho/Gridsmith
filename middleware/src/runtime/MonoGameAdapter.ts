/**
 * Adapter MonoGame (docs/CANONICAL-MODEL.md §2): projeta eventos canônicos
 * nos métodos JSON-RPC da engine P7M/MonoGame.
 *
 * O adapter conhece o runtime; o modelo canônico não. Eventos puramente
 * editoriais hoje (definições/instâncias de entidade) são pulados com razão
 * registrada — viram spawn tables na Fase 4.
 */

import type { EnginePipeServer } from "../ipc/EnginePipeServer.js";
import type { CapabilityRegistry } from "../domain/CapabilityRegistry.js";
import type { BlueprintEvent, BlueprintStore, LevelSpec, LightSpec } from "../domain/BlueprintStore.js";
import { resolveAutoTiles } from "../leveldesign/AutoTiler.js";
import type { ProjectionResult, RuntimeAdapter, RuntimeIdentity } from "./RuntimeAdapter.js";

export class MonoGameAdapter implements RuntimeAdapter {
  readonly family = "monogame";

  /** lightId canônico (string) → lightId da engine (slot) na sessão corrente. */
  private readonly engineLightIds = new Map<string, number>();

  constructor(
    private readonly server: EnginePipeServer,
    private readonly capabilities: CapabilityRegistry,
  ) {
    // sessão nova = engine nova: os slots de luz anteriores não existem mais
    server.on("session", () => this.engineLightIds.clear());
  }

  get isConnected(): boolean {
    return this.server.currentSession !== undefined;
  }

  identify(): RuntimeIdentity | undefined {
    const manifest = this.capabilities.manifest;
    if (!manifest) return undefined;
    const runtime = manifest.engine.runtime;
    return {
      family: runtime?.family ?? this.family,
      version: runtime?.version ?? "0.0.0",
      displayName: `${manifest.engine.name} v${manifest.engine.version}`,
    };
  }

  async project(event: BlueprintEvent): Promise<ProjectionResult> {
    const session = this.server.currentSession;
    if (!session) {
      return { event: event.kind, status: "deferred", reason: "no engine session connected" };
    }
    const peer = session.peer;

    switch (event.kind) {
      case "skeletonDefined": {
        const detail = await peer.request("skeleton/initialize", {
          skeletonId: event.skeleton.skeletonId,
          bones: event.skeleton.bones,
        });
        return { event: event.kind, status: "projected", detail };
      }

      case "meshBound": {
        const detail = await peer.request("mesh/bind_shared_memory", event.binding);
        return { event: event.kind, status: "projected", detail };
      }

      case "cameraConfigured": {
        const detail = await peer.request("camera/configure", event.settings);
        return { event: event.kind, status: "projected", detail };
      }

      case "lightAdded": {
        const { lightId } = await peer.request<{ lightId: number }>(
          "lighting/add",
          toEngineLight(event.light),
        );
        this.engineLightIds.set(event.light.lightId, lightId);
        return { event: event.kind, status: "projected" };
      }

      case "lightRemoved": {
        const engineLightId = this.engineLightIds.get(event.lightId);
        this.engineLightIds.delete(event.lightId);
        if (engineLightId === undefined) {
          return {
            event: event.kind,
            status: "skipped",
            reason: `light "${event.lightId}" was never projected onto this session`,
          };
        }
        await peer.request("lighting/remove", { lightId: engineLightId });
        return { event: event.kind, status: "projected" };
      }

      case "levelDefined": {
        // A resolução do auto-tiling acontece AQUI, na fronteira do runtime:
        // o modelo canônico guarda significado (IntGrid + regras); o MonoGame
        // recebe tiles resolvidos — determinístico por seed.
        const detail = await peer.request("tilemap/define", toEngineTilemap(event.level));
        return { event: event.kind, status: "projected", detail };
      }

      case "levelRemoved":
        await peer.request("tilemap/remove", { tilemapId: event.levelId });
        return { event: event.kind, status: "projected" };

      case "entityDefDefined":
      case "entityPlaced":
      case "entityRemoved":
        return {
          event: event.kind,
          status: "skipped",
          reason: "entity domain is editor-side today; runtime spawn tables land in phase 4",
        };
    }
  }

  /**
   * Reidrata uma engine recém-conectada projetando o Blueprint inteiro, na
   * ordem de dependência (esqueletos → malhas → câmera → luzes → níveis).
   * O adapter é o ÚNICO dono da projeção — inclusive na reconexão.
   */
  async rehydrateFrom(store: BlueprintStore): Promise<ProjectionResult[]> {
    const results: ProjectionResult[] = [];
    const projectAll = async (events: BlueprintEvent[]): Promise<void> => {
      for (const event of events) {
        results.push(await this.project(event));
      }
    };

    await projectAll(store.listSkeletons().map((skeleton) => ({ kind: "skeletonDefined", skeleton })));
    await projectAll(store.listMeshes().map((binding) => ({ kind: "meshBound", binding })));
    if (Object.keys(store.cameraSettings).length > 0) {
      await projectAll([{ kind: "cameraConfigured", settings: store.cameraSettings }]);
    }
    await projectAll(store.listLights().map((light) => ({ kind: "lightAdded", light })));
    await projectAll(store.listLevels().map((level) => ({ kind: "levelDefined", level })));
    return results;
  }
}

function toEngineTilemap(level: LevelSpec): Record<string, unknown> {
  const resolved = resolveAutoTiles(
    { width: level.width, height: level.height, values: level.intGrid },
    level.rules,
    level.seed,
  );
  return {
    tilemapId: level.levelId,
    width: level.width,
    height: level.height,
    tileSize: level.tileSize,
    intGrid: [...level.intGrid],
    tiles: [...resolved.tiles],
  };
}

function toEngineLight(light: LightSpec): Record<string, unknown> {
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
