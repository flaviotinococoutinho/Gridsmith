#!/usr/bin/env node
/**
 * Composição raiz do middleware P7M.
 *
 * Sobe o endpoint IPC do plano de controle (Named Pipe / Unix Socket) e,
 * salvo `--no-mcp`, o servidor MCP sobre stdio. Logs operacionais vão para
 * stderr — stdout pertence exclusivamente ao transporte MCP.
 *
 * Uso: p7m-middleware [--pipe <nome>] [--no-mcp] [--assets <dir>]
 */

import path from "node:path";
import { AssetPipelineService, ExecToolRunner } from "./assets/AssetPipelineService.js";
import { EditorGateway } from "./ipc/EditorGateway.js";
import { EnginePipeServer, type EngineLogEntry, type EngineSession } from "./ipc/EnginePipeServer.js";
import { ArtifactStore } from "./canonical/ArtifactStore.js";
import { CanonicalOrchestrator } from "./canonical/CanonicalOrchestrator.js";
import { HookBus } from "./canonical/HookBus.js";
import { ASEPRITE_PIPELINE, PipelineRunner } from "./canonical/Pipeline.js";
import { importAseprite } from "./assets/AsepriteImporter.js";
import { BlueprintStore } from "./domain/BlueprintStore.js";
import { CapabilityRegistry, type EngineManifest } from "./domain/CapabilityRegistry.js";
import { EngineBridge } from "./domain/EngineBridge.js";
import { startMcpStdio } from "./mcp/McpFacade.js";
import { ExperienceGovernor } from "./runtime/ExperienceGovernor.js";
import { MonoGameAdapter } from "./runtime/MonoGameAdapter.js";
import { RuntimeProfileRegistry } from "./runtime/RuntimeProfile.js";
import { MONOGAME_PROFILES } from "./runtime/profiles/monogame.js";

function parseArgs(argv: string[]): { pipeName?: string; mcp: boolean; assetsRoot?: string } {
  let pipeName: string | undefined;
  let assetsRoot: string | undefined;
  let mcp = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pipe") pipeName = argv[++i];
    else if (argv[i] === "--assets") assetsRoot = argv[++i];
    else if (argv[i] === "--no-mcp") mcp = false;
  }
  return {
    ...(pipeName !== undefined ? { pipeName } : {}),
    ...(assetsRoot !== undefined ? { assetsRoot } : {}),
    mcp,
  };
}

async function main(): Promise<void> {
  const { pipeName, mcp, assetsRoot } = parseArgs(process.argv.slice(2));

  const pipeServer = new EnginePipeServer({
    ...(pipeName !== undefined ? { pipeName } : {}),
    supportedCapabilities: ["skeleton", "mesh", "shared-memory"],
  });
  const store = new BlueprintStore();
  const bridge = new EngineBridge(pipeServer, store);
  const capabilities = new CapabilityRegistry(pipeServer);

  // ---- Modelo canônico + governança de runtime (docs/CANONICAL-MODEL.md) ----
  const hooks = new HookBus();
  const artifacts = new ArtifactStore();
  const pipelines = new PipelineRunner(hooks, artifacts);
  pipelines.register(ASEPRITE_PIPELINE);
  hooks.addFilter(
    `pipeline:${ASEPRITE_PIPELINE.pipelineId}:parse`,
    (raw) => importAseprite(raw),
    { id: "aseprite-parse", priority: 10 },
  );

  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const governor = new ExperienceGovernor(profiles, capabilities);
  const adapter = new MonoGameAdapter(pipeServer, capabilities);
  const orchestrator = new CanonicalOrchestrator(store, hooks, adapter);

  // Pipeline de assets (watcher + Aseprite CLI + MGCB) quando --assets <dir>
  let assetService: AssetPipelineService | undefined;
  if (assetsRoot) {
    assetService = new AssetPipelineService({
      assetsRoot,
      outputRoot: path.join(assetsRoot, ".p7m-build"),
      runner: new ExecToolRunner(),
      pipelines,
      hooks,
    });
    assetService.watch((err) => console.error(`[p7m] asset ingest failed: ${err.message}`));
    hooks.addAction("asset:ingested", (payload) => {
      const r = payload as { artifactId: string; revision: number };
      console.error(`[p7m] asset ingested: ${r.artifactId} (rev ${r.revision})`);
    });
    console.error(`[p7m] asset pipeline watching ${assetsRoot}`);
  }

  // Endpoint do editor (Electron/clientes de edição) em <pipe>-editor
  const editorGateway = new EditorGateway({
    pipeName: pipeName ?? "p7m-engine",
    orchestrator,
    store,
    governor,
    adapter,
  });
  editorGateway.on("session", (session) => {
    console.error(`[p7m] editor session ${session.sessionId} established: ${session.clientName}`);
  });
  editorGateway.on("sessionClosed", (session) => {
    console.error(`[p7m] editor session ${session.sessionId} closed`);
  });

  capabilities.on("capabilities", (manifest: EngineManifest) => {
    const available = Object.entries(manifest.subsystems)
      .filter(([, s]) => s.status === "available")
      .map(([name]) => name);
    console.error(
      `[p7m] engine capabilities cached: ${manifest.engine.name} v${manifest.engine.version} ` +
        `(available: ${available.join(", ") || "none"})`,
    );
  });
  capabilities.on("describeError", (err: Error) => {
    console.error(`[p7m] engine/describe failed: ${err.message}`);
  });

  pipeServer.on("session", (session: EngineSession) => {
    console.error(
      `[p7m] engine session ${session.sessionId} established: ${session.clientName} v${session.clientVersion}`,
    );
    // Ping de boas-vindas: prova a direção middleware → engine em toda conexão.
    void bridge
      .pingEngine("welcome")
      .then((pong) => console.error(`[p7m] welcome ping ok (echo "${pong.echo}")`))
      .catch((err: Error) => console.error(`[p7m] welcome ping failed: ${err.message}`));
    // Reidratação canônica: o adapter projeta o Blueprint inteiro na sessão nova.
    void adapter
      .rehydrateFrom(store)
      .then((results) => {
        const projected = results.filter((r) => r.status === "projected").length;
        if (results.length > 0) {
          console.error(`[p7m] rehydration: ${projected}/${results.length} events projected`);
        }
      })
      .catch((err: Error) => console.error(`[p7m] rehydration failed: ${err.message}`));
  });
  pipeServer.on("sessionClosed", (session: EngineSession, reason: Error) => {
    console.error(`[p7m] engine session ${session.sessionId} closed: ${reason.message}`);
  });
  pipeServer.on("engineLog", (_session: EngineSession, entry: EngineLogEntry) => {
    console.error(`[engine:${entry.level}]${entry.category ? ` (${entry.category})` : ""} ${entry.message}`);
  });

  await pipeServer.listen();
  console.error(`[p7m] control-plane endpoint listening at ${pipeServer.pipePath}`);
  await editorGateway.listen();
  console.error(`[p7m] editor gateway listening at ${editorGateway.pipePath}`);

  if (mcp) {
    await startMcpStdio(bridge, pipeServer, capabilities, {
      orchestrator,
      artifacts,
      hooks,
      profiles,
      governor,
      adapter,
      ...(assetService !== undefined ? { assets: assetService } : {}),
    });
    console.error("[p7m] MCP server ready on stdio (canonical model + runtime governance)");
  }

  const shutdown = async (): Promise<void> => {
    console.error("[p7m] shutting down");
    assetService?.close();
    await editorGateway.close();
    await pipeServer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[p7m] fatal:", err);
  process.exit(1);
});
