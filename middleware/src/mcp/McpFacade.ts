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
import type { CapabilityRegistry } from "../domain/CapabilityRegistry.js";
import type { EngineBridge } from "../domain/EngineBridge.js";
import type { EnginePipeServer } from "../ipc/EnginePipeServer.js";

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
        skeletons: bridge.store.listSkeletons().map((s) => ({
          skeletonId: s.skeletonId,
          boneCount: s.bones.length,
        })),
        meshes: bridge.store.listMeshes(),
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
    "skeleton_initialize",
    {
      description:
        "Define um esqueleto 2D no blueprint e o inicializa na engine (método JSON-RPC skeleton/initialize). inverseBindMatrix é uma matriz afim 2D coluna-maior com 6 floats.",
      inputSchema: {
        skeletonId: z.string().min(1),
        bones: z.array(boneSchema).min(1).max(256),
      },
    },
    async ({ skeletonId, bones }) => {
      const result = await bridge.initializeSkeleton({ skeletonId, bones });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "mesh_bind_shared_memory",
    {
      description:
        "Registra o bind de um memory-mapped file de vértices para uma malha esqueletizada (método JSON-RPC mesh/bind_shared_memory).",
      inputSchema: {
        meshId: z.string().min(1),
        skeletonId: z.string().min(1),
        sharedMemoryMapName: z.string().min(1),
        vertexCount: z.number().int().positive(),
        strideInBytes: z.number().int().min(4),
      },
    },
    async (binding) => {
      const result = await bridge.bindMeshSharedMemory(binding);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "camera_configure",
    {
      description:
        "Configura a câmera cinemática (integrador massa-mola-amortecedor de segunda ordem): frequency (Hz), damping (ζ, 1 = crítico), response, anticipationSeconds (antecipação preditiva pelo vetor velocidade) e parâmetros do screen shake procedural.",
      inputSchema: {
        frequency: z.number().positive().optional(),
        damping: z.number().nonnegative().optional(),
        response: z.number().optional(),
        anticipationSeconds: z.number().nonnegative().optional(),
        shakeFrequencyHz: z.number().positive().optional(),
        shakeMaxOffset: z.number().nonnegative().optional(),
        shakeTraumaDecayPerSecond: z.number().positive().optional(),
      },
    },
    async (settings) => {
      const result = await bridge.configureCamera(stripUndefined(settings));
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
    "camera_shake",
    {
      description: "Aplica um impulso de trauma (0..1] ao screen shake procedural da câmera viva.",
      inputSchema: { trauma: z.number().gt(0).max(1) },
    },
    async ({ trauma }) => {
      const result = await bridge.triggerShake(trauma);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "light_add",
    {
      description:
        "Adiciona uma luz ao pipeline deferred 2D (direcional, pontual ou spot) no blueprint e na engine. Cones de spot em graus (ângulo total).",
      inputSchema: {
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
    },
    async (light) => {
      const result = await bridge.addLight(stripUndefined(light));
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "light_remove",
    {
      description: "Remove uma luz do blueprint e da engine pelo lightId do blueprint.",
      inputSchema: { lightId: z.string().min(1) },
    },
    async ({ lightId }) => {
      await bridge.removeLight(lightId);
      return { content: [{ type: "text", text: JSON.stringify({ removed: lightId }) }] };
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

  return server;
}

export async function startMcpStdio(
  bridge: EngineBridge,
  pipeServer: EnginePipeServer,
  capabilities?: CapabilityRegistry,
): Promise<McpServer> {
  const server = createMcpServer(bridge, pipeServer, capabilities);
  await server.connect(new StdioServerTransport());
  return server;
}
