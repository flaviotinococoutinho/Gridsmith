#!/usr/bin/env node
/**
 * Composição raiz do middleware P7M.
 *
 * Sobe o endpoint IPC do plano de controle (Named Pipe / Unix Socket) e,
 * salvo `--no-mcp`, o servidor MCP sobre stdio. Logs operacionais vão para
 * stderr — stdout pertence exclusivamente ao transporte MCP.
 *
 * Uso: p7m-middleware [--pipe <nome>] [--no-mcp] [--assets <dir>]
 *                     [--no-grpc] [--no-graphql]
 *
 * Verbosidade: P7M_VERBOSITY = silent|error|warn|info|debug|trace (default info).
 */

import path from "node:path";
import { AssetPipelineService, ExecToolRunner } from "./assets/AssetPipelineService.js";
import { EditorSurface } from "./canonical/EditorSurface.js";
import { GraphQlGateway } from "./graphql/GraphQlGateway.js";
import { GrpcGateway } from "./grpc/GrpcGateway.js";
import { EventJournal } from "./transport/EventJournal.js";
import { loadTransportAuthToken } from "./transport/auth.js";
import { createLogger } from "./util/log.js";
import { EditorGateway } from "./ipc/EditorGateway.js";
import { EnginePipeServer, type EngineLogEntry, type EngineSession } from "./ipc/EnginePipeServer.js";
import { ArtifactStore } from "./canonical/ArtifactStore.js";
import { HookBus } from "./canonical/HookBus.js";
import {
  ProjectSessionManager,
  type ProjectSessionChangedEvent,
  type SessionBlueprintEvent,
} from "./canonical/ProjectSessionManager.js";
import { ASEPRITE_PIPELINE, PipelineRunner } from "./canonical/Pipeline.js";
import { importAseprite } from "./assets/AsepriteImporter.js";
import { CapabilityRegistry, type EngineManifest } from "./domain/CapabilityRegistry.js";
import { EngineBridge } from "./domain/EngineBridge.js";
import { startMcpStdio } from "./mcp/McpFacade.js";
import { ExperienceGovernor } from "./runtime/ExperienceGovernor.js";
import type { ProjectionResult } from "./runtime/RuntimeAdapter.js";
import { bindEngineProjectSessionLifecycle } from "./runtime/EngineProjectSessionLifecycle.js";
import { MonoGameAdapter } from "./runtime/MonoGameAdapter.js";
import { RuntimeProfileRegistry } from "./runtime/RuntimeProfile.js";
import { MONOGAME_PROFILES } from "./runtime/profiles/monogame.js";

function parseArgs(argv: string[]): {
  pipeName?: string;
  mcp: boolean;
  assetsRoot?: string;
  grpc: boolean;
  graphql: boolean;
} {
  let pipeName: string | undefined;
  let assetsRoot: string | undefined;
  let mcp = true;
  let grpc = true;
  let graphql = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pipe") pipeName = argv[++i];
    else if (argv[i] === "--assets") assetsRoot = argv[++i];
    else if (argv[i] === "--no-mcp") mcp = false;
    else if (argv[i] === "--no-grpc") grpc = false;
    else if (argv[i] === "--no-graphql") graphql = false;
  }
  return {
    ...(pipeName !== undefined ? { pipeName } : {}),
    ...(assetsRoot !== undefined ? { assetsRoot } : {}),
    mcp,
    grpc,
    graphql,
  };
}

async function main(): Promise<void> {
  const { pipeName, mcp, assetsRoot, grpc, graphql } = parseArgs(process.argv.slice(2));
  const log = createLogger("p7m");
  const authToken = loadTransportAuthToken();

  const pipeServer = new EnginePipeServer({
    ...(pipeName !== undefined ? { pipeName } : {}),
    supportedCapabilities: ["skeleton", "mesh", "shared-memory"],
  });
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
  const sessions = new ProjectSessionManager({ hooks, adapter });
  const bridge = new EngineBridge(pipeServer, sessions);

  // Uma única porta de aplicação para JSON-RPC, GraphQL, gRPC e MCP.
  const surface = new EditorSurface({ sessions, governor, adapter });
  const journal = new EventJournal();
  sessions.on("event", (event: SessionBlueprintEvent, projection?: ProjectionResult) => {
    journal.appendForSession(
      event.projectSessionId,
      event.projectId,
      event.commandSequence,
      event.kind,
      event,
      // `detail` (ACK cru da engine) fica só na resposta do dispatch; no fio
      // de eventos viaja apenas o que o editor precisa para exibir a verdade.
      projection && {
        event: projection.event,
        status: projection.status,
        ...(projection.reason !== undefined ? { reason: projection.reason } : {}),
      },
      {
        actor: event.actor,
        action: event.historyAction,
        documentStateId: event.documentStateId,
        historyCursor: event.historyCursor,
        ...(event.transactionId !== undefined ? { transactionId: event.transactionId } : {}),
        ...(event.historyEntryId !== undefined ? { historyEntryId: event.historyEntryId } : {}),
      },
    );
  });
  sessions.on("sessionChanged", (event: ProjectSessionChangedEvent) => {
    if (event.action === "activated") {
      const position = journal.activateSession(
        event.projectSessionId!,
        event.projectId!,
        event.commandSequence,
      );
      journal.appendForSession(
        position.projectSessionId,
        position.projectId,
        event.commandSequence,
        event.kind,
        event,
      );
      return;
    }
    // O close pertence à partição que está sendo encerrada; só depois o
    // cursor gira para o estado sem projeto.
    const closing = journal.position;
    journal.appendForSession(
      closing.projectSessionId,
      closing.projectId,
      event.commandSequence,
      event.kind,
      event,
    );
    journal.deactivateSession();
  });

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
    surface,
    journal,
    authToken,
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
  });
  pipeServer.on("sessionClosed", (session: EngineSession, reason: Error) => {
    console.error(`[p7m] engine session ${session.sessionId} closed: ${reason.message}`);
  });
  pipeServer.on("engineLog", (_session: EngineSession, entry: EngineLogEntry) => {
    console.error(`[engine:${entry.level}]${entry.category ? ` (${entry.category})` : ""} ${entry.message}`);
  });
  // Somente a troca da engine efetivamente corrente dispara reset/reidratação.
  // Fechar A depois que B a supersedeu não produz um segundo ciclo nem pode
  // fazer o runtime voltar para A. O manager lê apenas sua sessão de projeto
  // ativa dentro da fila serializada.
  const unbindEngineProjectSessionLifecycle = bindEngineProjectSessionLifecycle(
    pipeServer,
    sessions,
    {
      onRehydrated: (status, change) => {
        if (status.active) {
          console.error(
            `[p7m] rehydration (${change.reason}): project ${status.projectId} ` +
              `session ${status.projectSessionId} (${status.runtimeState})`,
          );
        }
      },
      onError: (err, change) => {
        console.error(`[p7m] rehydration (${change.reason}) failed: ${err.message}`);
      },
    },
  );

  // ---- Transports do app (ADR-016/017): gRPC prioritário + GraphQL fallback ----
  // Ambos são fachadas finas sobre a MESMA EditorSurface do gateway JSON-RPC;
  // o EventJournal dá seq monotônico aos eventos (stream no gRPC, polling no
  // GraphQL) para o fallback não perder eventos.
  const graphqlGateway = graphql
    ? new GraphQlGateway({
        pipeName: pipeName ?? "p7m-engine",
        surface,
        journal,
        log: log.child("graphql"),
        authToken,
      })
    : undefined;
  const grpcGateway = grpc
    ? new GrpcGateway({
        pipeName: pipeName ?? "p7m-engine",
        surface,
        journal,
        log: log.child("grpc"),
        authToken,
      })
    : undefined;

  await pipeServer.listen();
  console.error(`[p7m] control-plane endpoint listening at ${pipeServer.pipePath}`);
  await editorGateway.listen();
  console.error(`[p7m] editor gateway listening at ${editorGateway.pipePath}`);
  if (graphqlGateway) await graphqlGateway.listen();
  if (grpcGateway) await grpcGateway.listen();

  if (mcp) {
    await startMcpStdio(bridge, pipeServer, capabilities, {
      surface,
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
    unbindEngineProjectSessionLifecycle();
    assetService?.close();
    await grpcGateway?.close();
    await graphqlGateway?.close();
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
