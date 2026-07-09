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
import type { BlueprintEvent, LightSpec } from "../domain/BlueprintStore.js";
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
      case "skeletonDefined":
        await peer.request("skeleton/initialize", {
          skeletonId: event.skeleton.skeletonId,
          bones: event.skeleton.bones,
        });
        return { event: event.kind, status: "projected" };

      case "meshBound":
        await peer.request("mesh/bind_shared_memory", event.binding);
        return { event: event.kind, status: "projected" };

      case "cameraConfigured":
        await peer.request("camera/configure", event.settings);
        return { event: event.kind, status: "projected" };

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
