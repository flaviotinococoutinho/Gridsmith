import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PaintGesture,
  planGestureCommand,
  rememberOwnSequence,
  shouldRehydrate,
} from "../src/core/paintGesture.js";

test("o gesto preserva o before ORIGINAL de uma célula tocada duas vezes", () => {
  // é a regra de correção da frente: o domínio confere `before` contra o que
  // ELE tem, que é o estado de antes do gesto. Guardar o before da segunda
  // passada faria o servidor recusar uma pincelada legítima como se fosse
  // edição sobre leitura velha.
  const gesture = new PaintGesture();
  gesture.record([{ index: 4, before: 0, after: 1 }]);
  gesture.record([{ index: 4, before: 1, after: 2 }]);

  assert.deepEqual(gesture.changes(), [{ index: 4, before: 0, after: 2 }]);
});

test("célula que volta ao valor de origem no mesmo gesto sai do lote", () => {
  const gesture = new PaintGesture();
  gesture.record([{ index: 7, before: 3, after: 5 }]);
  gesture.record([{ index: 7, before: 5, after: 3 }]); // desfeita na própria pincelada
  gesture.record([{ index: 2, before: 0, after: 1 }]);

  assert.deepEqual(gesture.changes(), [{ index: 2, before: 0, after: 1 }]);
});

test("o lote sai ordenado por índice — payload determinístico", () => {
  const gesture = new PaintGesture();
  gesture.record([{ index: 9, before: 0, after: 1 }]);
  gesture.record([{ index: 2, before: 0, after: 1 }]);
  gesture.record([{ index: 5, before: 0, after: 1 }]);

  assert.deepEqual(
    gesture.changes().map((c) => c.index),
    [2, 5, 9],
  );
});

test("gesto vazio não vira comando", () => {
  // um clique que repinta o valor que já estava lá criaria um item de
  // histórico que não desfaz nada — e o domínio recusa `changes` vazio
  const gesture = new PaintGesture();
  assert.equal(gesture.isEmpty, true);
  assert.equal(
    planGestureCommand({
      levelId: "n1",
      transactionId: "t1",
      changes: gesture.changes(),
      levelInBlueprint: true,
      definePayload: () => {
        throw new Error("não deveria ser chamado");
      },
    }),
    undefined,
  );
});

test("nível já no Blueprint: o gesto vira level/patch com o transactionId", () => {
  const command = planGestureCommand({
    levelId: "n1",
    transactionId: "gesto-1",
    changes: [{ index: 1, before: 0, after: 2 }],
    levelInBlueprint: true,
    definePayload: () => ({ nunca: true }),
  });

  assert.equal(command?.kind, "level/patch");
  assert.deepEqual(command?.payload, {
    levelId: "n1",
    changes: [{ index: 1, before: 0, after: 2 }],
    transactionId: "gesto-1",
  });
});

test("nível ainda não publicado: a primeira pincelada o CRIA com level/define", () => {
  // sem este ramo a primeira pincelada de um projeto novo falharia (patch
  // exige nível existente) e a pintura voltaria a ser local até alguém
  // clicar "Publicar" — exatamente a segunda verdade que a F6 elimina
  const command = planGestureCommand({
    levelId: "n1",
    transactionId: "gesto-1",
    changes: [{ index: 1, before: 0, after: 2 }],
    levelInBlueprint: false,
    definePayload: () => ({ levelId: "n1", width: 2, height: 1, intGrid: [0, 2] }),
  });

  assert.equal(command?.kind, "level/define");
  assert.deepEqual(command?.payload, {
    levelId: "n1",
    width: 2,
    height: 1,
    intGrid: [0, 2],
    transactionId: "gesto-1",
  });
});

test("o eco do próprio gesto não reidrata; o que veio de fora, sim", () => {
  const own = new Set<string>(["12"]);

  // o canvas já mostra o que ESTE gesto pintou: reconsultar a cada traço
  // faria o editor piscar
  assert.equal(shouldRehydrate("levelPatched", "12", own), false);
  // e a sequência é consumida: um evento externo futuro não herda o perdão
  assert.equal(own.has("12"), false);

  // desfazer canônico, agente ou outra borda: o canvas precisa acompanhar
  assert.equal(shouldRehydrate("levelPatched", "13", own), true);
  assert.equal(shouldRehydrate("levelDefined", "14", own), true);
  assert.equal(shouldRehydrate("levelUpdated", "15", own), true);
});

test("evento que não mexe no grid não reidrata", () => {
  const own = new Set<string>();
  assert.equal(shouldRehydrate("entityPlaced", "20", own), false);
  assert.equal(shouldRehydrate("tilesetDefined", "21", own), false);
});

test("a memória de gestos próprios tem teto — sessão longa não vaza", () => {
  // o conjunto só encolhe quando o evento chega; se o stream cair, pintar a
  // tarde inteira acumularia uma string por pincelada para sempre
  const own = new Set<string>();
  for (let i = 0; i < 300; i++) rememberOwnSequence(own, `s${i}`, 256);

  assert.equal(own.size, 256);
  assert.equal(own.has("s299"), true, "a mais recente fica");
  assert.equal(own.has("s0"), false, "a mais antiga sai");
});
