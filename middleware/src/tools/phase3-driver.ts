#!/usr/bin/env node
/**
 * Driver de verificação ponta-a-ponta da Fase 3.
 *
 * Com a engine .NET real conectada, prova o motor de câmera e o pipeline de
 * iluminação através do plano de controle:
 *
 *  1. `engine/describe` → câmera e iluminação anunciadas como "available"
 *     com os conceitos de edição visual;
 *  2. câmera criticamente amortecida converge sem overshoot; subamortecida
 *     ultrapassa o alvo (física massa-mola-amortecedor);
 *  3. simulação é determinística (mesmos params → mesma trajetória) e o
 *     screen shake aparece limitado e decai a zero;
 *  4. luzes: add/inspect/remove e `lighting/evaluate` conferido contra a
 *     MESMA fórmula reimplementada aqui em TypeScript — a equação do shader
 *     validada através de dois runtimes independentes.
 *
 * Uso: node dist/tools/phase3-driver.js --pipe <nome>
 */

import { EnginePipeServer } from "../ipc/EnginePipeServer.js";
import { BlueprintStore } from "../domain/BlueprintStore.js";
import { CapabilityRegistry } from "../domain/CapabilityRegistry.js";
import { EngineBridge } from "../domain/EngineBridge.js";
import { CanonicalOrchestrator } from "../canonical/CanonicalOrchestrator.js";
import { HookBus } from "../canonical/HookBus.js";
import { MonoGameAdapter } from "../runtime/MonoGameAdapter.js";
import { resolveAutoTiles, type AutoTileRule, type IntGrid } from "../leveldesign/AutoTiler.js";

function step(label: string, message: string): void {
  console.log(`  [${label.padEnd(10)}] ${message}`);
}

function assert(condition: boolean, what: string): void {
  if (!condition) throw new Error(`assertion failed: ${what}`);
  step("assert", what);
}

/** Referência TypeScript independente de Lighting2D.EvaluatePoint (C#/HLSL). */
function evaluatePointLight(
  lightPos: [number, number],
  height: number,
  radius: number,
  color: [number, number, number],
  intensity: number,
  surface: [number, number],
  normal: [number, number, number],
): [number, number, number] {
  const dx = lightPos[0] - surface[0];
  const dy = lightPos[1] - surface[1];
  const dz = height;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance <= 1e-6) return [color[0] * intensity, color[1] * intensity, color[2] * intensity];

  const nLen = Math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2);
  const ndotl = Math.max(
    0,
    (normal[0] * (dx / distance) + normal[1] * (dy / distance) + normal[2] * (dz / distance)) / nLen,
  );
  const x = distance / radius;
  const att = Math.max(0, 1 - x * x) ** 2;
  const scale = intensity * att * ndotl;
  return [color[0] * scale, color[1] * scale, color[2] * scale];
}

/** FNV-1a 32-bit sobre int32 little-endian — espelho de TilemapStore.ComputeChecksum. */
function fnv1aInt32(values: Int32Array): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const v = value >>> 0;
    for (const byte of [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

async function main(): Promise<void> {
  const pipeIdx = process.argv.indexOf("--pipe");
  const pipeName = pipeIdx >= 0 ? process.argv[pipeIdx + 1]! : "p7m-phase3";

  const server = new EnginePipeServer({
    pipeName,
    supportedCapabilities: ["skeleton", "mesh", "shared-memory"],
    requestTimeoutMs: 15_000,
  });
  const store = new BlueprintStore();
  const bridge = new EngineBridge(server, store);
  const registry = new CapabilityRegistry(server);
  const adapter = new MonoGameAdapter(server, registry);
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), adapter);
  await server.listen();
  console.log(`driver listening at ${server.pipePath}; waiting for engine...`);

  try {
    // 1. Capacidades: câmera e iluminação agora disponíveis para o editor
    const manifest = await registry.waitForManifest(30_000);
    const concepts = registry.editorConcepts();
    const camera = concepts.find((c) => c.subsystem === "camera");
    const lighting = concepts.find((c) => c.subsystem === "lighting");
    assert(camera?.status === "available", "camera subsystem announced as available");
    assert(lighting?.status === "available", "lighting subsystem announced as available");
    assert(camera!.panel === "camera-rig", `camera editor panel "${camera!.panel}" exposed`);
    assert(
      lighting!.nodeTypes.includes("spot-light"),
      `lighting node palette exposes ${lighting!.nodeTypes.length} node types`,
    );
    step("describe", `${manifest.engine.name}: editor concepts refreshed for phase 3`);

    // 2. Física: crítico não ultrapassa, subamortecido ultrapassa
    await orchestrator.dispatch({ kind: "camera/configure", settings: { frequency: 2, damping: 1, anticipationSeconds: 0 } });
    const critical = await bridge.simulateCamera({
      steps: 960,
      deltaSeconds: 1 / 120,
      target: [100, 0],
      initial: [0, 0],
    });
    const maxCriticalX = Math.max(...critical.samples.map((s) => s[0]));
    assert(Math.abs(critical.final[0] - 100) < 0.5, `critically damped converges (final x=${critical.final[0].toFixed(2)})`);
    assert(maxCriticalX <= 100.5, `no overshoot at critical damping (max x=${maxCriticalX.toFixed(2)})`);

    await orchestrator.dispatch({ kind: "camera/configure", settings: { damping: 0.3 } });
    const bouncy = await bridge.simulateCamera({
      steps: 1440,
      deltaSeconds: 1 / 120,
      target: [100, 0],
      initial: [0, 0],
    });
    const maxBouncyX = Math.max(...bouncy.samples.map((s) => s[0]));
    assert(maxBouncyX > 105, `underdamped overshoots (max x=${maxBouncyX.toFixed(2)})`);
    assert(Math.abs(bouncy.final[0] - 100) < 1, "and still converges");

    // 3. Determinismo + shake limitado que decai
    const again = await bridge.simulateCamera({
      steps: 1440,
      deltaSeconds: 1 / 120,
      target: [100, 0],
      initial: [0, 0],
    });
    assert(
      again.final[0] === bouncy.final[0] && again.final[1] === bouncy.final[1],
      "simulation is deterministic (same inputs → same trajectory)",
    );

    const shaken = await bridge.simulateCamera({
      steps: 600,
      deltaSeconds: 1 / 60,
      target: [0, 0],
      trauma: 1,
    });
    assert(shaken.maxShakeMagnitude > 1, `shake visible (max offset ${shaken.maxShakeMagnitude.toFixed(1)})`);
    assert(shaken.maxShakeMagnitude <= 34, "shake bounded by configured max offset");
    assert(shaken.finalTrauma === 0, "trauma fully decayed after 10 s");

    // 4. Iluminação: equação do shader validada por reimplementação independente
    await orchestrator.dispatch({
      kind: "light/add",
      light: {
        lightId: "key-light",
        type: "point",
        position: [50, 50],
        height: 40,
        color: [1, 0.8, 0.6],
        intensity: 2,
        radius: 200,
      },
    });
    const inspect = await bridge.inspectLighting();
    assert(inspect.count === 1, "light registered in the engine store");

    const surface: [number, number] = [80, 50];
    const normal: [number, number, number] = [0, 0, 1];
    const engineRgb = (await bridge.evaluateLighting(surface, normal)).rgb;
    const expectedRgb = evaluatePointLight([50, 50], 40, 200, [1, 0.8, 0.6], 2, surface, normal);
    for (let c = 0; c < 3; c++) {
      assert(
        Math.abs(engineRgb[c]! - expectedRgb[c]!) < 1e-4,
        `light equation channel ${c}: engine=${engineRgb[c]!.toFixed(5)} ≡ ts-reference=${expectedRgb[c]!.toFixed(5)}`,
      );
    }

    await orchestrator.dispatch({ kind: "light/remove", lightId: "key-light" });
    const after = await bridge.inspectLighting();
    assert(after.count === 0, "light removed from the engine store");

    // 5. Nível (pesquisa LDtk/Tiled): o middleware resolve o auto-tiling e a
    //    engine deve enxergar EXATAMENTE os mesmos tiles (checksum cruzado)
    const grid: IntGrid = {
      width: 8,
      height: 4,
      values: [
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 1, 1, 1, 1, 0, 0,
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
      ],
    };
    const rules: AutoTileRule[] = [
      {
        name: "grass-top",
        patternSize: 3,
        pattern: [null, 0, null, null, 1, null, null, null, null],
        tileIds: [100, 101],
      },
      { name: "dirt", patternSize: 1, pattern: [1], tileIds: [200] },
    ];
    const resolved = resolveAutoTiles(grid, rules, 1234);
    const localChecksum = fnv1aInt32(resolved.tiles);

    const session = server.currentSession!;
    const defined = (await session.peer.request("tilemap/define", {
      tilemapId: "verify-level",
      width: grid.width,
      height: grid.height,
      tileSize: 16,
      intGrid: grid.values,
      tiles: [...resolved.tiles],
    })) as { nonEmptyTiles: number; checksumFnv1a: number; staticBatches: number };

    assert(defined.staticBatches === 1, "tiles consolidated into a single static batch");
    assert(
      defined.checksumFnv1a === localChecksum,
      `auto-tiled level checksum matches across runtimes (0x${localChecksum.toString(16)})`,
    );

    const cellInfo = (await session.peer.request("tilemap/inspect", {
      tilemapId: "verify-level",
      cell: [2, 1], // primeiro tile da plataforma superior: topo exposto
    })) as { cell: { intGridValue: number; tileId: number } };
    assert(cellInfo.cell.intGridValue === 1, "engine reads back the painted IntGrid meaning");
    assert(
      cellInfo.cell.tileId === 100 || cellInfo.cell.tileId === 101,
      `grass-top rule applied with deterministic variant (tile ${cellInfo.cell.tileId})`,
    );

    console.log("PHASE 3 DRIVER PASS: camera physics, deferred lighting and auto-tiled level verified across runtimes");
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(`PHASE 3 DRIVER FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
