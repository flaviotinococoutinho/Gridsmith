import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEVEL_PALETTE,
  TILE_COLORS,
  assertPresetsConsistent,
  defaultLevelRules,
} from "../src/core/levelPresets.js";
// Contrato real do middleware: as regras default DEVEM validar contra ele.
import { resolveAutoTiles, validateRules } from "@gridsmith/middleware/dist/leveldesign/AutoTiler.js";

test("regras default validam contra o contrato AutoTileRule do middleware", () => {
  validateRules(defaultLevelRules() as never); // lança se o shape divergir
});

test("presets são consistentes: tiles com cor, valores da paleta cobertos", () => {
  assertPresetsConsistent();
  assert.ok(LEVEL_PALETTE.every((p) => p.shortcut.length === 1));
});

test("preview ≡ publicação: as regras derivam grama no topo e terra embaixo", () => {
  // plataforma 4×3: linha do meio é chão
  const grid = { width: 4, height: 3, values: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1] };
  const resolved = resolveAutoTiles(grid, defaultLevelRules() as never, 7);

  for (let x = 0; x < 4; x++) {
    const top = resolved.tiles[4 + x]!;
    assert.ok(top === 100 || top === 101, `topo exposto vira grama (célula ${x})`);
    assert.equal(resolved.tiles[8 + x], 200, "linha coberta vira terra");
    assert.ok(TILE_COLORS[top], "todo tile do preview tem cor de arte");
  }
});

test("parede e perigo mapeiam direto", () => {
  const grid = { width: 2, height: 1, values: [2, 3] };
  const resolved = resolveAutoTiles(grid, defaultLevelRules() as never, 0);
  assert.equal(resolved.tiles[0], 210);
  assert.equal(resolved.tiles[1], 220);
});
