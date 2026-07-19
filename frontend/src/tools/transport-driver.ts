#!/usr/bin/env node
/**
 * Driver e2e dos TRANSPORTS DO APP (ADR-016/017): usa o EditorClient REAL
 * (o mesmo do Electron main, sem Electron) contra um middleware REAL — e,
 * quando presente, uma engine .NET real projetando de verdade.
 *
 * Fases (orquestradas por scripts/verify-transports.sh):
 *   --expect grpc     middleware com os dois transports → conecta pelo gRPC,
 *                     dispatch quente, stream de eventos, projeção na engine;
 *   --expect graphql  middleware SEM gRPC (--no-grpc) → fallback no connect,
 *                     mesma superfície via GraphQL + polling de eventos.
 *
 * Uso: node dist/tools/transport-driver.js --pipe <nome> --expect grpc|graphql
 *      [--engine] (exige projeção "projected" na engine real)
 */

import { EditorClient } from "../main/EditorClient.js";
import { createLogger } from "../core/logging.js";

function step(label: string, message: string): void {
  console.log(`  [${label.padEnd(10)}] ${message}`);
}

function assert(condition: boolean, what: string): void {
  if (!condition) throw new Error(`assertion failed: ${what}`);
  step("assert", what);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const pipeName = argv[argv.indexOf("--pipe") + 1] ?? "p7m-engine";
  const expected = argv[argv.indexOf("--expect") + 1] ?? "grpc";
  const withEngine = argv.includes("--engine");

  const client = new EditorClient(pipeName, {
    requestTimeoutMs: 5_000,
    eventPollMs: 100,
    probeTickMs: 200,
    log: createLogger("driver", { level: "warn" }),
  });

  try {
    const { sessionId } = await client.connect();
    step("connect", `session ${sessionId}`);
    const expectedDiagnostic = expected === "grpc" ? "gRPC" : "GraphQL fallback";
    assert(
      client.technicalDiagnostics.activeTransport === expectedDiagnostic,
      `active transport is "${client.technicalDiagnostics.activeTransport}" (expected "${expectedDiagnostic}")`,
    );

    const project = await client.createProject();
    assert(project.status.active, `project session ${project.status.projectSessionId} activated`);

    const received: string[] = [];
    client.onBlueprintEvent((event) => received.push(event.kind));

    // superfície completa (GraphQL baseline): experiência + templates
    const experience = await client.resolveExperience();
    assert(typeof experience.profileVersion === "string", `experience resolved (profile ${experience.profileVersion})`);
    const { templates } = await client.listProjectTemplates();
    assert(templates.some((t) => t.id === "platformer-2d"), "templates include platformer-2d");

    // caminho quente: dispatch canônico com projeção real
    const suffix = Date.now() % 100000;
    const outcome = await client.dispatch("light/add", {
      lightId: `driver-${suffix}`,
      type: "point",
      position: [10, 10],
      height: 20,
      color: [1, 0.9, 0.7],
      intensity: 1.5,
      radius: 96,
    });
    assert(outcome.event.kind === "lightAdded", "hot dispatch produced lightAdded");
    if (withEngine) {
      assert(
        outcome.projection?.status === "projected",
        `projection reached the real engine (status ${outcome.projection?.status})`,
      );
    } else {
      assert(
        outcome.projection?.status === "deferred",
        `projection deferred without engine (status ${outcome.projection?.status})`,
      );
    }

    // leitura quente espelha o AST
    const lights = await client.query<{ lights: Array<{ lightId: string }> }>("lights");
    assert(
      lights.lights.some((l) => l.lightId === `driver-${suffix}`),
      "hot query reflects the AST",
    );

    // eventos chegam pelo mecanismo do transporte ativo (stream ou polling)
    const deadline = Date.now() + 5_000;
    while (!received.includes("lightAdded") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(
      received.includes("lightAdded"),
      `events delivered via ${expected === "grpc" ? "gRPC stream" : "GraphQL polling"}`,
    );

    // limpeza para a próxima fase reutilizar o mesmo middleware/engine
    await client.dispatch("light/remove", { lightId: `driver-${suffix}` });

    console.log(`TRANSPORT DRIVER PASS (${expected}): canonical surface, hot path and events verified`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`TRANSPORT DRIVER FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
