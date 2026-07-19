/**
 * Fachada MCP (Model Context Protocol) do middleware.
 *
 * Expõe as capacidades do ecossistema a agentes de IA via transporte stdio.
 * Cada ferramenta é uma casca fina sobre o mesmo barramento de comandos
 * usado pelo canal JSON-RPC da engine — nenhuma lógica de domínio vive aqui.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AssetPipelineService } from "../assets/AssetPipelineService.js";
import type { ArtifactStore } from "../canonical/ArtifactStore.js";
import type { EditorSurface } from "../canonical/EditorSurface.js";
import type { HookBus } from "../canonical/HookBus.js";
import { COMMAND_KINDS, reshapeCommand } from "../canonical/commandShape.js";
import type { CapabilityRegistry } from "../domain/CapabilityRegistry.js";
import type { EngineBridge } from "../domain/EngineBridge.js";
import type { EnginePipeServer } from "../ipc/EnginePipeServer.js";
import type { ExperienceGovernor } from "../runtime/ExperienceGovernor.js";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.js";
import type { RuntimeProfileRegistry } from "../runtime/RuntimeProfile.js";

/** Camada canônica opcional exposta às ferramentas MCP. */
export interface CanonicalServices {
  /** Mesma porta de aplicação usada pelos gateways JSON-RPC/GraphQL/gRPC. */
  surface: EditorSurface;
  artifacts: ArtifactStore;
  hooks: HookBus;
  profiles: RuntimeProfileRegistry;
  governor: ExperienceGovernor;
  adapter: RuntimeAdapter;
  /** Presente quando o middleware roda com --assets <dir>. */
  assets?: AssetPipelineService;
}

/** Remove chaves undefined (zod .optional() ⇄ exactOptionalPropertyTypes). */
type StripUndefined<T> = { [K in keyof T]: Exclude<T[K], undefined> };
function stripUndefined<T extends Record<string, unknown>>(obj: T): StripUndefined<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as StripUndefined<T>;
}

const boneSchema = z.object({
  id: z.number().int().nonnegative(),
  parentId: z.number().int().min(-1),
  inverseBindMatrix: z.array(z.number()).length(6),
});

export function createMcpServer(
  bridge: EngineBridge,
  pipeServer: EnginePipeServer,
  capabilities?: CapabilityRegistry,
  canonical?: CanonicalServices,
): McpServer {
  const server = new McpServer({
    name: "p7m-middleware",
    version: "0.1.0",
  });

  server.registerTool(
    "engine_status",
    {
      description:
        "Retorna o estado da conexão com a engine MonoGame e um resumo do blueprint (esqueletos e malhas registrados).",
      inputSchema: {},
    },
    async () => {
      const session = pipeServer.currentSession;
      const project = canonical?.surface.projectStatus();
      let skeletons: unknown[] = [];
      let meshes: unknown[] = [];
      if (project?.active) {
        skeletons = (canonical!.surface.query("skeletons").skeletons as Array<{ skeletonId: string; bones: unknown[] }>).map((s) => ({
          skeletonId: s.skeletonId,
          boneCount: s.bones.length,
        }));
        meshes = canonical!.surface.query("meshes").meshes as unknown[];
      } else if (!canonical) {
        // Compatibilidade para drivers isolados que ainda constroem apenas o bridge.
        skeletons = bridge.store.listSkeletons().map((s) => ({
          skeletonId: s.skeletonId,
          boneCount: s.bones.length,
        }));
        meshes = [...bridge.store.listMeshes()];
      }
      const status = {
        engineConnected: session !== undefined,
        session: session
          ? {
              sessionId: session.sessionId,
              clientName: session.clientName,
              clientVersion: session.clientVersion,
              connectedAtUnixMs: session.connectedAtUnixMs,
            }
          : null,
        project: project ?? null,
        skeletons,
        meshes,
      };
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.registerTool(
    "engine_ping",
    {
      description: "Executa um round-trip JSON-RPC middleware → engine para verificar a vitalidade do canal IPC.",
      inputSchema: { payload: z.string().max(4096) },
    },
    async ({ payload }) => {
      const result = await bridge.pingEngine(payload);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "camera_shake",
    {
      description: "Aplica um impulso de trauma (0..1] ao screen shake procedural da câmera viva (efeito efêmero — não pertence ao blueprint).",
      inputSchema: { trauma: z.number().gt(0).max(1) },
    },
    async ({ trauma }) => {
      const result = await bridge.triggerShake(trauma);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "camera_simulate",
    {
      description:
        "Simula a câmera deterministicamente na engine (preview do editor): N passos em direção a um alvo, retornando trajetória amostrada, posição final e magnitude do shake. Não perturba a câmera viva.",
      inputSchema: {
        steps: z.number().int().min(1).max(100000),
        deltaSeconds: z.number().positive().max(1),
        target: z.tuple([z.number(), z.number()]),
        targetVelocity: z.tuple([z.number(), z.number()]).optional(),
        initial: z.tuple([z.number(), z.number()]).optional(),
        trauma: z.number().min(0).max(1).optional(),
      },
    },
    async (params) => {
      const result = await bridge.simulateCamera(stripUndefined(params));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "lighting_inspect",
    {
      description:
        "Lista as luzes ativas na engine e avalia opcionalmente a iluminação acumulada em um ponto (mesma equação dos shaders — referência de CPU).",
      inputSchema: {
        surface: z.tuple([z.number(), z.number()]).optional(),
        normal: z.tuple([z.number(), z.number(), z.number()]).optional(),
      },
    },
    async ({ surface, normal }) => {
      const inspect = await bridge.inspectLighting();
      const evaluated =
        surface && normal ? await bridge.evaluateLighting(surface, normal) : undefined;
      return {
        content: [{ type: "text", text: JSON.stringify({ ...inspect, ...(evaluated ?? {}) }) }],
      };
    },
  );

  if (capabilities) {
    server.registerTool(
      "engine_capabilities",
      {
        description:
          "Manifesto de capacidades publicado pela engine via engine/describe: limites reais dos subsistemas, layouts binários de vértice derivados por reflexão das structs C# e features disponíveis/planejadas.",
        inputSchema: {},
      },
      async () => {
        const manifest = capabilities.manifest;
        return {
          content: [
            {
              type: "text",
              text: manifest
                ? JSON.stringify(manifest, null, 2)
                : "No engine manifest cached yet (engine not connected or describe pending).",
            },
          ],
        };
      },
    );

    server.registerTool(
      "editor_concepts",
      {
        description:
          "Projeção do manifesto da engine orientada à edição visual: painéis, gizmos, tipos de nó e propriedades editáveis que o editor Electron deve materializar por subsistema (incluindo subsistemas 'planned' com a fase prevista).",
        inputSchema: {},
      },
      async () => ({
        content: [{ type: "text", text: JSON.stringify(capabilities.editorConcepts(), null, 2) }],
      }),
    );

    server.registerTool(
      "mesh_inspect",
      {
        description:
          "Pede à engine um snapshot estável (seqlock) da malha mapeada em shared memory: checksum FNV-1a, frameIndex e amostra de vértice — prova de compatibilidade binária do plano de dados.",
        inputSchema: {
          meshId: z.string().min(1),
          sampleIndex: z.number().int().nonnegative().optional(),
        },
      },
      async ({ meshId, sampleIndex }) => {
        const result = await bridge.inspectMesh(meshId, sampleIndex ?? 0);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );
  }

  if (canonical) {
    registerCanonicalTools(server, canonical);
  }

  return server;
}

function registerCanonicalTools(server: McpServer, canonical: CanonicalServices): void {
  /** Registra uma ferramenta tipada que despacha pelo caminho canônico. */
  const dispatchTool = (
    name: string,
    kind: Parameters<typeof reshapeCommand>[0],
    description: string,
    inputSchema: Record<string, z.ZodTypeAny>,
  ): void => {
    server.registerTool(name, { description, inputSchema }, async (payload) => {
      const normalized = stripUndefined(payload as Record<string, unknown>);
      const result = await canonical.surface.dispatchByKind(kind, normalized);
      return { content: [{ type: "text", text: jsonText(result) }] };
    });
  };

  server.registerTool(
    "blueprint_command",
    {
      description:
        `Despacha um comando canônico do Blueprint pelo MESMO caminho validado da UI: filters → validação/AST → evento → actions → projeção no runtime. kinds: ${COMMAND_KINDS.join(", ")}. O payload segue o shape do comando (sem o campo kind).`,
      inputSchema: {
        kind: z.enum(COMMAND_KINDS as unknown as [string, ...string[]]),
        payload: z.record(z.unknown()),
      },
    },
    async ({ kind, payload }) => {
      const result = await canonical.surface.dispatchByKind(kind, payload);
      return { content: [{ type: "text", text: jsonText(result) }] };
    },
  );

  server.registerTool(
    "project_status",
    {
      description: "Retorna a identidade, sequência e estado de runtime da sessão de projeto ativa.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: jsonText(canonical.surface.projectStatus()) }],
    }),
  );

  server.registerTool(
    "project_create",
    {
      description: "Cria e ativa atomicamente uma sessão vazia ou baseada em template.",
      inputSchema: {
        projectId: z.string().min(1).optional(),
        templateId: z.string().min(1).optional(),
        expectedProjectSessionId: z.string().min(1).optional(),
        expectedCommandSequence: z.string().regex(/^(0|[1-9][0-9]*)$/u).optional(),
      },
    },
    async ({ projectId, templateId, expectedProjectSessionId, expectedCommandSequence }) => ({
      content: [{
        type: "text",
        text: jsonText(await canonical.surface.projectCreate(
          projectId,
          templateId,
          expectedProjectSessionId,
          expectedCommandSequence,
        )),
      }],
    }),
  );

  server.registerTool(
    "project_open_document",
    {
      description: "Valida e prepara um BlueprintDocument fora da sessão ativa antes da troca atômica.",
      inputSchema: {
        document: z.record(z.unknown()),
        expectedProjectSessionId: z.string().min(1).optional(),
        expectedCommandSequence: z.string().regex(/^(0|[1-9][0-9]*)$/u).optional(),
      },
    },
    async ({ document, expectedProjectSessionId, expectedCommandSequence }) => ({
      content: [{
        type: "text",
        text: jsonText(await canonical.surface.projectOpenDocument(
          document,
          expectedProjectSessionId,
          expectedCommandSequence,
        )),
      }],
    }),
  );

  server.registerTool(
    "project_close",
    {
      description: "Fecha a sessão ativa, opcionalmente protegida por identidade esperada.",
      inputSchema: {
        expectedProjectSessionId: z.string().min(1).optional(),
        expectedCommandSequence: z.string().regex(/^(0|[1-9][0-9]*)$/u).optional(),
      },
    },
    async ({ expectedProjectSessionId, expectedCommandSequence }) => ({
      content: [{
        type: "text",
        text: jsonText(await canonical.surface.projectClose(
          expectedProjectSessionId,
          expectedCommandSequence,
        )),
      }],
    }),
  );

  dispatchTool(
    "skeleton_initialize",
    "skeleton/define",
    "Define um esqueleto 2D no blueprint e o projeta na engine. inverseBindMatrix é uma matriz afim 2D coluna-maior com 6 floats.",
    {
      skeletonId: z.string().min(1),
      bones: z.array(boneSchema).min(1).max(256),
    },
  );

  dispatchTool(
    "mesh_bind_shared_memory",
    "mesh/bind",
    "Registra o bind de um memory-mapped file de vértices para uma malha esqueletizada e o projeta na engine.",
    {
      meshId: z.string().min(1),
      skeletonId: z.string().min(1),
      sharedMemoryMapName: z.string().min(1),
      vertexCount: z.number().int().positive(),
      strideInBytes: z.number().int().min(4),
    },
  );

  dispatchTool(
    "camera_configure",
    "camera/configure",
    "Configura a câmera cinemática (massa-mola-amortecedor de segunda ordem) no blueprint e na engine: frequency (Hz), damping (ζ), response, anticipationSeconds e parâmetros do shake.",
    {
      frequency: z.number().positive().optional(),
      damping: z.number().nonnegative().optional(),
      response: z.number().optional(),
      anticipationSeconds: z.number().nonnegative().optional(),
      shakeFrequencyHz: z.number().positive().optional(),
      shakeMaxOffset: z.number().nonnegative().optional(),
      shakeTraumaDecayPerSecond: z.number().positive().optional(),
    },
  );

  dispatchTool(
    "light_add",
    "light/add",
    "Adiciona uma luz ao pipeline deferred 2D (direcional, pontual ou spot) no blueprint, projetada na engine. Cones de spot em graus (ângulo total).",
    {
      lightId: z.string().min(1),
      type: z.enum(["directional", "point", "spot"]),
      position: z.tuple([z.number(), z.number()]).optional(),
      height: z.number().optional(),
      direction: z.tuple([z.number(), z.number()]).optional(),
      color: z.tuple([z.number(), z.number(), z.number()]),
      intensity: z.number().positive(),
      radius: z.number().positive().optional(),
      innerConeDegrees: z.number().positive().optional(),
      outerConeDegrees: z.number().positive().optional(),
    },
  );

  dispatchTool(
    "light_remove",
    "light/remove",
    "Remove uma luz do blueprint (e da engine, via projeção) pelo lightId do blueprint.",
    { lightId: z.string().min(1) },
  );

  dispatchTool(
    "level_define",
    "level/define",
    "Define um nível no blueprint (IntGrid de significado + regras de auto-tiling). Na projeção, o adapter resolve as regras deterministicamente (seed) e envia os tiles prontos ao runtime.",
    {
      levelId: z.string().min(1),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      tileSize: z.number().int().min(1),
      seed: z.number().int(),
      intGrid: z.array(z.number().int().min(0)),
      rules: z.array(
        z.object({
          name: z.string().optional(),
          patternSize: z.union([z.literal(1), z.literal(3), z.literal(5)]),
          pattern: z.array(z.union([z.number(), z.null()])),
          tileIds: z.array(z.number().int()).min(1),
          chance: z.number().gt(0).max(1).optional(),
        }),
      ),
    },
  );

  dispatchTool(
    "level_update",
    "level/update",
    "Substitui um nível existente no blueprint (edição incremental do IntGrid/regras). Na projeção, o tilemap é removido e redefinido com os tiles re-resolvidos — mesma semântica determinística do define.",
    {
      levelId: z.string().min(1),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      tileSize: z.number().int().min(1),
      seed: z.number().int(),
      intGrid: z.array(z.number().int().min(0)),
      rules: z.array(
        z.object({
          name: z.string().optional(),
          patternSize: z.union([z.literal(1), z.literal(3), z.literal(5)]),
          pattern: z.array(z.union([z.number(), z.null()])),
          tileIds: z.array(z.number().int()).min(1),
          chance: z.number().gt(0).max(1).optional(),
        }),
      ),
    },
  );

  dispatchTool(
    "level_remove",
    "level/remove",
    "Remove um nível do blueprint (e o tilemap correspondente da engine, via projeção).",
    { levelId: z.string().min(1) },
  );

  dispatchTool(
    "entitydef_define",
    "entitydef/define",
    "Define um tipo de entidade (campos tipados com defaults). Com archetypeId, as instâncias viram atores vivos no runtime (spawn table); sem, são puramente editoriais.",
    {
      entityDefId: z.string().min(1),
      archetypeId: z.string().min(1).optional(),
      fields: z.array(
        z.object({
          name: z.string().min(1),
          type: z.enum(["int", "float", "bool", "string", "enum", "point", "color"]),
          default: z.unknown().optional(),
          options: z.array(z.string()).optional(),
        }),
      ),
      tags: z.array(z.string()).optional(),
    },
  );

  dispatchTool(
    "entity_place",
    "entity/place",
    "Instancia uma entidade em posição do mundo (pixels). Se a definição tem archetypeId, projeta entity/spawn no runtime — o entityId é a referência estável editor↔runtime.",
    {
      entityId: z.string().min(1),
      entityDefId: z.string().min(1),
      position: z.tuple([z.number(), z.number()]),
      fields: z.record(z.string(), z.unknown()).optional(),
    },
  );

  dispatchTool(
    "entity_move",
    "entity/move",
    "Move uma entidade já colocada (live edit): reposiciona o ator vivo no runtime sem respawn.",
    {
      entityId: z.string().min(1),
      position: z.tuple([z.number(), z.number()]),
    },
  );

  dispatchTool(
    "entity_remove",
    "entity/remove",
    "Remove uma instância de entidade (e despawna o ator no runtime, se spawnado).",
    { entityId: z.string().min(1) },
  );

  dispatchTool(
    "world_place",
    "world/place",
    "Posiciona um nível já definido no world map (coordenadas em pixels; sobreposições são rejeitadas; re-posicionar substitui). Vizinhanças por borda ficam consultáveis via blueprint/query world.",
    {
      levelId: z.string().min(1),
      x: z.number(),
      y: z.number(),
    },
  );

  dispatchTool(
    "world_unplace",
    "world/unplace",
    "Remove um nível do world map (o nível continua definido no blueprint).",
    { levelId: z.string().min(1) },
  );

  if (canonical.assets) {
    const assets = canonical.assets;
    server.registerTool(
      "asset_ingest",
      {
        description:
          "Processa um arquivo .aseprite do catálogo: exporta via CLI (spritesheet + frameTags/slices), normaliza no pipeline canônico (artefato sprite-document versionável com tags derivadas dos diretórios) e compila o spritesheet para .xnb via MGCB.",
        inputSchema: { path: z.string().min(1) },
      },
      async ({ path: filePath }) => {
        const result = await assets.ingest(filePath);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );

    server.registerTool(
      "asset_catalog",
      {
        description:
          "Catálogo taxonômico de sprites: últimas revisões dos artefatos sprite-document, filtráveis por tag (tags derivam da estrutura de diretórios do catálogo).",
        inputSchema: { tag: z.string().min(1).optional() },
      },
      async ({ tag }) => {
        const entries = assets.catalog(canonical.artifacts.list("sprite-document"), tag).map((e) => ({
          artifactId: e.artifactId,
          revision: e.revision,
          contentHash: e.contentHash,
          tags: e.metadata.tags ?? [],
          source: e.metadata.source,
        }));
        return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
      },
    );
  }

  server.registerTool(
    "runtime_experience",
    {
      description:
        "Resolve a governança da experiência para uma família+versão de runtime: perfil aplicado, capabilities, constraints e a matriz de decisões por recurso da ferramenta visual (com razões). Omita family/version para usar a identidade do runtime conectado.",
      inputSchema: {
        family: z.string().min(1).optional(),
        version: z.string().regex(/^\d+\.\d+(\.\d+)?$/).optional(),
      },
    },
    async ({ family, version }) => {
      const identity = canonical.adapter.identify();
      const resolved = canonical.governor.resolve(
        family ?? identity?.family ?? canonical.adapter.family,
        version ?? identity?.version ?? "999.0.0",
      );
      return { content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] };
    },
  );

  server.registerTool(
    "runtime_profiles",
    {
      description: "Lista as famílias de runtime conhecidas e as versões de perfil registradas para cada uma.",
      inputSchema: {},
    },
    async () => {
      const families = canonical.profiles.families().map((family) => ({
        family,
        versions: canonical.profiles.versionsOf(family),
      }));
      return { content: [{ type: "text", text: JSON.stringify(families, null, 2) }] };
    },
  );

  server.registerTool(
    "artifact_get",
    {
      description:
        "Consulta artefatos versionáveis do modelo canônico. Sem artifactId lista as últimas revisões (opcionalmente por kind); com artifactId retorna a revisão pedida (ou a última) e o histórico de hashes.",
      inputSchema: {
        artifactId: z.string().min(1).optional(),
        kind: z.string().min(1).optional(),
        revision: z.number().int().positive().optional(),
      },
    },
    async ({ artifactId, kind, revision }) => {
      if (artifactId === undefined) {
        return {
          content: [{ type: "text", text: JSON.stringify(canonical.artifacts.list(kind), null, 2) }],
        };
      }
      const envelope = canonical.artifacts.get(artifactId, revision);
      const history = canonical.artifacts
        .history(artifactId)
        .map((e) => ({ revision: e.revision, contentHash: e.contentHash, createdBy: e.metadata.createdBy }));
      return {
        content: [{ type: "text", text: JSON.stringify({ envelope: envelope ?? null, history }, null, 2) }],
      };
    },
  );

  server.registerTool(
    "hooks_list",
    {
      description:
        "Inventário dos pontos de extensão do modelo canônico (actions e filters registrados, com prioridades) — descoberta de integração para agentes.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(canonical.hooks.listHooks(), null, 2) }],
    }),
  );
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export async function startMcpStdio(
  bridge: EngineBridge,
  pipeServer: EnginePipeServer,
  capabilities?: CapabilityRegistry,
  canonical?: CanonicalServices,
): Promise<McpServer> {
  const server = createMcpServer(bridge, pipeServer, capabilities, canonical);
  await server.connect(new StdioServerTransport());
  return server;
}
