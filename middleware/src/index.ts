#!/usr/bin/env node
/**
 * Composição raiz do middleware P7M.
 *
 * Sobe o endpoint IPC do plano de controle (Named Pipe / Unix Socket) e,
 * salvo `--no-mcp`, o servidor MCP sobre stdio. Logs operacionais vão para
 * stderr — stdout pertence exclusivamente ao transporte MCP.
 *
 * Uso: p7m-middleware [--pipe <nome>] [--no-mcp]
 */

import { EnginePipeServer, type EngineLogEntry, type EngineSession } from "./ipc/EnginePipeServer.js";
import { BlueprintStore } from "./domain/BlueprintStore.js";
import { EngineBridge } from "./domain/EngineBridge.js";
import { startMcpStdio } from "./mcp/McpFacade.js";

function parseArgs(argv: string[]): { pipeName?: string; mcp: boolean } {
  let pipeName: string | undefined;
  let mcp = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pipe") pipeName = argv[++i];
    else if (argv[i] === "--no-mcp") mcp = false;
  }
  return { ...(pipeName !== undefined ? { pipeName } : {}), mcp };
}

async function main(): Promise<void> {
  const { pipeName, mcp } = parseArgs(process.argv.slice(2));

  const pipeServer = new EnginePipeServer({
    ...(pipeName !== undefined ? { pipeName } : {}),
    supportedCapabilities: ["skeleton", "mesh", "shared-memory"],
  });
  const bridge = new EngineBridge(pipeServer, new BlueprintStore());

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

  await pipeServer.listen();
  console.error(`[p7m] control-plane endpoint listening at ${pipeServer.pipePath}`);

  if (mcp) {
    await startMcpStdio(bridge, pipeServer);
    console.error("[p7m] MCP server ready on stdio");
  }

  const shutdown = async (): Promise<void> => {
    console.error("[p7m] shutting down");
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
