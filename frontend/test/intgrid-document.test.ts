import assert from "node:assert/strict";
import { test } from "node:test";
import { IntGridDocument } from "../src/core/intGridDocument.js";

test("paint altera a célula e undo/redo restauram exatamente", () => {
  const doc = new IntGridDocument(4, 3);
  assert.equal(doc.paint(1, 1, 5), true);
  assert.equal(doc.valueAt(1, 1), 5);
  assert.equal(doc.canUndo, true);

  assert.equal(doc.undo(), true);
  assert.equal(doc.valueAt(1, 1), 0);
  assert.equal(doc.canRedo, true);

  assert.equal(doc.redo(), true);
  assert.equal(doc.valueAt(1, 1), 5);
});

test("pintar o mesmo valor é no-op e não polui o histórico", () => {
  const doc = new IntGridDocument(2, 2);
  doc.paint(0, 0, 1);
  assert.equal(doc.paint(0, 0, 1), false);
  doc.undo();
  assert.equal(doc.canUndo, false); // só havia UMA operação real
});

test("edição nova invalida a pilha de redo", () => {
  const doc = new IntGridDocument(2, 2);
  doc.paint(0, 0, 1);
  doc.undo();
  doc.paint(1, 1, 2); // nova linha do tempo
  assert.equal(doc.canRedo, false);
  assert.equal(doc.valueAt(0, 0), 0);
  assert.equal(doc.valueAt(1, 1), 2);
});

test("fillRect aceita cantos em qualquer ordem e desfaz em bloco", () => {
  const doc = new IntGridDocument(5, 5);
  doc.paint(2, 2, 9); // célula pré-existente dentro do retângulo
  assert.equal(doc.fillRect(3, 3, 1, 1, 7), true);

  for (let y = 1; y <= 3; y++) {
    for (let x = 1; x <= 3; x++) {
      assert.equal(doc.valueAt(x, y), 7);
    }
  }
  assert.equal(doc.valueAt(0, 0), 0);

  doc.undo(); // o retângulo inteiro volta — inclusive o 9 anterior
  assert.equal(doc.valueAt(2, 2), 9);
  assert.equal(doc.valueAt(1, 1), 0);
});

test("floodFill preenche só a região 4-conectada", () => {
  //  1 1 0
  //  0 1 0
  //  0 0 1   ← o canto (2,2) NÃO é conectado ao grupo
  const doc = new IntGridDocument(3, 3, [1, 1, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(doc.floodFill(0, 0, 4), true);

  assert.deepEqual(doc.snapshot(), [4, 4, 0, 0, 4, 0, 0, 0, 1]);
  doc.undo();
  assert.deepEqual(doc.snapshot(), [1, 1, 0, 0, 1, 0, 0, 0, 1]);
});

test("floodFill com o mesmo valor é no-op", () => {
  const doc = new IntGridDocument(2, 2, [3, 3, 3, 3]);
  assert.equal(doc.floodFill(0, 0, 3), false);
  assert.equal(doc.canUndo, false);
});

test("toLevelPayload produz o shape do comando level/define", () => {
  const doc = new IntGridDocument(2, 2);
  doc.fillRect(0, 1, 1, 1, 1); // linha de baixo preenchida
  const rules = [{ patternSize: 1, pattern: [1], tileIds: [200] }];
  const payload = doc.toLevelPayload({ levelId: "l1", tileSize: 16, seed: 9, rules });

  assert.deepEqual(payload, {
    levelId: "l1",
    width: 2,
    height: 2,
    tileSize: 16,
    seed: 9,
    intGrid: [0, 0, 1, 1],
    rules,
  });
});

test("validações: célula fora do grid, valor inválido, dimensões erradas", () => {
  const doc = new IntGridDocument(2, 2);
  assert.throws(() => doc.paint(2, 0, 1), RangeError);
  assert.throws(() => doc.paint(0, 0, -1), RangeError);
  assert.throws(() => doc.paint(0, 0, 1.5), RangeError);
  assert.throws(() => new IntGridDocument(0, 2), RangeError);
  assert.throws(() => new IntGridDocument(2, 2, [1]), RangeError);
});

test("paintLine traça Bresenham inclusiva em qualquer octante e desfaz em bloco", () => {
  const doc = new IntGridDocument(6, 6);
  assert.equal(doc.paintLine(0, 0, 5, 2, 4), true);
  // extremos sempre pintados; linha contínua (célula por coluna neste octante)
  assert.equal(doc.valueAt(0, 0), 4);
  assert.equal(doc.valueAt(5, 2), 4);
  const painted = doc.snapshot().filter((v) => v === 4).length;
  assert.equal(painted, 6); // uma célula por coluna (dx dominante)

  doc.undo();
  assert.equal(doc.snapshot().every((v) => v === 0), true); // UMA operação

  // linha vertical e diagonal invertida também funcionam
  assert.equal(doc.paintLine(3, 4, 3, 1, 2), true);
  assert.equal(doc.valueAt(3, 1), 2);
  assert.equal(doc.valueAt(3, 4), 2);
});

test("paintLine sobre células já corretas é no-op", () => {
  const doc = new IntGridDocument(3, 1, [7, 7, 7]);
  assert.equal(doc.paintLine(0, 0, 2, 0, 7), false);
  assert.equal(doc.canUndo, false);
});

test("lineCells é inclusiva e simétrica nos extremos", async () => {
  const { lineCells } = await import("../src/core/intGridDocument.js");
  const forward = lineCells(0, 0, 3, 3);
  assert.deepEqual(forward[0], [0, 0]);
  assert.deepEqual(forward[forward.length - 1], [3, 3]);
  assert.equal(forward.length, 4); // diagonal perfeita: uma célula por passo
  assert.equal(lineCells(2, 2, 2, 2).length, 1); // ponto único
});
