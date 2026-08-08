import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CELL_ORIGIN,
  ENTITY_ANCHOR,
  WORLD_POSITION_UNIT,
  WORLD_Y_AXIS,
  cellToWorldCenter,
  worldToCell,
} from "../src/leveldesign/GridCoordinates.js";

test("a convenção espacial é declarada em constantes, não em comentário", () => {
  assert.equal(WORLD_POSITION_UNIT, "world-pixel");
  assert.equal(CELL_ORIGIN, "top-left");
  assert.equal(WORLD_Y_AXIS, "down");
  assert.equal(ENTITY_ANCHOR, "center");
});

test("célula vira o CENTRO da célula em pixels do mundo", () => {
  assert.deepEqual([...cellToWorldCenter({ x: 0, y: 0 }, 16)], [8, 8]);
  assert.deepEqual([...cellToWorldCenter({ x: 2, y: 7 }, 16)], [40, 120]);
  assert.deepEqual([...cellToWorldCenter({ x: 3, y: 3 }, 16)], [56, 56]);
});

test("célula fracionária é RECUSADA — meia célula não é uma célula", () => {
  // A recusa é a guarda que impede a ambiguidade de voltar: quem precisa de um
  // ponto fora do centro de célula tem de dizer isso na origem.
  assert.throws(() => cellToWorldCenter({ x: 8, y: 4.5 }, 16), RangeError);
  assert.throws(() => cellToWorldCenter({ x: -1, y: 0 }, 16), RangeError);
});

test("tileSize inválido é recusado", () => {
  assert.throws(() => cellToWorldCenter({ x: 0, y: 0 }, 0), RangeError);
  assert.throws(() => cellToWorldCenter({ x: 0, y: 0 }, 1.5), RangeError);
});

test("worldToCell inverte cellToWorldCenter para qualquer ponto dentro da célula", () => {
  for (const cell of [
    { x: 0, y: 0 },
    { x: 2, y: 7 },
    { x: 19, y: 13 },
  ]) {
    const center = cellToWorldCenter(cell, 16);
    assert.deepEqual(worldToCell(center, 16), cell);
  }
  // e qualquer pixel da célula mapeia para a mesma célula, não só o centro
  assert.deepEqual(worldToCell([32, 112], 16), { x: 2, y: 7 });
  assert.deepEqual(worldToCell([47, 127], 16), { x: 2, y: 7 });
});

test("worldToCell recusa posição malformada", () => {
  assert.throws(() => worldToCell([Number.NaN, 0] as [number, number], 16), TypeError);
  assert.throws(() => worldToCell([0] as unknown as [number, number], 16), TypeError);
});
