#!/usr/bin/env node
/**
 * Driver de verificação ponta-a-ponta da Fase 2.
 *
 * Sobe o endpoint IPC, espera a engine .NET real conectar e então prova o
 * plano de dados completo:
 *
 *  1. `engine/describe` → obtém o layout binário REAL publicado pela engine
 *     (derivado por reflexão da struct C#) e o confere com o fallback local;
 *  2. escreve um quad no memory-mapped file usando o layout da engine;
 *  3. `skeleton/initialize` + `mesh/bind_shared_memory` → engine mapeia (bound);
 *  4. `mesh/inspect` → checksum FNV-1a da engine deve casar com o do escritor
 *     Node e a amostra de vértice deve bater byte a byte;
 *  5. republica com outro conteúdo → a engine deve enxergar a mudança pelo
 *     mapeamento vivo (frameIndex + checksum novos), sem re-bind.
 *
 * Uso: node dist/tools/phase2-driver.js --pipe <nome>
 */

import { EnginePipeServer } from "../ipc/EnginePipeServer.js";
import { BlueprintStore } from "../domain/BlueprintStore.js";
import { CapabilityRegistry } from "../domain/CapabilityRegistry.js";
import { EngineBridge } from "../domain/EngineBridge.js";
import { CanonicalOrchestrator } from "../canonical/CanonicalOrchestrator.js";
import { HookBus } from "../canonical/HookBus.js";
import { MonoGameAdapter } from "../runtime/MonoGameAdapter.js";
import { MeshSharedMemoryWriter } from "../sharedmem/MeshSharedMemoryWriter.js";
import { SKINNED_VERTEX_2D, type VertexData } from "../sharedmem/vertexLayout.js";

const IDENTITY = [1, 0, 0, 1, 0, 0];

function step(label: string, message: string): void {
  console.log(`  [${label.padEnd(10)}] ${message}`);
}

function assert(condition: boolean, what: string): void {
  if (!condition) throw new Error(`assertion failed: ${what}`);
  step("assert", what);
}

function quad(scale: number): VertexData[] {
  return [
    { position: [0, 0], uv: [0, 0], boneIndices: [0, 1, 0, 0], boneWeights: [1, 0, 0, 0] },
    { position: [scale, 0], uv: [1, 0], boneIndices: [0, 1, 0, 0], boneWeights: [0.75, 0.25, 0, 0] },
    { position: [scale, scale], uv: [1, 1], boneIndices: [0, 1, 0, 0], boneWeights: [0.25, 0.75, 0, 0] },
    { position: [0, scale], uv: [0, 1], boneIndices: [0, 1, 0, 0], boneWeights: [0, 1, 0, 0] },
  ];
}

async function main(): Promise<void> {
  const pipeIdx = process.argv.indexOf("--pipe");
  const pipeName = pipeIdx >= 0 ? process.argv[pipeIdx + 1]! : "p7m-phase2";
  const mapName = `${pipeName}-mesh`;

  const server = new EnginePipeServer({
    pipeName,
    supportedCapabilities: ["skeleton", "mesh", "shared-memory"],
    requestTimeoutMs: 10_000,
  });
  const store = new BlueprintStore();
  const bridge = new EngineBridge(server, store);
  const registry = new CapabilityRegistry(server);
  const adapter = new MonoGameAdapter(server, registry);
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), adapter);
  await server.listen();
  console.log(`driver listening at ${server.pipePath}; waiting for engine...`);

  let writer: MeshSharedMemoryWriter | undefined;
  try {
    // 1. Capacidades reais da engine
    const manifest = await registry.waitForManifest(30_000);
    step("describe", `${manifest.engine.name} v${manifest.engine.version}`);

    const layout = registry.findVertexLayout("SkinnedVertex2D");
    assert(layout !== undefined, "engine publishes SkinnedVertex2D layout");
    assert(
      layout!.strideInBytes === SKINNED_VERTEX_2D.strideInBytes,
      `engine stride ${layout!.strideInBytes} matches local fallback`,
    );
    for (const local of SKINNED_VERTEX_2D.fields) {
      const remote = layout!.fields.find((f) => f.name === local.name);
      assert(
        remote !== undefined && remote.offset === local.offset && remote.type === local.type,
        `field "${local.name}" offset ${local.offset} confirmed by engine reflection`,
      );
    }

    const concepts = registry.editorConcepts();
    const available = concepts.filter((c) => c.status === "available").map((c) => c.subsystem);
    const planned = concepts.filter((c) => c.status === "planned").map((c) => `${c.subsystem}(F${c.phase})`);
    step("concepts", `editor concepts — available: ${available.join(", ")}; planned: ${planned.join(", ")}`);

    // 2. Escreve o quad usando o layout PUBLICADO pela engine
    writer = MeshSharedMemoryWriter.create(mapName, 4, layout!);
    writer.publish(quad(100));
    step("publish", `4 vertices written to ${writer.path} (frame ${writer.frameIndex})`);

    // 3. Blueprint → engine (dispatch canônico: filters → AST → projeção)
    await orchestrator.dispatch({
      kind: "skeleton/define",
      skeleton: {
        skeletonId: "phase2-rig",
        bones: [
          { id: 0, parentId: -1, inverseBindMatrix: IDENTITY },
          { id: 1, parentId: 0, inverseBindMatrix: IDENTITY },
        ],
      },
    });
    const bindDispatch = await orchestrator.dispatch({
      kind: "mesh/bind",
      binding: {
        meshId: "phase2-quad",
        skeletonId: "phase2-rig",
        sharedMemoryMapName: mapName,
        vertexCount: 4,
        strideInBytes: layout!.strideInBytes,
      },
    });
    assert(bindDispatch.projection?.status === "projected", "mesh bind projected onto the engine");
    const bind = bindDispatch.projection!.detail as { status: string; mappedBytes: number };
    assert(bind.status === "bound", `engine mapped the buffer (status "${bind.status}")`);
    assert(
      bind.mappedBytes === 64 + 4 * layout!.strideInBytes,
      `mappedBytes ${bind.mappedBytes} = header + 4 × stride`,
    );

    // 4. A engine lê o que o Node escreveu — byte a byte
    const inspect = await bridge.inspectMesh("phase2-quad", 2);
    assert(inspect.frameIndex === 1, `engine sees frameIndex 1`);
    assert(
      inspect.checksumFnv1a === writer.checksum(),
      `FNV-1a checksum matches across runtimes (0x${inspect.checksumFnv1a.toString(16)})`,
    );
    assert(
      inspect.sample.position[0] === 100 && inspect.sample.position[1] === 100,
      "sampled vertex position matches published data",
    );
    assert(
      Math.abs(inspect.sample.boneWeights[0] - 0.25) < 1e-6 &&
        Math.abs(inspect.sample.boneWeights[1] - 0.75) < 1e-6,
      "sampled bone weights match published data",
    );

    // 5. Republica: visibilidade viva através do mapeamento, sem re-bind
    writer.publish(quad(250));
    const again = await bridge.inspectMesh("phase2-quad", 2);
    assert(again.frameIndex === 2, "engine sees frameIndex 2 after republish");
    assert(again.checksumFnv1a === writer.checksum(), "checksum matches after republish");
    assert(again.checksumFnv1a !== inspect.checksumFnv1a, "checksum actually changed");
    assert(again.sample.position[0] === 250, "engine reads the NEW vertex data through the live mapping");

    console.log("PHASE 2 DRIVER PASS: shared-memory data plane verified across runtimes");
  } finally {
    writer?.close(true);
    await server.close();
  }
}

main().catch((err) => {
  console.error(`PHASE 2 DRIVER FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
