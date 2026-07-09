import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANY_FILLED,
  resolveAutoTiles,
  type AutoTileRule,
  type IntGrid,
} from "../src/leveldesign/AutoTiler.js";

// IntGrid 4×3: uma plataforma de valor 1 na linha do meio
//   0 0 0 0
//   1 1 1 1
//   0 0 0 0
const PLATFORM: IntGrid = {
  width: 4,
  height: 3,
  values: [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0],
};

const GRASS_TOP: AutoTileRule = {
  name: "grass-top",
  patternSize: 3,
  // acima vazio, centro preenchido com 1
  pattern: [null, 0, null, null, 1, null, null, null, null],
  tileIds: [100],
};

const DIRT: AutoTileRule = {
  name: "dirt",
  patternSize: 1,
  pattern: [1],
  tileIds: [200],
};

test("regras derivam arte do significado: topo vira grama, resto vira terra", () => {
  const result = resolveAutoTiles(PLATFORM, [GRASS_TOP, DIRT], 7);
  // linha do meio inteira casa com grass-top (acima está vazio)
  for (let x = 0; x < 4; x++) {
    assert.equal(result.tiles[1 * 4 + x], 100, `cell (${x},1)`);
    assert.equal(result.ruleIndex[1 * 4 + x], 0);
  }
  // células vazias não recebem tile
  for (let x = 0; x < 4; x++) {
    assert.equal(result.tiles[x], -1);
    assert.equal(result.tiles[2 * 4 + x], -1);
  }
});

test("ordem das regras importa: first-match-wins", () => {
  // DIRT antes de GRASS_TOP: tudo vira terra
  const result = resolveAutoTiles(PLATFORM, [DIRT, GRASS_TOP], 7);
  for (let x = 0; x < 4; x++) {
    assert.equal(result.tiles[1 * 4 + x], 200);
  }
});

test("células fora dos limites contam como vazias", () => {
  // grid 1×1 preenchido: o padrão "acima vazio" casa porque acima é OOB
  const result = resolveAutoTiles({ width: 1, height: 1, values: [1] }, [GRASS_TOP], 0);
  assert.equal(result.tiles[0], 100);
});

test("negação e ANY_FILLED", () => {
  const grid: IntGrid = { width: 3, height: 1, values: [1, 2, 0] };
  const notWater: AutoTileRule = {
    name: "not-water",
    patternSize: 1,
    pattern: [-2], // qualquer coisa exceto valor 2 (inclusive vazio)
    tileIds: [10],
  };
  const anyFilled: AutoTileRule = {
    name: "any-filled",
    patternSize: 1,
    pattern: [ANY_FILLED],
    tileIds: [20],
  };
  const result = resolveAutoTiles(grid, [anyFilled, notWater], 0);
  assert.equal(result.tiles[0], 20); // 1 é preenchido
  assert.equal(result.tiles[1], 20); // 2 é preenchido
  assert.equal(result.tiles[2], 10); // vazio: não casa ANY_FILLED, casa NOT(2)
});

test("chance é decidida por hash determinístico e respeita extremos", () => {
  const grid: IntGrid = { width: 16, height: 16, values: new Array(256).fill(1) };
  const never: AutoTileRule = { patternSize: 1, pattern: [1], tileIds: [1], chance: 1e-9 };
  const always: AutoTileRule = { patternSize: 1, pattern: [1], tileIds: [2], chance: 1 };

  const noneApplied = resolveAutoTiles(grid, [never], 42);
  assert.ok([...noneApplied.tiles].every((t) => t === -1), "chance ~0 nunca aplica");

  const allApplied = resolveAutoTiles(grid, [always], 42);
  assert.ok([...allApplied.tiles].every((t) => t === 2), "chance 1 sempre aplica");

  // chance parcial: aplica em parte das células, deterministicamente
  const half: AutoTileRule = { patternSize: 1, pattern: [1], tileIds: [3], chance: 0.5 };
  const first = resolveAutoTiles(grid, [half], 42);
  const second = resolveAutoTiles(grid, [half], 42);
  assert.deepEqual([...first.tiles], [...second.tiles], "mesmo seed → mesmo resultado");
  const applied = [...first.tiles].filter((t) => t === 3).length;
  assert.ok(applied > 64 && applied < 192, `~metade das 256 células (obtido: ${applied})`);

  const other = resolveAutoTiles(grid, [half], 43);
  assert.notDeepEqual([...other.tiles], [...first.tiles], "seed diferente → padrão diferente");
});

test("variantes de tile são escolhidas deterministicamente por célula", () => {
  const grid: IntGrid = { width: 8, height: 8, values: new Array(64).fill(1) };
  const variants: AutoTileRule = { patternSize: 1, pattern: [1], tileIds: [10, 11, 12] };

  const a = resolveAutoTiles(grid, [variants], 5);
  const b = resolveAutoTiles(grid, [variants], 5);
  assert.deepEqual([...a.tiles], [...b.tiles]);

  const distinct = new Set([...a.tiles]);
  assert.ok(distinct.size > 1, "usa mais de uma variante");
  assert.ok([...distinct].every((t) => [10, 11, 12].includes(t as number)));
});

test("validações: padrão com tamanho errado, tileIds vazio, grid inconsistente", () => {
  assert.throws(
    () => resolveAutoTiles(PLATFORM, [{ patternSize: 3, pattern: [1], tileIds: [1] }]),
    /pattern must have 9 cells/,
  );
  assert.throws(
    () => resolveAutoTiles(PLATFORM, [{ patternSize: 1, pattern: [1], tileIds: [] }]),
    /tileIds must not be empty/,
  );
  assert.throws(
    () => resolveAutoTiles({ width: 2, height: 2, values: [0] }, [DIRT]),
    /expects 4 values/,
  );
});
