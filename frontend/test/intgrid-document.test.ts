import assert from "node:assert/strict";
import { test } from "node:test";
import { IntGridDocument, lineCells } from "../src/core/intGridDocument.js";

test("edição canônica: gesto agrega células e preserva first-before/last-after", () => {
  const doc = new IntGridDocument(4, 2);
  doc.beginGesture("tx-1", "Pintar células");
  doc.paint(0, 0, 1);
  doc.paint(1, 0, 2);
  doc.paint(0, 0, 3);
  const gesture = doc.finishGesture();

  assert.deepEqual(gesture, {
    transactionId: "tx-1",
    label: "Pintar células",
    changes: [
      { index: 0, before: 0, after: 3 },
      { index: 1, before: 0, after: 2 },
    ],
  });
  assert.deepEqual(doc.snapshot().slice(0, 2), [3, 2]);
  assert.deepEqual(doc.confirmedSnapshot().slice(0, 2), [0, 0]);
});

test("edição canônica: ack confirma e rejeição recompõe sem histórico local", () => {
  const doc = new IntGridDocument(2, 1);
  doc.beginGesture("accepted", "Primeiro");
  doc.paint(0, 0, 4);
  doc.finishGesture();
  assert.equal(doc.acknowledge("accepted"), true);
  assert.deepEqual(doc.confirmedSnapshot(), [4, 0]);

  doc.beginGesture("rejected", "Segundo");
  doc.paint(1, 0, 9);
  doc.finishGesture();
  assert.deepEqual(doc.snapshot(), [4, 9]);
  assert.equal(doc.reject("rejected"), true);
  assert.deepEqual(doc.snapshot(), [4, 0]);
  assert.equal("undo" in doc, false);
  assert.equal("redo" in doc, false);
});

test("edição canônica: voltar ao before elimina o no-op do patch", () => {
  const doc = new IntGridDocument(2, 1, [7, 0]);
  doc.beginGesture("tx", "No-op");
  doc.paint(0, 0, 3);
  doc.paint(0, 0, 7);
  assert.equal(doc.finishGesture(), undefined);
  assert.deepEqual(doc.snapshot(), [7, 0]);
});

test("edição canônica: patches pendentes mantêm ordem de ack", () => {
  const doc = new IntGridDocument(1, 1);
  doc.beginGesture("a", "A");
  doc.paint(0, 0, 1);
  doc.finishGesture();
  doc.beginGesture("b", "B");
  doc.paint(0, 0, 2);
  doc.finishGesture();

  doc.acknowledge("b");
  assert.deepEqual(doc.confirmedSnapshot(), [0]);
  assert.deepEqual(doc.snapshot(), [2]);
  doc.acknowledge("a");
  assert.deepEqual(doc.confirmedSnapshot(), [2]);
});

test("edição canônica: linha, retângulo e balde produzem mudanças incrementais", () => {
  const doc = new IntGridDocument(4, 4);
  doc.beginGesture("line", "Linha");
  assert.equal(doc.paintLine(0, 0, 3, 3, 2), true);
  assert.equal(doc.finishGesture()?.changes.length, 4);
  doc.acknowledge("line");

  doc.beginGesture("rect", "Retângulo");
  assert.equal(doc.fillRect(0, 2, 1, 3, 5), true);
  assert.equal(doc.finishGesture()?.changes.length, 4);
  doc.acknowledge("rect");

  doc.beginGesture("fill", "Balde");
  assert.equal(doc.floodFill(3, 0, 8), true);
  assert.ok((doc.finishGesture()?.changes.length ?? 0) > 0);
});

test("edição canônica: evento remoto atualiza base sem remover camada local", () => {
  const doc = new IntGridDocument(2, 1);
  doc.beginGesture("local", "Local");
  doc.paint(1, 0, 5);
  doc.finishGesture();
  doc.applyCanonical([{ index: 0, before: 0, after: 9 }], "remote");
  assert.deepEqual(doc.confirmedSnapshot(), [9, 0]);
  assert.deepEqual(doc.snapshot(), [9, 5]);
});

test("edição canônica: settle de ACK atrasado remove pending sem reaplicar after", () => {
  const doc = new IntGridDocument(1, 1);
  doc.beginGesture("late", "Late");
  doc.paint(0, 0, 1);
  doc.finishGesture();
  doc.applyCanonical([{ index: 0, before: 1, after: 2 }], "newer");

  assert.equal(doc.settlePending("late"), true);
  assert.deepEqual(doc.confirmedSnapshot(), [2]);
  assert.deepEqual(doc.snapshot(), [2]);
});

test("edição canônica: valida dimensões, valores e exige gesto", () => {
  const doc = new IntGridDocument(2, 2);
  assert.throws(() => doc.paint(0, 0, 1), /gesture must be open/);
  doc.beginGesture("tx", "Teste");
  assert.throws(() => doc.paint(2, 0, 1), RangeError);
  assert.throws(() => doc.paint(0, 0, -1), RangeError);
  assert.throws(() => new IntGridDocument(0, 2), RangeError);
  assert.throws(() => new IntGridDocument(2, 2, [1]), RangeError);
});

test("edição canônica: Bresenham é inclusiva e simétrica nos extremos", () => {
  const cells = lineCells(0, 0, 3, 3);
  assert.deepEqual(cells[0], [0, 0]);
  assert.deepEqual(cells.at(-1), [3, 3]);
  assert.equal(lineCells(2, 2, 2, 2).length, 1);
});
