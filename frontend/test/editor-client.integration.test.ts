import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorGateway } from "@p7m/middleware/dist/ipc/EditorGateway.js";
import { EnginePipeServer } from "@p7m/middleware/dist/ipc/EnginePipeServer.js";
import { BlueprintStore } from "@p7m/middleware/dist/domain/BlueprintStore.js";
import { CapabilityRegistry } from "@p7m/middleware/dist/domain/CapabilityRegistry.js";
import { CanonicalOrchestrator } from "@p7m/middleware/dist/canonical/CanonicalOrchestrator.js";
import { HookBus } from "@p7m/middleware/dist/canonical/HookBus.js";
import { ExperienceGovernor } from "@p7m/middleware/dist/runtime/ExperienceGovernor.js";
import { MonoGameAdapter } from "@p7m/middleware/dist/runtime/MonoGameAdapter.js";
import { RuntimeProfileRegistry } from "@p7m/middleware/dist/runtime/RuntimeProfile.js";
import { MONOGAME_PROFILES } from "@p7m/middleware/dist/runtime/profiles/monogame.js";
import { EditorClient } from "../src/main/EditorClient.js";
import { ExperienceGate } from "../src/core/experienceGate.js";

test("EditorClient conecta ao gateway real: dispatch, query, experiência e broadcast", async () => {
  const pipeName = `p7m-fe-${process.pid}-${Date.now() % 100000}`;
  const engineServer = new EnginePipeServer({ pipeName, requestTimeoutMs: 2000 });
  const capabilities = new CapabilityRegistry(engineServer);
  const adapter = new MonoGameAdapter(engineServer, capabilities);
  const store = new BlueprintStore();
  const profiles = new RuntimeProfileRegistry();
  for (const profile of MONOGAME_PROFILES) profiles.register(profile);
  const gateway = new EditorGateway({
    pipeName,
    orchestrator: new CanonicalOrchestrator(store, new HookBus(), adapter),
    store,
    governor: new ExperienceGovernor(profiles, capabilities),
    adapter,
    requestTimeoutMs: 2000,
  });
  await engineServer.listen();
  await gateway.listen();

  const client = new EditorClient(pipeName, "test-editor");
  try {
    const { sessionId } = await client.connect();
    assert.ok(sessionId.length > 0);
    assert.equal(client.isConnected, true);

    const received: string[] = [];
    client.onBlueprintEvent((event) => received.push(event.kind));

    // dispatch pelo caminho canônico (engine offline → deferred, AST aceita)
    const outcome = await client.dispatch("entitydef/define", {
      entityDefId: "coin",
      fields: [{ name: "value", type: "int", default: 1 }],
    });
    assert.equal(outcome.event.kind, "entityDefDefined");
    assert.equal(outcome.projection?.status, "deferred");

    const defs = await client.query<{ entityDefs: Array<{ entityDefId: string }> }>("entityDefs");
    assert.equal(defs.entityDefs[0]?.entityDefId, "coin");

    // broadcast chegou ao próprio cliente
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(received, ["entityDefDefined"]);

    // experiência governada alimenta o gate da UI (sem engine: fail-safe)
    const experience = await client.resolveExperience("monogame", "3.8.2");
    const gate = new ExperienceGate(experience);
    assert.equal(gate.panel("shader-editor").enabled, true);
    assert.equal(gate.panel("level-editor").enabled, false); // requiresSubsystem sem engine
    assert.match(gate.panel("level-editor").reason, /no engine connected/);
  } finally {
    client.close();
    await gateway.close();
    await engineServer.close();
  }
});
