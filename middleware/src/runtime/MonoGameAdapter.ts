/**
 * Adapter MonoGame (docs/CANONICAL-MODEL.md §2): projeta eventos canônicos
 * nos métodos JSON-RPC da engine Gridsmith/MonoGame.
 *
 * O adapter conhece o runtime; o modelo canônico não. Instâncias de entidade
 * cuja definição tem archetypeId viram atores vivos (spawn table, ALPHA-0.1
 * P0.6); eventos puramente editoriais são pulados com razão registrada.
 */

import type { EnginePipeServer, EngineSession } from "../ipc/EnginePipeServer.js";
import type { CapabilityRegistry } from "../domain/CapabilityRegistry.js";
import type { BlueprintEvent, BlueprintStore, LevelSpec, LightSpec } from "../domain/BlueprintStore.js";
import { resolveAutoTiles } from "../leveldesign/AutoTiler.js";
import type {
  ProjectionResult,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeSessionEpoch,
  RuntimeSessionResetResult,
} from "./RuntimeAdapter.js";
import { RuntimeSessionSupersededError } from "./RuntimeAdapter.js";

export class MonoGameAdapter implements RuntimeAdapter {
  readonly family = "monogame";

  /** lightId canônico (string) → lightId da engine (slot) na sessão corrente. */
  private readonly engineLightIds = new Map<string, number>();

  /** entityIds spawnados como atores na sessão corrente (referência estável editor↔runtime). */
  private readonly spawnedEntityIds = new Set<string>();

  constructor(
    private readonly server: EnginePipeServer,
    private readonly capabilities: CapabilityRegistry,
  ) {
    // sessão nova = engine nova: slots de luz e atores anteriores não existem mais
    server.on("session", () => this.resetLocalSessionIndexes());
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

  async resetSession(): Promise<RuntimeSessionResetResult> {
    const runtimeSessionEpoch = this.server.currentRuntimeSessionEpoch;
    const session = this.sessionAtEpoch(runtimeSessionEpoch);
    if (!session) {
      // A sessão da engine que conhecia estes ids já não existe. Limpar os
      // índices locais impede que uma futura reconexão herde referências.
      this.resetLocalSessionIndexes();
      this.assertEpoch(runtimeSessionEpoch);
      return {
        status: "deferred",
        runtimeSessionEpoch,
        reason: "no engine session connected; reset will be implicit on the next engine session",
      };
    }

    const detail = await this.requestAtEpoch<{ status?: unknown }>(
      session,
      runtimeSessionEpoch,
      "engine/reset_session",
      {},
    );
    if (detail.status !== "reset") {
      throw new Error(`engine/reset_session returned an invalid acknowledgement`);
    }
    this.resetLocalSessionIndexes();
    this.assertEpoch(runtimeSessionEpoch, session);
    return { status: "reset", runtimeSessionEpoch, detail };
  }

  async project(
    event: BlueprintEvent,
    expectedRuntimeSessionEpoch = this.server.currentRuntimeSessionEpoch,
  ): Promise<ProjectionResult> {
    const session = this.sessionAtEpoch(expectedRuntimeSessionEpoch);
    if (!session) {
      return { event: event.kind, status: "deferred", reason: "no engine session connected" };
    }

    switch (event.kind) {
      case "skeletonDefined": {
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "skeleton/initialize",
          {
            skeletonId: event.skeleton.skeletonId,
            bones: event.skeleton.bones,
          },
        );
        return { event: event.kind, status: "projected", detail };
      }

      case "meshBound": {
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "mesh/bind_shared_memory",
          event.binding,
        );
        return { event: event.kind, status: "projected", detail };
      }

      case "cameraConfigured": {
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "camera/configure",
          event.settings,
        );
        return { event: event.kind, status: "projected", detail };
      }

      case "lightAdded": {
        const { lightId } = await this.requestAtEpoch<{ lightId: number }>(
          session,
          expectedRuntimeSessionEpoch,
          "lighting/add",
          toEngineLight(event.light),
        );
        this.engineLightIds.set(event.light.lightId, lightId);
        // O slot da engine deixa de morrer no mapa privado: publicá-lo em
        // `detail` é o que permite a um inspector correlacionar a luz canônica
        // com o slot real (e diagnosticar "por que esta luz não acende").
        return {
          event: event.kind,
          status: "projected",
          detail: { lightId: event.light.lightId, engineLightId: lightId },
        };
      }

      case "lightUpdated": {
        // A engine não tem `lighting/update`: o slot é recriado. Fazer isso
        // AQUI, e não no domínio, é o que mantém o comando canônico com
        // inverso exato — no domínio, remover+adicionar mudaria a ordem do
        // documento exportado.
        const previousSlot = this.engineLightIds.get(event.light.lightId);
        if (previousSlot !== undefined) {
          await this.requestAtEpoch(
            session,
            expectedRuntimeSessionEpoch,
            "lighting/remove",
            { lightId: previousSlot },
          );
          this.engineLightIds.delete(event.light.lightId);
        }
        const { lightId } = await this.requestAtEpoch<{ lightId: number }>(
          session,
          expectedRuntimeSessionEpoch,
          "lighting/add",
          toEngineLight(event.light),
        );
        this.engineLightIds.set(event.light.lightId, lightId);
        return {
          event: event.kind,
          status: "projected",
          detail: { lightId: event.light.lightId, engineLightId: lightId },
        };
      }

      case "lightRemoved": {
        const engineLightId = this.engineLightIds.get(event.lightId);
        if (engineLightId === undefined) {
          return {
            event: event.kind,
            status: "skipped",
            reason: `light "${event.lightId}" was never projected onto this session`,
          };
        }
        await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "lighting/remove",
          { lightId: engineLightId },
        );
        // Só altera o índice da sessão depois do ACK do mesmo peer/epoch.
        // Uma falha ou supersession mantém informação suficiente para retry
        // ou para a reidratação integral reparar o runtime.
        this.engineLightIds.delete(event.lightId);
        return { event: event.kind, status: "projected" };
      }

      case "levelDefined": {
        // A resolução do auto-tiling acontece AQUI, na fronteira do runtime:
        // o modelo canônico guarda significado (IntGrid + regras); o MonoGame
        // recebe tiles resolvidos — determinístico por seed.
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "tilemap/define",
          toEngineTilemap(event.level),
        );
        return { event: event.kind, status: "projected", detail };
      }

      case "levelPatched":
      case "levelUpdated": {
        // Edição incremental: a engine não faz diff de tilemaps — remove e
        // redefine com os tiles re-resolvidos (mesma semântica do define).
        await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "tilemap/remove",
          { tilemapId: event.level.levelId },
        );
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "tilemap/define",
          toEngineTilemap(event.level),
        );
        return { event: event.kind, status: "projected", detail };
      }

      case "levelPaletteChanged":
        // A paleta nomeia e colore SIGNIFICADO para o editor; a engine recebe
        // tiles já resolvidos e não conhece nomes. Renomear "Parede" não muda
        // um pixel do jogo — dizer isso é mais honesto do que reenviar o
        // tilemap inteiro fingindo que mudou algo.
        return {
          event: event.kind,
          status: "skipped",
          reason: `palette of "${event.level.levelId}" is editor vocabulary; the runtime consumes resolved tiles`,
        };

      case "levelRemoved":
        await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "tilemap/remove",
          { tilemapId: event.levelId },
        );
        return { event: event.kind, status: "projected" };

      case "entityDefDefined":
      case "entityDefUpdated":
      case "entityDefRemoved":
        return {
          event: event.kind,
          status: "skipped",
          // A definição sempre foi editorial, e continua: quem materializa é a
          // INSTÂNCIA. Desde que o sprite atravessa o fio, dizer aqui que "o
          // runtime não desenha" seria mentira — ele desenha, quando a
          // entidade é posicionada. A razão aponta para onde a arte de fato
          // viaja, em vez de sugerir que ela ficou pelo caminho.
          reason:
            (event as { definition?: { sprite?: unknown } }).definition?.sprite !== undefined
              ? "entity definitions are editorial; the sprite travels to the runtime when an instance is placed"
              : "entity definitions are editorial; instances with archetypeId spawn actors",
        };

      case "tilesetDefined": {
        // A tabela do atlas atravessa o fio como está — quatro números e uma
        // referência de imagem; a REGIÃO de cada tile é fórmula nos dois
        // lados, nunca dado transmitido.
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "tileset/apply",
          {
            tilesetId: event.tileset.tilesetId,
            image: event.tileset.image,
            tileSize: event.tileset.tileSize,
            columns: event.tileset.columns,
            tileCount: event.tileset.tileCount,
          },
        );
        return { event: event.kind, status: "projected", detail };
      }

      case "tilesetRemoved": {
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "tileset/clear",
          { tilesetId: event.tilesetId },
        );
        return { event: event.kind, status: "projected", detail };
      }

      case "entityPropertiesChanged":
        // Os campos tipados ainda não atravessam o fio — o spawn leva apenas
        // (entityId, archetypeId, position). Enquanto for assim, a razão diz
        // exatamente o que falta em vez de fingir que aplicou.
        return {
          event: event.kind,
          status: "skipped",
          reason:
            `fields of "${event.entity.entityId}" are editorial: the runtime spawn contract ` +
            `carries only archetype and position`,
        };

      case "entityPlaced": {
        // Spawn table (ALPHA-0.1 P0.6): só definições com archetypeId viram
        // atores vivos; sem archetype a entidade é editorial — com razão
        // acionável para o painel de diagnósticos.
        if (event.archetypeId === undefined) {
          return {
            event: event.kind,
            status: "skipped",
            reason: `entity "${event.entity.entityId}" has no archetypeId in its definition — set one to spawn it in the runtime`,
          };
        }
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "entity/spawn",
          {
            entityId: event.entity.entityId,
            archetypeId: event.archetypeId,
            position: event.entity.position,
            ...spriteParams(event.sprite),
          },
        );
        this.spawnedEntityIds.add(event.entity.entityId);
        return { event: event.kind, status: "projected", detail };
      }

      case "entityMoved": {
        if (event.archetypeId === undefined) {
          return {
            event: event.kind,
            status: "skipped",
            reason: `entity "${event.entity.entityId}" has no archetypeId in its definition — set one to spawn it in the runtime`,
          };
        }
        // sessão que perdeu o spawn (ex.: reconexão): mover vira upsert
        if (!this.spawnedEntityIds.has(event.entity.entityId)) {
          const detail = await this.requestAtEpoch(
            session,
            expectedRuntimeSessionEpoch,
            "entity/spawn",
            {
              entityId: event.entity.entityId,
              archetypeId: event.archetypeId,
              position: event.entity.position,
              ...spriteParams(event.sprite),
            },
          );
          this.spawnedEntityIds.add(event.entity.entityId);
          return { event: event.kind, status: "projected", detail };
        }
        const detail = await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "entity/move",
          {
            entityId: event.entity.entityId,
            position: event.entity.position,
          },
        );
        return { event: event.kind, status: "projected", detail };
      }

      case "entityRemoved": {
        if (!this.spawnedEntityIds.has(event.entityId)) {
          return {
            event: event.kind,
            status: "skipped",
            reason: `entity "${event.entityId}" was never spawned onto this session`,
          };
        }
        await this.requestAtEpoch(
          session,
          expectedRuntimeSessionEpoch,
          "entity/despawn",
          { entityId: event.entityId },
        );
        this.spawnedEntityIds.delete(event.entityId);
        return { event: event.kind, status: "projected" };
      }

      case "worldLevelPlaced":
      case "worldLevelUnplaced":
        return {
          event: event.kind,
          status: "skipped",
          reason: "world layout is editorial until level streaming lands (phase 5)",
        };
    }
  }

  /**
   * Reidrata uma engine recém-conectada projetando o Blueprint inteiro, na
   * ordem de dependência (esqueletos → malhas → câmera → luzes → níveis →
   * entidades).
   * O adapter é o ÚNICO dono da projeção — inclusive na reconexão.
   */
  async rehydrateFrom(
    store: BlueprintStore,
    expectedRuntimeSessionEpoch = this.server.currentRuntimeSessionEpoch,
  ): Promise<readonly ProjectionResult[]> {
    this.assertEpoch(expectedRuntimeSessionEpoch);
    const results: ProjectionResult[] = [];
    const projectAll = async (events: BlueprintEvent[]): Promise<void> => {
      for (const event of events) {
        results.push(await this.project(event, expectedRuntimeSessionEpoch));
      }
    };

    await projectAll(store.listSkeletons().map((skeleton) => ({ kind: "skeletonDefined", skeleton })));
    await projectAll(store.listMeshes().map((binding) => ({ kind: "meshBound", binding })));
    if (Object.keys(store.cameraSettings).length > 0) {
      await projectAll([{ kind: "cameraConfigured", settings: store.cameraSettings }]);
    }
    await projectAll(store.listLights().map((light) => ({ kind: "lightAdded", light })));
    await projectAll(store.listLevels().map((level) => ({ kind: "levelDefined", level })));
    await projectAll(
      store.listEntities().map((entity) => {
        const archetypeId = store.getEntityDef(entity.entityDefId)?.archetypeId;
        return {
          kind: "entityPlaced",
          entity,
          ...(archetypeId !== undefined ? { archetypeId } : {}),
        };
      }),
    );
    this.assertEpoch(expectedRuntimeSessionEpoch);
    return results;
  }

  private sessionAtEpoch(expectedRuntimeSessionEpoch: RuntimeSessionEpoch): EngineSession | undefined {
    this.assertEpoch(expectedRuntimeSessionEpoch);
    const session = this.server.currentSession;
    if (
      session !== undefined &&
      session.runtimeSessionEpoch !== expectedRuntimeSessionEpoch
    ) {
      throw new RuntimeSessionSupersededError(
        expectedRuntimeSessionEpoch,
        this.server.currentRuntimeSessionEpoch,
      );
    }
    return session;
  }

  /**
   * Toda RPC de projeção fica presa ao mesmo peer e valida a geração tanto
   * antes quanto depois do await. Assim uma supersession nunca mistura B e C
   * dentro do mesmo replay, mesmo que ambas respondam com sucesso.
   */
  private async requestAtEpoch<T = unknown>(
    session: EngineSession,
    expectedRuntimeSessionEpoch: RuntimeSessionEpoch,
    method: string,
    params: unknown,
  ): Promise<T> {
    this.assertEpoch(expectedRuntimeSessionEpoch, session);
    const result = await session.peer.request<T>(method, params);
    this.assertEpoch(expectedRuntimeSessionEpoch, session);
    return result;
  }

  private assertEpoch(
    expectedRuntimeSessionEpoch: RuntimeSessionEpoch,
    expectedSession?: EngineSession,
  ): void {
    const actualRuntimeSessionEpoch = this.server.currentRuntimeSessionEpoch;
    if (
      actualRuntimeSessionEpoch !== expectedRuntimeSessionEpoch ||
      (expectedSession !== undefined && this.server.currentSession !== expectedSession)
    ) {
      throw new RuntimeSessionSupersededError(
        expectedRuntimeSessionEpoch,
        actualRuntimeSessionEpoch,
      );
    }
  }

  private resetLocalSessionIndexes(): void {
    this.engineLightIds.clear();
    this.spawnedEntityIds.clear();
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
    // o vínculo nível→atlas acompanha o tilemap: é ele que diz ao host qual
    // tabela amostrar ao desenhar este mapa
    ...(level.tilesetId === undefined ? {} : { tilesetId: level.tilesetId }),
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

/**
 * Parâmetros do sprite no spawn (documento v6).
 *
 * Ausente vira ausente, não `{tilesetId: null, tileId: -1}`: o store da engine
 * já normaliza a falta de tileset, e mandar campos nulos faria o payload
 * afirmar uma escolha que ninguém fez.
 */
function spriteParams(sprite?: { tilesetId: string; tileId: number }): Record<string, unknown> {
  return sprite === undefined
    ? {}
    : { spriteTilesetId: sprite.tilesetId, spriteTileId: sprite.tileId };
}
