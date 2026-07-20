import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportBlueprint,
  replayDocument,
} from "../src/canonical/BlueprintSerializer.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { createPlatformer2DDocument } from "../src/canonical/ProjectTemplates.js";
import { BlueprintStore } from "../src/domain/BlueprintStore.js";

test("SpriteRenderer do archetype participa de histórico e persiste no roundtrip", async () => {
  const document = createPlatformer2DDocument({ projectId: "sprite-roundtrip" });
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());
  await replayDocument(document, store, orchestrator);

  const player = store.getEntityDef("player")!;
  const result = await orchestrator.dispatch({
    kind: "entitydef/update",
    definition: {
      ...player,
      spriteRenderer: {
        assetId: "assets/characters/player",
        defaultClip: "idle",
      },
    },
    transactionId: "associate-player-sprite",
    metadata: { actor: "human", label: "Associar sprite ao Player" },
  });

  assert.equal(result.historyEntry?.inverse[0]?.kind, "entitydef/update");
  const saved = exportBlueprint(store, document.projectId, document.metadata);
  assert.deepEqual(saved.entityDefs[0]?.spriteRenderer, {
    assetId: "assets/characters/player",
    defaultClip: "idle",
  });

  const reopened = new BlueprintStore();
  await replayDocument(saved, reopened, new CanonicalOrchestrator(reopened, new HookBus()));
  assert.deepEqual(reopened.getEntityDef("player")?.spriteRenderer, saved.entityDefs[0]?.spriteRenderer);
});

test("referência a asset ausente permanece reparável e não invalida o projeto", async () => {
  const template = createPlatformer2DDocument({ projectId: "missing-asset" });
  const document = {
    ...template,
    entityDefs: [{
      ...template.entityDefs[0]!,
      spriteRenderer: { assetId: "assets/missing/player", defaultClip: "idle" },
    }],
  };

  const store = new BlueprintStore();
  await replayDocument(document, store, new CanonicalOrchestrator(store, new HookBus()));
  assert.equal(store.getEntityDef("player")?.spriteRenderer?.assetId, "assets/missing/player");
});

test("SpriteRenderer rejeita ids e clips vazios sem alterar a definição anterior", async () => {
  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());
  await replayDocument(createPlatformer2DDocument(), store, orchestrator);
  const before = store.getEntityDef("player")!;

  await assert.rejects(
    orchestrator.dispatch({
      kind: "entitydef/update",
      definition: { ...before, spriteRenderer: { assetId: "" } },
    }),
    /spriteRenderer\.assetId/,
  );
  assert.deepEqual(store.getEntityDef("player"), before);
});
