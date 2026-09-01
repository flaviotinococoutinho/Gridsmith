/**
 * Lógica pura das ferramentas do editor de níveis (core/levelEditorTools) —
 * extraída da vista para ser testável (organizada para crescer, PR-4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { IntGridDocument } from "../src/core/intGridDocument.js";
import {
  applyBrushAt,
  cellCenter,
  commitDrag,
  dragCells,
  hitMarker,
  nextEntityId,
  pickEntityDef,
  pickLevel,
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
  assert.deepEqual(applyBrushAt(doc, "pencil", 1, 1, 5), [{ index: 5, before: 0, after: 5 }]);
  assert.equal(doc.valueAt(1, 1), 5);
  assert.deepEqual(applyBrushAt(doc, "eraser", 1, 1, 5), [{ index: 5, before: 5, after: 0 }]);
  assert.equal(doc.valueAt(1, 1), 0);
  assert.equal(applyBrushAt(doc, "flood", 0, 0, 7).length, 16);
  assert.equal(doc.valueAt(3, 3), 7); // região conectada inteira
  assert.deepEqual(applyBrushAt(doc, "picker", 0, 0, 9), []);
  assert.deepEqual(applyBrushAt(doc, "entity", 0, 0, 9), []);
});

test("commitDrag: rect/line devolvem o lote do gesto; outras ferramentas, nada", () => {
  const doc = new IntGridDocument(6, 6);
  // um arrasto é UM gesto, logo UM comando canônico — o lote sai inteiro
  assert.equal(commitDrag(doc, "rect", { x: 0, y: 0 }, { x: 2, y: 2 }, 3).length, 9);

  assert.equal(commitDrag(doc, "line", { x: 0, y: 5 }, { x: 5, y: 5 }, 2).length, 6);
  assert.equal(doc.valueAt(5, 5), 2);
  assert.deepEqual(commitDrag(doc, "pencil", { x: 0, y: 0 }, { x: 1, y: 1 }, 9), []);
});

test("cellCenter ancora no centro da célula em pixels do mundo", () => {
  assert.deepEqual(cellCenter(0, 0, 16), [8, 8]);
  assert.deepEqual(cellCenter(3, 2, 16), [56, 40]);
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

// ---------------------------------------------------------------- seletores
//
// Estas duas decisões definem o que o usuário vê ao abrir um projeto. Quando
// eram constantes na vista ("nivel-1", "jogador"), um projeto criado pelo
// template canônico ("level-1", "player") abria com o canvas vazio.

test("pickLevel: sem preferência abre o primeiro nível do projeto", () => {
  const levels = [{ levelId: "level-1" }, { levelId: "outro" }];
  assert.equal(pickLevel(levels)?.levelId, "level-1");
});

test("pickLevel: respeita o nível preferido quando ele existe", () => {
  const levels = [{ levelId: "level-1" }, { levelId: "subsolo" }];
  assert.equal(pickLevel(levels, "subsolo")?.levelId, "subsolo");
});

test("pickLevel: preferência inexistente não deixa o canvas vazio", () => {
  const levels = [{ levelId: "level-1" }];
  // era exatamente este caso que quebrava: o editor pedia "nivel-1" e o
  // projeto tinha "level-1" — em vez de nada, abre o que existe
  assert.equal(pickLevel(levels, "nivel-1")?.levelId, "level-1");
});

test("pickLevel: projeto sem nível nenhum devolve undefined", () => {
  assert.equal(pickLevel([]), undefined);
  assert.equal(pickLevel([], "qualquer"), undefined);
});

test("pickEntityDef: prefere definição com archetypeId (a que vira ator vivo)", () => {
  const defs = [
    { entityDefId: "decorativo" },
    { entityDefId: "player", archetypeId: "player" },
  ];
  assert.equal(pickEntityDef(defs)?.entityDefId, "player");
});

test("pickEntityDef: sem nenhuma com archetypeId, cai na primeira", () => {
  const defs = [{ entityDefId: "decorativo" }, { entityDefId: "outro" }];
  assert.equal(pickEntityDef(defs)?.entityDefId, "decorativo");
});

test("pickEntityDef: archetypeId vazio não conta como spawnável", () => {
  const defs = [{ entityDefId: "vazio", archetypeId: "" }, { entityDefId: "bom", archetypeId: "p" }];
  assert.equal(pickEntityDef(defs)?.entityDefId, "bom");
});

test("pickEntityDef: projeto sem definições devolve undefined", () => {
  assert.equal(pickEntityDef([]), undefined);
});
