import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackTileColor, tileRegion, type TilesetTable } from "../src/core/tilesetAtlas.js";

/**
 * ESTES CASOS SÃO ESPELHADOS na engine (`TilesetTableTests.cs`), número a
 * número: a paridade visual da ADR-022 depende de a fórmula da grade ser
 * idêntica nos dois lados, e o espelhamento é o que transforma essa promessa
 * em teste — mudar a fórmula de UM lado quebra a suíte DELE com os mesmos
 * valores que o outro continua afirmando.
 */
const TABLE: TilesetTable = {
  tilesetId: "terreno",
  image: "assets/terreno.png",
  tileSize: 16,
  columns: 8,
  tileCount: 48,
};

test("a região é fórmula da grade: id 0, meio de linha, quebra de linha e último id", () => {
  assert.deepEqual(tileRegion(TABLE, 0), { x: 0, y: 0, width: 16, height: 16 });
  assert.deepEqual(tileRegion(TABLE, 3), { x: 48, y: 0, width: 16, height: 16 });
  // 8 colunas: o id 8 quebra para a segunda linha
  assert.deepEqual(tileRegion(TABLE, 8), { x: 0, y: 16, width: 16, height: 16 });
  assert.deepEqual(tileRegion(TABLE, 47), { x: 112, y: 80, width: 16, height: 16 });
});

test("fora de [0, tileCount) NÃO é erro: é ausência de arte (fallback conjunto)", () => {
  assert.equal(tileRegion(TABLE, -1), undefined);
  assert.equal(tileRegion(TABLE, 48), undefined);
  assert.equal(tileRegion(TABLE, 2.5), undefined, "id fracionário não amostra meia célula");
});

test("a cor de fallback é o MESMO hash determinístico do host", () => {
  // valores fixados: se o hash mudar de um lado só, os dois lados degradam
  // para cores diferentes e a degradação conjunta — que é contrato — quebra
  assert.equal(fallbackTileColor(0), "#505050");
  assert.equal(fallbackTileColor(1), "#81c987");
  assert.equal(fallbackTileColor(7), "#a7a354");
  assert.equal(fallbackTileColor(1), fallbackTileColor(1), "mesma entrada, mesma cor, sempre");
});
