/**
 * Lógica pura das ferramentas do editor de níveis (core/levelEditorTools) —
 * extraída da vista para ser testável (organizada para crescer, PR-4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { IntGridDocument } from "../src/core/intGridDocument.js";
import { SelectionService } from "../src/core/selectionService.js";
import {
  activateLevelEditorTool,
  applyBrushAt,
  applyBrushStroke,
  commitDrag,
  dragCells,
  hitMarker,
  LEVEL_EDITOR_TOOL_CONTROLLER_SERVICE,
  nextEntityId,
  type LevelEditorToolInput,
} from "../src/core/levelEditorTools.js";

test("edição canônica: dragCells cobre retângulo e linha", () => {
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

test("edição canônica: brushes compartilham uma transação", () => {
  const doc = new IntGridDocument(4, 4);
  doc.beginGesture("brushes", "Pintar");
  assert.equal(applyBrushAt(doc, "pencil", 1, 1, 5), true);
  assert.equal(doc.valueAt(1, 1), 5);
  assert.equal(applyBrushAt(doc, "eraser", 1, 1, 5), true);
  assert.equal(doc.valueAt(1, 1), 0);
  assert.equal(applyBrushAt(doc, "flood", 0, 0, 7), true);
  assert.equal(doc.valueAt(3, 3), 7); // região conectada inteira
  assert.equal(applyBrushAt(doc, "picker", 0, 0, 9), false);
  assert.equal(applyBrushAt(doc, "entity", 0, 0, 9), false);
  const gesture = doc.finishGesture();
  assert.equal(gesture?.transactionId, "brushes");
  assert.ok((gesture?.changes.length ?? 0) > 1);
});

test("edição canônica: rect/line viram um patch por gesto", () => {
  const doc = new IntGridDocument(6, 6);
  doc.beginGesture("rect", "Retângulo");
  assert.equal(commitDrag(doc, "rect", { x: 0, y: 0 }, { x: 2, y: 2 }, 3), true);
  assert.equal(doc.finishGesture()?.changes.length, 9);
  doc.acknowledge("rect");

  doc.beginGesture("line", "Linha");
  assert.equal(commitDrag(doc, "line", { x: 0, y: 5 }, { x: 5, y: 5 }, 2), true);
  assert.equal(doc.finishGesture()?.changes.length, 6);
  assert.equal(doc.valueAt(5, 5), 2);
  doc.beginGesture("noop", "No-op");
  assert.equal(commitDrag(doc, "pencil", { x: 0, y: 0 }, { x: 1, y: 1 }, 9), false);
  assert.equal(doc.finishGesture(), undefined);
});

test("edição canônica: pincel contínuo interpola e coalesce o drag", () => {
  const doc = new IntGridDocument(6, 1);
  doc.beginGesture("stroke", "Pintar células");
  assert.equal(
    applyBrushStroke(doc, "pencil", { x: 0, y: 0 }, { x: 5, y: 0 }, 4),
    true,
  );
  const gesture = doc.finishGesture();
  assert.equal(gesture?.changes.length, 6);
  assert.equal(doc.pendingTransactionIds.length, 1);
});

test("edição canônica: hitMarker respeita projeção e raio", () => {
  const markers = [
    { entityId: "a", position: [10, 10] as const },
    { entityId: "b", position: [50, 50] as const },
  ];
  const identity = (x: number, y: number): { x: number; y: number } => ({ x, y });
  assert.equal(hitMarker(markers, 12, 11, identity, 6)?.entityId, "a");
  assert.equal(hitMarker(markers, 49, 52, identity, 6)?.entityId, "b");
  assert.equal(hitMarker(markers, 30, 30, identity, 6), undefined); // fora do raio
});

test("edição canônica: nextEntityId pula ids ocupados", () => {
  const existing = new Map([
    ["jogador-1", {}],
    ["jogador-2", {}],
  ]);
  assert.equal(nextEntityId(existing, "jogador"), "jogador-3");
  existing.set("jogador-3", {});
  existing.delete("jogador-1"); // {2,3}: size+1 = 3 está ocupado → avança para 4
  assert.equal(nextEntityId(existing, "jogador"), "jogador-4");
});

test("workbench adaptativo: contribuição ativa a strategy fornecida pela vista", () => {
  const observed: LevelEditorToolInput[] = [];
  const services = new Map<string, unknown>([[
    LEVEL_EDITOR_TOOL_CONTROLLER_SERVICE,
    {
      activate: (kind: string) => ({
        handleInput: (input: LevelEditorToolInput) => observed.push(input),
        dispose: () => undefined,
        kind,
      }),
    },
  ]]);
  const instance = activateLevelEditorTool("pencil", {
    selection: new SelectionService("session-a"),
    capabilities: () => ({ enabled: true, reason: "Disponível" }),
    mode: "edit",
    services,
  });
  instance.handleInput({ type: "pointer-down", screenX: 10, screenY: 20, button: 0 });
  assert.deepEqual(observed, [
    { type: "pointer-down", screenX: 10, screenY: 20, button: 0 },
  ]);

  assert.throws(
    () => activateLevelEditorTool("eraser", {
      selection: new SelectionService("session-a"),
      capabilities: () => ({ enabled: true, reason: "Disponível" }),
      mode: "edit",
    }),
    /não forneceu o controlador/,
  );
});
