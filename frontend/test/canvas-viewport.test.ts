import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasViewport, MAX_ZOOM, MIN_ZOOM } from "../src/core/canvasViewport.js";

test("transformações tela↔mundo são inversas", () => {
  const viewport = new CanvasViewport(800, 600);
  viewport.panByScreen(-120, 40);
  viewport.zoomAt(200, 150, 2.5);

  for (const [sx, sy] of [[0, 0], [400, 300], [799, 599]] as const) {
    const world = viewport.screenToWorld(sx, sy);
    const screen = viewport.worldToScreen(world.x, world.y);
    assert.ok(Math.abs(screen.x - sx) < 1e-6);
    assert.ok(Math.abs(screen.y - sy) < 1e-6);
  }
});

test("zoom é centrado no cursor: o ponto do mundo sob o cursor não se move", () => {
  const viewport = new CanvasViewport(800, 600);
  viewport.panByScreen(-50, -30);

  const cursor = { x: 320, y: 240 };
  const before = viewport.screenToWorld(cursor.x, cursor.y);
  viewport.zoomAt(cursor.x, cursor.y, 2);
  const after = viewport.screenToWorld(cursor.x, cursor.y);

  assert.ok(Math.abs(before.x - after.x) < 1e-6);
  assert.ok(Math.abs(before.y - after.y) < 1e-6);
  assert.equal(viewport.current.zoom, 2);
});

test("zoom clampa nos limites configurados", () => {
  const viewport = new CanvasViewport(800, 600);
  viewport.zoomAt(0, 0, 1e9);
  assert.equal(viewport.current.zoom, MAX_ZOOM);
  viewport.zoomAt(0, 0, 1e-9);
  assert.equal(viewport.current.zoom, MIN_ZOOM);
});

test("pan em pixels de tela move o mundo na proporção do zoom", () => {
  const viewport = new CanvasViewport(800, 600);
  viewport.zoomAt(0, 0, 2); // zoom 2: 1 px de tela = 0.5 px de mundo
  const before = viewport.current;
  viewport.panByScreen(100, -50);
  assert.equal(viewport.current.worldX, before.worldX - 50);
  assert.equal(viewport.current.worldY, before.worldY + 25);
});

test("screenToCell devolve a célula e valida limites do grid", () => {
  const viewport = new CanvasViewport(800, 600);
  // sem pan/zoom: célula (2,1) com tileSize 16 cobre tela [32..48)×[16..32)
  assert.deepEqual(viewport.screenToCell(33, 17, 16, 10, 10), { x: 2, y: 1, inside: true });
  assert.deepEqual(viewport.screenToCell(47.9, 31.9, 16, 10, 10), { x: 2, y: 1, inside: true });
  // fora do grid
  assert.equal(viewport.screenToCell(-1, 0, 16, 10, 10).inside, false);
  assert.equal(viewport.screenToCell(160, 0, 16, 10, 10).inside, false);
});

test("fit enquadra o nível centralizado com margem", () => {
  const viewport = new CanvasViewport(800, 600);
  viewport.fit(20, 10, 16, 24); // mundo 320×160

  // o centro do nível cai no centro da tela
  const center = viewport.worldToScreen(160, 80);
  assert.ok(Math.abs(center.x - 400) < 1e-6);
  assert.ok(Math.abs(center.y - 300) < 1e-6);

  // o nível cabe inteiro com a margem
  const topLeft = viewport.worldToScreen(0, 0);
  const bottomRight = viewport.worldToScreen(320, 160);
  assert.ok(topLeft.x >= 24 - 1e-6 && topLeft.y >= 24 - 1e-6);
  assert.ok(bottomRight.x <= 800 - 24 + 1e-6 && bottomRight.y <= 600 - 24 + 1e-6);
});

test("visibleCells recorta o range ao grid (culling)", () => {
  const viewport = new CanvasViewport(160, 160);
  viewport.panByScreen(32, 32); // mundo desloca para (-32,-32) — células negativas na tela
  const range = viewport.visibleCells(16, 100, 100);
  assert.equal(range.minX, 0); // clampado: nunca negativo
  assert.equal(range.minY, 0);

  viewport.fit(4, 4, 16); // nível 4×4 inteiro visível
  const all = viewport.visibleCells(16, 4, 4);
  assert.deepEqual(all, { minX: 0, minY: 0, maxX: 3, maxY: 3 });
});
