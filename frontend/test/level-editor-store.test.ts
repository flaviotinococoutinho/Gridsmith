import assert from "node:assert/strict";
import { test } from "node:test";
import { LevelEditorStore } from "../src/core/levelEditorStore.js";
import type { BlueprintEventPayload } from "../src/core/editorCommands.js";

const envelope = (event: Record<string, unknown>): BlueprintEventPayload => ({
  kind: event["kind"] as string,
  projectSessionId: "session",
  projectId: "project",
  commandSequence: "1",
  ...event,
});

const cursor = (commandSequence = "0") => ({
  projectSessionId: "session",
  commandSequence,
});

test("edição canônica: store aplica patch e evento remoto na mesma projeção", () => {
  const store = new LevelEditorStore();
  store.replace({
    levels: [{
      levelId: "level-1",
      width: 2,
      height: 1,
      tileSize: 16,
      seed: 1,
      intGrid: [0, 0],
      rules: [],
    }],
  }, undefined, cursor());
  const doc = store.snapshot.level!.intGrid;
  doc.beginGesture("local", "Pintar linha");
  doc.paint(0, 0, 3);
  doc.finishGesture();

  assert.equal(store.applyAcknowledgement(envelope({
    kind: "levelPatched",
    levelId: "level-1",
    transactionId: "local",
    changes: [{ index: 0, before: 0, after: 3 }],
  })), true);
  assert.deepEqual(doc.confirmedSnapshot(), [3, 0]);

  // Somente o journal avança o cursor contíguo.
  store.applyEvent(envelope({
    kind: "levelPatched",
    levelId: "level-1",
    transactionId: "local",
    changes: [{ index: 0, before: 0, after: 3 }],
  }));

  store.applyEvent(envelope({
    kind: "levelPatched",
    commandSequence: "2",
    levelId: "level-1",
    transactionId: "remote",
    changes: [{ index: 1, before: 0, after: 7 }],
  }));
  assert.deepEqual(doc.snapshot(), [3, 7]);
});

test("edição canônica: palette v4 sobrevive resync e aplica levelPaletteChanged delta-only", () => {
  const store = new LevelEditorStore();
  store.replace({
    levels: [{
      levelId: "level-1",
      width: 1,
      height: 1,
      tileSize: 16,
      seed: 1,
      intGrid: [0],
      rules: [],
      palette: [{ value: 1, name: "Chão", color: "#111111" }],
    }],
  }, undefined, cursor());
  assert.equal(store.snapshot.level?.palette?.[0]?.name, "Chão");

  const deltaEvent = envelope({
    kind: "levelPaletteChanged",
    levelId: "level-1",
    changes: [
      {
        value: 1,
        before: { value: 1, name: "Chão", color: "#111111" },
        after: { value: 1, name: "Terreno", color: "#222222" },
      },
      {
        value: 2,
        before: null,
        after: { value: 2, name: "Parede", color: "#333333" },
      },
    ],
  });
  assert.equal("level" in deltaEvent, false, "palette event must not carry a full level snapshot");
  assert.equal(store.applyEvent(deltaEvent), true);
  assert.deepEqual(store.snapshot.level?.palette, [
    { value: 1, name: "Terreno", color: "#222222" },
    { value: 2, name: "Parede", color: "#333333" },
  ]);
});

test("edição canônica: entidades convergem por eventos entre painéis", () => {
  const store = new LevelEditorStore();
  store.replace({ levels: [], entities: [] }, undefined, cursor());
  store.applyEvent(envelope({
    kind: "entityPlaced",
    entity: { entityId: "player", entityDefId: "player-def", position: [8, 8] },
  }));
  store.applyEvent(envelope({
    kind: "entityMoved",
    commandSequence: "2",
    entity: { entityId: "player", entityDefId: "player-def", position: [24, 8] },
  }));
  assert.deepEqual(store.snapshot.entities[0]?.position, [24, 8]);
});

test("edição canônica: ACK N atrasado não regride journal N+1", () => {
  const store = new LevelEditorStore();
  store.replace({
    levels: [{
      levelId: "level-1",
      width: 1,
      height: 1,
      tileSize: 16,
      seed: 1,
      intGrid: [0],
      rules: [],
    }],
  }, undefined, cursor());
  const doc = store.snapshot.level!.intGrid;
  doc.beginGesture("local-n", "Pintar");
  doc.paint(0, 0, 1);
  doc.finishGesture();

  assert.equal(store.applyEvent(envelope({
    kind: "levelPatched",
    commandSequence: "1",
    levelId: "level-1",
    transactionId: "local-n",
    changes: [{ index: 0, before: 0, after: 1 }],
  })), true);
  assert.equal(store.applyEvent(envelope({
    kind: "levelPatched",
    commandSequence: "2",
    levelId: "level-1",
    transactionId: "remote-n-plus-1",
    changes: [{ index: 0, before: 1, after: 2 }],
  })), true);
  assert.deepEqual(doc.confirmedSnapshot(), [2]);
  assert.deepEqual(doc.snapshot(), [2]);

  assert.equal(store.applyAcknowledgement(envelope({
    kind: "levelPatched",
    commandSequence: "1",
    levelId: "level-1",
    transactionId: "local-n",
    changes: [{ index: 0, before: 0, after: 1 }],
  })), false);
  assert.deepEqual(doc.confirmedSnapshot(), [2]);
  assert.deepEqual(doc.snapshot(), [2]);
  assert.deepEqual(doc.pendingTransactionIds, []);
  assert.equal(store.cursor?.commandSequence, "2");

  assert.equal(store.applyEvent({
    ...envelope({
      kind: "levelPatched",
      commandSequence: "3",
      levelId: "level-1",
      changes: [{ index: 0, before: 2, after: 9 }],
    }),
    projectSessionId: "stale-session",
  }), false);
  assert.deepEqual(doc.snapshot(), [2]);
});

test("edição canônica: ACK local N+1 não descarta evento remoto intermediário N", () => {
  const store = new LevelEditorStore();
  store.replace({
    levels: [{
      levelId: "level-1",
      width: 2,
      height: 1,
      tileSize: 16,
      seed: 1,
      intGrid: [0, 0],
      rules: [],
    }],
  }, undefined, cursor());
  const doc = store.snapshot.level!.intGrid;
  doc.beginGesture("local-n-plus-1", "Pintar");
  doc.paint(0, 0, 3);
  doc.finishGesture();

  assert.equal(store.applyAcknowledgement(envelope({
    kind: "levelPatched",
    commandSequence: "2",
    levelId: "level-1",
    transactionId: "local-n-plus-1",
    changes: [{ index: 0, before: 0, after: 3 }],
  })), false, "ACK N+1 deve aguardar o evento N ausente");
  assert.deepEqual(doc.snapshot(), [3, 0]);
  assert.equal(store.cursor?.commandSequence, "0");

  assert.equal(store.applyEvent(envelope({
    kind: "levelPatched",
    commandSequence: "1",
    levelId: "level-1",
    transactionId: "remote-n",
    changes: [{ index: 1, before: 0, after: 7 }],
  })), true);
  assert.deepEqual(doc.confirmedSnapshot(), [3, 7]);
  assert.deepEqual(doc.snapshot(), [3, 7]);
  assert.deepEqual(doc.pendingTransactionIds, []);
  assert.equal(store.cursor?.commandSequence, "1", "ACK aplicado não avança cursor de journal");

  // O eco posterior do journal para N+1 é idempotente.
  assert.equal(store.applyEvent(envelope({
    kind: "levelPatched",
    commandSequence: "2",
    levelId: "level-1",
    transactionId: "local-n-plus-1",
    changes: [{ index: 0, before: 0, after: 3 }],
  })), true);
  assert.deepEqual(doc.snapshot(), [3, 7]);
});
