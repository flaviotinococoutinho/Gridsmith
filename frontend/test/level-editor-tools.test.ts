/**
 * Lógica pura das ferramentas do editor de níveis (core/levelEditorTools) —
 * extraída da vista para ser testável (organizada para crescer, PR-4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { IntGridDocument } from "../src/core/intGridDocument.js";
import {
  applyBrushAt,
  commitDrag,
  dragCells,
  hitMarker,
  nextEntityId,
} from "../src/core/levelEditorTools.js";

test("dragCells: retângulo cobre a área em qualquer ordem de cantos; linha usa Bresenham", () => {
  const rect = dragCells("rect", { x: 3, y: 2 }, { x: 1, y: 1 });
  assert.equal(rect.length, 6); // 3x2
  assert.deepEqual(rect[0], [1, 1]);
  assert.deepEqual(rect.at(-1), [3, 2]);

  const line = dragCells("line", { x: 0, y: 0 }, { x: 3, y: 3 });
  assert.equal(line.length, 4); // diagonal perfeita
  assert.deepEqual(line[0], [0, 0]);
  assert.deepEqual(line.at(-1), [3, 3]);

  // sem âncora/corrente ou ferramenta não-arrasto: vazio
  assert.deepEqual(dragCells("rect", undefined, { x: 1, y: 1 }), []);
  assert.deepEqual(dragCells("pencil", { x: 0, y: 0 }, { x: 1, y: 1 }), []);
});

test("applyBrushAt: pencil pinta, eraser zera, flood preenche região; picker/entity são no-op", () => {
  const doc = new IntGridDocument(4, 4);
  assert.equal(applyBrushAt(doc, "pencil", 1, 1, 5), true);
  assert.equal(doc.valueAt(1, 1), 5);
  assert.equal(applyBrushAt(doc, "eraser", 1, 1, 5), true);
  assert.equal(doc.valueAt(1, 1), 0);
  assert.equal(applyBrushAt(doc, "flood", 0, 0, 7), true);
  assert.equal(doc.valueAt(3, 3), 7); // região conectada inteira
  assert.equal(applyBrushAt(doc, "picker", 0, 0, 9), false);
  assert.equal(applyBrushAt(doc, "entity", 0, 0, 9), false);
});

test("commitDrag: rect/line viram UMA operação de undo; outras ferramentas são no-op", () => {
  const doc = new IntGridDocument(6, 6);
  assert.equal(commitDrag(doc, "rect", { x: 0, y: 0 }, { x: 2, y: 2 }, 3), true);
  doc.undo();
  assert.equal(doc.snapshot().every((v) => v === 0), true); // um undo desfez tudo

  assert.equal(commitDrag(doc, "line", { x: 0, y: 5 }, { x: 5, y: 5 }, 2), true);
  assert.equal(doc.valueAt(5, 5), 2);
  assert.equal(commitDrag(doc, "pencil", { x: 0, y: 0 }, { x: 1, y: 1 }, 9), false);
});

test("hitMarker: projeção injetada, raio respeitado, primeiro acerto vence", () => {
  const markers = [
    { entityId: "a", position: [10, 10] as const },
    { entityId: "b", position: [50, 50] as const },
  ];
  const identity = (x: number, y: number): { x: number; y: number } => ({ x, y });
  assert.equal(hitMarker(markers, 12, 11, identity, 6)?.entityId, "a");
  assert.equal(hitMarker(markers, 49, 52, identity, 6)?.entityId, "b");
  assert.equal(hitMarker(markers, 30, 30, identity, 6), undefined); // fora do raio
});

test("nextEntityId: incremental e pulando ids ocupados", () => {
  const existing = new Map([
    ["jogador-1", {}],
    ["jogador-2", {}],
  ]);
  assert.equal(nextEntityId(existing, "jogador"), "jogador-3");
  existing.set("jogador-3", {});
  existing.delete("jogador-1"); // {2,3}: size+1 = 3 está ocupado → avança para 4
  assert.equal(nextEntityId(existing, "jogador"), "jogador-4");
});
