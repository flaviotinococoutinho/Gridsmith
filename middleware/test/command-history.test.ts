import assert from "node:assert/strict";
import { test } from "node:test";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import {
  HistoryBarrierError,
  HistoryConflictError,
  HistoryUnavailableError,
} from "../src/canonical/CommandHistory.js";
import { HookBus } from "../src/canonical/HookBus.js";
import {
  BlueprintStore,
  type BlueprintCommand,
  type LevelSpec,
  type LightSpec,
} from "../src/domain/BlueprintStore.js";

const light = (lightId: string, intensity = 1): LightSpec => ({
  lightId,
  type: "point",
  position: [10, 20],
  color: [1, 1, 1],
  intensity,
  radius: 100,
});

const level = (levelId: string): LevelSpec => ({
  levelId,
  width: 4,
  height: 4,
  tileSize: 16,
  seed: 1,
  intGrid: new Array<number>(16).fill(0),
  rules: [{ patternSize: 1, pattern: [1], tileIds: [1] }],
});

function novo(): { store: BlueprintStore; orchestrator: CanonicalOrchestrator } {
  const store = new BlueprintStore();
  return { store, orchestrator: new CanonicalOrchestrator(store, new HookBus()) };
}

const ids = (store: BlueprintStore): string[] => store.listLights().map((l) => l.lightId);

test("desfazer restaura o estado e refazer o traz de volta", async () => {
  const { store, orchestrator } = novo();
  await orchestrator.dispatch({ kind: "light/add", light: light("a") }, { actor: "human" });
  await orchestrator.dispatch({ kind: "light/add", light: light("b") }, { actor: "human" });
  assert.deepEqual(ids(store), ["a", "b"]);

  await orchestrator.undo();
  assert.deepEqual(ids(store), ["a"]);

  await orchestrator.redo();
  assert.deepEqual(ids(store), ["a", "b"]);
});

test("a sequência de comandos é MONOTÔNICA no undo — quem volta é o cursor", async () => {
  // Um cliente que assumisse "undo = a sequência volta" quebraria o
  // EventJournal: desfazer é aplicar comandos, e consome sequências novas.
  const { orchestrator } = novo();
  const primeiro = await orchestrator.dispatch({ kind: "light/add", light: light("a") });
  const segundo = await orchestrator.dispatch({ kind: "light/add", light: light("b") });

  const desfeito = await orchestrator.undo();

  assert.ok(
    desfeito.results[0]!.commandSequence > segundo.commandSequence,
    "desfazer consome sequência NOVA",
  );
  assert.equal(desfeito.historyCursor, "1", "o cursor recua");
  assert.equal(
    desfeito.documentStateId,
    primeiro.documentStateId,
    "a identidade lógica volta ao estado anterior",
  );
});

test("um gesto com transactionId vira UMA entrada, não uma por comando", async () => {
  const { store, orchestrator } = novo();
  await orchestrator.dispatch({ kind: "level/define", level: level("l1") }, { actor: "human" });

  // três pinceladas do MESMO arrasto
  for (const [index, célula] of [0, 1, 2].entries()) {
    await orchestrator.dispatch(
      {
        kind: "level/patch",
        levelId: "l1",
        transactionId: "arrasto-1",
        changes: [{ index: célula, before: 0, after: 1 }],
      },
      { actor: "human" },
    );
    assert.equal(index >= 0, true);
  }

  const status = orchestrator.history.status();
  assert.equal(status.historyCursor, "2", "define + o gesto inteiro = duas entradas");

  // um único undo desfaz o arrasto completo
  await orchestrator.undo();
  assert.deepEqual(store.getLevel("l1")?.intGrid.slice(0, 3), [0, 0, 0]);
});

test("gestos com transactionId diferente NÃO se juntam", async () => {
  const { orchestrator } = novo();
  await orchestrator.dispatch({ kind: "level/define", level: level("l1") });
  await orchestrator.dispatch({
    kind: "level/patch",
    levelId: "l1",
    transactionId: "arrasto-1",
    changes: [{ index: 0, before: 0, after: 1 }],
  });
  await orchestrator.dispatch({
    kind: "level/patch",
    levelId: "l1",
    transactionId: "arrasto-2",
    changes: [{ index: 1, before: 0, after: 1 }],
  });

  assert.equal(orchestrator.history.status().historyCursor, "3");
});

test("editar depois de desfazer DESCARTA o ramo do redo", async () => {
  const { store, orchestrator } = novo();
  await orchestrator.dispatch({ kind: "light/add", light: light("a") });
  await orchestrator.dispatch({ kind: "light/add", light: light("b") });
  await orchestrator.undo();
  assert.equal(orchestrator.history.canRedo, true);

  await orchestrator.dispatch({ kind: "light/add", light: light("c") });

  assert.equal(orchestrator.history.canRedo, false, "o futuro morreu com a edição nova");
  assert.deepEqual(ids(store), ["a", "c"]);
  await assert.rejects(() => orchestrator.redo(), HistoryUnavailableError);
});

test("o CAS do cursor recusa desfazer sobre uma leitura velha", async () => {
  const { orchestrator } = novo();
  await orchestrator.dispatch({ kind: "light/add", light: light("a") });
  const cursorLido = orchestrator.history.historyCursor;

  // outro cliente edita nesse meio-tempo
  await orchestrator.dispatch({ kind: "light/add", light: light("b") });

  await assert.rejects(() => orchestrator.undo(cursorLido), HistoryConflictError);
  // sem o cursor, o desfazer passa (o cliente abriu mão do CAS)
  await orchestrator.undo();
});

test("desfazer PARA numa barreira em vez de fingir que reverteu", async () => {
  const { orchestrator } = novo();
  await orchestrator.dispatch({
    kind: "skeleton/define",
    skeleton: {
      skeletonId: "s1",
      bones: [{ id: 0, parentId: -1, inverseBindMatrix: [1, 0, 0, 1, 0, 0] }],
    },
  });

  assert.equal(orchestrator.history.canUndo, false);
  await assert.rejects(() => orchestrator.undo(), HistoryBarrierError);
});

test("o replay de abertura NÃO cria entradas desfazíveis", async () => {
  // Se criasse, abrir um projeto permitiria "desfazer" o documento inteiro
  // até o vazio — e o usuário perderia o projeto achando que voltou uma ação.
  const { orchestrator } = novo();
  await orchestrator.dispatch({ kind: "light/add", light: light("a") }, { mode: "prepare" });
  await orchestrator.dispatch({ kind: "light/add", light: light("b") }, { mode: "prepare" });

  assert.equal(orchestrator.history.canUndo, false);
  assert.equal(orchestrator.history.historyCursor, "0");
  assert.ok(orchestrator.history.lastSequence > 0n, "mas o relógio lógico avançou");
});

test("o rótulo é humano e em pt-BR, e a borda pode sobrescrevê-lo", async () => {
  const { orchestrator } = novo();
  await orchestrator.dispatch({ kind: "level/define", level: level("l1") }, { actor: "human" });
  assert.equal(orchestrator.history.status().undoLabel, "Criar nível");

  await orchestrator.dispatch(
    {
      kind: "level/patch",
      levelId: "l1",
      transactionId: "t1",
      changes: [{ index: 0, before: 0, after: 1 }],
      metadata: { actor: "human", label: "Apagar seleção" },
    } as BlueprintCommand,
    { actor: "human" },
  );
  assert.equal(orchestrator.history.status().undoLabel, "Apagar seleção");
});

test("a proveniência do gesto sobrevive no histórico e distingue agente de humano", async () => {
  const { orchestrator } = novo();
  await orchestrator.dispatch({ kind: "light/add", light: light("a") }, { actor: "agent" });

  const status = orchestrator.history.status();
  assert.equal(status.entries.at(-1)?.actor, "agent");
});

test("desfazer um gesto de N comandos publica N eventos em ordem", async () => {
  const { store, orchestrator } = novo();
  await orchestrator.dispatch({ kind: "level/define", level: level("l1") });
  await orchestrator.dispatch({
    kind: "world/place",
    placement: { levelId: "l1", x: 0, y: 0 },
  });

  // remover o nível gera inverso de DOIS comandos (define + place)
  const desfazivel = await orchestrator.dispatch({ kind: "level/remove", levelId: "l1" });
  assert.equal(desfazivel.historyEntry?.inverse.length, 2);

  const desfeito = await orchestrator.undo();
  assert.equal(desfeito.results.length, 2, "dois eventos, um por comando inverso");
  assert.deepEqual(
    desfeito.results.map((r) => r.event.kind),
    ["levelDefined", "worldLevelPlaced"],
  );
  assert.deepEqual(store.listPlacements(), [{ levelId: "l1", x: 0, y: 0 }]);
});

test("as entradas já desfeitas aparecem marcadas como tal no status", async () => {
  const { orchestrator } = novo();
  await orchestrator.dispatch({ kind: "light/add", light: light("a") });
  await orchestrator.dispatch({ kind: "light/add", light: light("b") });
  await orchestrator.undo();

  const status = orchestrator.history.status();
  assert.equal(status.entries.length, 2);
  assert.deepEqual(
    status.entries.map((entry) => entry.undone),
    [false, true],
  );
  assert.equal(status.canUndo, true);
  assert.equal(status.canRedo, true);
});
