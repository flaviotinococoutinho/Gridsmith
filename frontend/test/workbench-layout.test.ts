import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_WORKBENCH_LAYOUT,
  WORKBENCH_REGION_CONSTRAINTS,
  WorkbenchLayoutController,
  sanitizeWorkbenchLayout,
  workbenchKeyboardResizeDelta,
  type PersistedWorkbenchLayout,
  type WorkbenchLayoutPersistence,
} from "../src/core/workbenchLayout.js";

class MemoryLayoutPersistence implements WorkbenchLayoutPersistence {
  readonly saves: PersistedWorkbenchLayout[] = [];

  constructor(readonly stored?: unknown) {}

  load(): unknown {
    return this.stored;
  }

  save(layout: PersistedWorkbenchLayout): void {
    this.saves.push({ ...layout });
  }
}

test("layout do workbench: restaura tamanhos e visibilidade pelo adapter injetável", () => {
  const persistence = new MemoryLayoutPersistence({
    version: 1,
    leftSize: 320,
    rightSize: 410,
    bottomSize: 250,
    leftVisible: false,
    rightVisible: true,
    bottomVisible: false,
  });
  const layout = new WorkbenchLayoutController({ persistence, viewportWidth: 1200 });

  assert.deepEqual(layout.snapshot, {
    version: 1,
    leftSize: 320,
    rightSize: 410,
    bottomSize: 250,
    leftVisible: false,
    rightVisible: true,
    bottomVisible: false,
    narrow: false,
  });
  assert.equal(persistence.saves.length, 0, "restaurar não regrava a preferência");
});

test("layout do workbench: resize é limitado, persistido e restaurável", () => {
  const persistence = new MemoryLayoutPersistence();
  const layout = new WorkbenchLayoutController({ persistence });

  layout.setRegionSize("left", 10_000);
  layout.setRegionSize("right", -100);
  layout.resizeRegionBy("bottom", 45);

  assert.equal(layout.snapshot.leftSize, WORKBENCH_REGION_CONSTRAINTS.left.max);
  assert.equal(layout.snapshot.rightSize, WORKBENCH_REGION_CONSTRAINTS.right.min);
  assert.equal(
    layout.snapshot.bottomSize,
    WORKBENCH_REGION_CONSTRAINTS.bottom.defaultSize + 45,
  );
  assert.equal(persistence.saves.length, 3);

  const restored = new WorkbenchLayoutController({
    persistence: new MemoryLayoutPersistence(persistence.saves.at(-1)),
  });
  assert.equal(restored.snapshot.leftSize, WORKBENCH_REGION_CONSTRAINTS.left.max);
  assert.equal(restored.snapshot.rightSize, WORKBENCH_REGION_CONSTRAINTS.right.min);
});

test("layout do workbench: modo estreito e drawer são derivados, não persistidos", () => {
  const persistence = new MemoryLayoutPersistence();
  const layout = new WorkbenchLayoutController({
    persistence,
    viewportWidth: 700,
    narrowBreakpoint: 800,
  });

  assert.equal(layout.snapshot.narrow, true);
  layout.toggleRegion("left");
  assert.equal(layout.snapshot.activeNarrowSide, "left", "toggle abre drawer já visível");
  layout.toggleRegion("left");
  assert.equal(layout.snapshot.activeNarrowSide, undefined, "segundo toggle fecha sem remover a aba");
  assert.equal(layout.snapshot.leftVisible, true);
  layout.toggleNarrowSide("left");
  assert.equal(layout.snapshot.activeNarrowSide, "left");
  layout.toggleNarrowSide("right");
  assert.equal(layout.snapshot.activeNarrowSide, "right");
  assert.equal(persistence.saves.length, 0);

  layout.setRegionVisible("right", false);
  layout.setRegionVisible("right", true);
  assert.equal(layout.snapshot.activeNarrowSide, "right", "mostrar região abre seu drawer estreito");

  layout.setViewportWidth(1_100);
  assert.equal(layout.snapshot.narrow, false);
  assert.equal(layout.snapshot.activeNarrowSide, undefined);
});

test("layout do workbench: visibilidade e defaults são duráveis", () => {
  const persistence = new MemoryLayoutPersistence();
  const layout = new WorkbenchLayoutController({ persistence });
  layout.setRegionVisible("right", false);
  layout.setRegionSize("left", 300);
  assert.equal(layout.snapshot.rightVisible, false);

  layout.restoreDefaults();
  assert.deepEqual(layout.snapshot, { ...DEFAULT_WORKBENCH_LAYOUT, narrow: false });
  assert.deepEqual(persistence.saves.at(-1), DEFAULT_WORKBENCH_LAYOUT);
});

test("layout do workbench: preferência inválida falha de modo seguro", () => {
  assert.deepEqual(sanitizeWorkbenchLayout({ version: 999 }), DEFAULT_WORKBENCH_LAYOUT);
  assert.deepEqual(
    sanitizeWorkbenchLayout({
      version: 1,
      leftSize: Number.NaN,
      rightSize: 9_999,
      bottomSize: "200",
      leftVisible: "sim",
      rightVisible: false,
      bottomVisible: true,
    }),
    {
      version: 1,
      leftSize: WORKBENCH_REGION_CONSTRAINTS.left.defaultSize,
      rightSize: WORKBENCH_REGION_CONSTRAINTS.right.max,
      bottomSize: WORKBENCH_REGION_CONSTRAINTS.bottom.defaultSize,
      leftVisible: true,
      rightVisible: false,
      bottomVisible: true,
    },
  );

  const unavailable: WorkbenchLayoutPersistence = {
    load(): unknown {
      throw new Error("storage bloqueado");
    },
    save(): void {
      throw new Error("quota excedida");
    },
  };
  const layout = new WorkbenchLayoutController({ persistence: unavailable });
  assert.doesNotThrow(() => layout.setRegionSize("left", 300));
  assert.equal(layout.snapshot.leftSize, 300);
  assert.ok(Object.isFrozen(layout.snapshot));
});

test("layout do workbench: separators têm resize integral por teclado", () => {
  assert.equal(workbenchKeyboardResizeDelta("left", "ArrowLeft"), -16);
  assert.equal(workbenchKeyboardResizeDelta("left", "ArrowRight"), 16);
  assert.equal(workbenchKeyboardResizeDelta("right", "ArrowLeft"), 16);
  assert.equal(workbenchKeyboardResizeDelta("right", "ArrowRight", true), -48);
  assert.equal(workbenchKeyboardResizeDelta("bottom", "ArrowUp"), 16);
  assert.equal(workbenchKeyboardResizeDelta("bottom", "ArrowDown"), -16);
  assert.equal(workbenchKeyboardResizeDelta("bottom", "ArrowRight"), undefined);
});
