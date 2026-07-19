/**
 * Casca estrutural do workbench.
 *
 * Apenas materializa o estado de `WorkbenchLayoutController` no DOM. Painéis,
 * ferramentas, comandos e inspector são contribuições externas; este módulo não
 * conhece nenhum ID funcional nem decide qual vista montar.
 */

import {
  WORKBENCH_REGION_CONSTRAINTS,
  WorkbenchLayoutController,
  workbenchKeyboardResizeDelta,
  type NarrowWorkbenchSide,
  type PersistedWorkbenchLayout,
  type ResizableWorkbenchRegion,
  type WorkbenchLayoutPersistence,
  type WorkbenchLayoutSnapshot,
} from "../core/workbenchLayout.js";

const LAYOUT_STORAGE_KEY = "p7m.workbench.layout.v1";

export interface WorkbenchShellElements {
  readonly toolbarRegion: HTMLElement;
  readonly root: HTMLElement;
  readonly leftRegion: HTMLElement;
  readonly centerRegion: HTMLElement;
  readonly rightRegion: HTMLElement;
  readonly bottomRegion: HTMLElement;
  readonly leftSplitter: HTMLElement;
  readonly rightSplitter: HTMLElement;
  readonly bottomSplitter: HTMLElement;
  readonly narrowTabs: HTMLElement;
  readonly statusRegion: HTMLElement;
  readonly leftNarrowTab: HTMLButtonElement;
  readonly rightNarrowTab: HTMLButtonElement;
}

export interface WorkbenchShellInstance {
  readonly layout: WorkbenchLayoutController;
  dispose(): void;
}

/** Adapter substituível: localStorage fica na borda renderer, nunca no core. */
export class BrowserWorkbenchLayoutPersistence implements WorkbenchLayoutPersistence {
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly key = LAYOUT_STORAGE_KEY,
  ) {}

  load(): unknown {
    const serialized = this.storage.getItem(this.key);
    if (!serialized) return undefined;
    return JSON.parse(serialized) as unknown;
  }

  save(layout: PersistedWorkbenchLayout): void {
    this.storage.setItem(this.key, JSON.stringify(layout));
  }
}

/**
 * Resolve somente slots estruturais. O conteúdo de cada slot é responsabilidade
 * dos registries recebidos pela composição da aplicação.
 */
export function resolveWorkbenchShellElements(root: ParentNode): WorkbenchShellElements {
  return {
    toolbarRegion: requiredElement(root, "[data-workbench-toolbar]"),
    root: requiredElement(root, "[data-workbench-root]"),
    leftRegion: requiredElement(root, "[data-workbench-region='left']"),
    centerRegion: requiredElement(root, "[data-workbench-region='center']"),
    rightRegion: requiredElement(root, "[data-workbench-region='right']"),
    bottomRegion: requiredElement(root, "[data-workbench-region='bottom']"),
    leftSplitter: requiredElement(root, "[data-workbench-splitter='left']"),
    rightSplitter: requiredElement(root, "[data-workbench-splitter='right']"),
    bottomSplitter: requiredElement(root, "[data-workbench-splitter='bottom']"),
    narrowTabs: requiredElement(root, "[data-workbench-narrow-tabs]"),
    statusRegion: requiredElement(root, "[data-workbench-status]"),
    leftNarrowTab: requiredElement<HTMLButtonElement>(
      root,
      "[data-workbench-narrow-tab='left']",
    ),
    rightNarrowTab: requiredElement<HTMLButtonElement>(
      root,
      "[data-workbench-narrow-tab='right']",
    ),
  };
}

export function mountWorkbenchShell(
  elements: WorkbenchShellElements,
  layout: WorkbenchLayoutController,
  hostWindow: Window = window,
): WorkbenchShellInstance {
  const cleanup: Array<() => void> = [];
  const render = (snapshot: WorkbenchLayoutSnapshot): void => renderLayout(elements, snapshot);

  cleanup.push(layout.onChange(render));
  cleanup.push(wireSplitter(elements.leftSplitter, "left", layout, hostWindow));
  cleanup.push(wireSplitter(elements.rightSplitter, "right", layout, hostWindow));
  cleanup.push(wireSplitter(elements.bottomSplitter, "bottom", layout, hostWindow));
  cleanup.push(wireNarrowTabs(elements, layout));
  cleanup.push(wireRegionCycling(elements, layout, hostWindow));

  const updateViewport = (): void => {
    const measuredWidth = elements.root.getBoundingClientRect().width;
    layout.setViewportWidth(measuredWidth > 0 ? measuredWidth : hostWindow.innerWidth);
  };
  hostWindow.addEventListener("resize", updateViewport);
  cleanup.push(() => hostWindow.removeEventListener("resize", updateViewport));

  const closeDrawer = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !layout.snapshot.activeNarrowSide) return;
    const side = layout.snapshot.activeNarrowSide;
    layout.setActiveNarrowSide(undefined);
    (side === "left" ? elements.leftNarrowTab : elements.rightNarrowTab).focus();
  };
  elements.root.addEventListener("keydown", closeDrawer);
  cleanup.push(() => elements.root.removeEventListener("keydown", closeDrawer));

  updateViewport();
  render(layout.snapshot);

  return {
    layout,
    dispose(): void {
      for (const release of cleanup.splice(0).reverse()) release();
    },
  };
}

export function createBrowserWorkbenchLayout(
  storage: Pick<Storage, "getItem" | "setItem">,
  viewportWidth: number,
): WorkbenchLayoutController {
  return new WorkbenchLayoutController({
    persistence: new BrowserWorkbenchLayoutPersistence(storage),
    viewportWidth,
  });
}

function renderLayout(
  elements: WorkbenchShellElements,
  snapshot: WorkbenchLayoutSnapshot,
): void {
  const activeElement = elements.root.ownerDocument.activeElement;
  const focusedRegion = activeElement instanceof Node
    ? ([elements.leftRegion, elements.rightRegion, elements.bottomRegion]
        .find((region) => region.contains(activeElement)))
    : undefined;
  const leftInGrid = !snapshot.narrow && snapshot.leftVisible;
  const rightInGrid = !snapshot.narrow && snapshot.rightVisible;
  elements.root.style.setProperty("--workbench-left-size", leftInGrid ? `${snapshot.leftSize}px` : "0px");
  elements.root.style.setProperty("--workbench-right-size", rightInGrid ? `${snapshot.rightSize}px` : "0px");
  elements.root.style.setProperty(
    "--workbench-bottom-size",
    snapshot.bottomVisible ? `${snapshot.bottomSize}px` : "0px",
  );
  elements.root.style.setProperty("--workbench-left-splitter-size", leftInGrid ? "5px" : "0px");
  elements.root.style.setProperty("--workbench-right-splitter-size", rightInGrid ? "5px" : "0px");
  elements.root.style.setProperty(
    "--workbench-bottom-splitter-size",
    snapshot.bottomVisible ? "5px" : "0px",
  );
  elements.root.classList.toggle("workbench--narrow", snapshot.narrow);
  elements.root.dataset["narrowSide"] = snapshot.activeNarrowSide ?? "none";

  elements.narrowTabs.hidden = !snapshot.narrow || (!snapshot.leftVisible && !snapshot.rightVisible);
  elements.leftNarrowTab.hidden = !snapshot.leftVisible;
  elements.rightNarrowTab.hidden = !snapshot.rightVisible;
  elements.leftNarrowTab.setAttribute(
    "aria-selected",
    String(snapshot.activeNarrowSide === "left"),
  );
  elements.leftNarrowTab.setAttribute(
    "aria-expanded",
    String(snapshot.activeNarrowSide === "left"),
  );
  elements.rightNarrowTab.setAttribute(
    "aria-selected",
    String(snapshot.activeNarrowSide === "right"),
  );
  elements.rightNarrowTab.setAttribute(
    "aria-expanded",
    String(snapshot.activeNarrowSide === "right"),
  );
  elements.leftNarrowTab.tabIndex = snapshot.leftVisible && snapshot.activeNarrowSide !== "right" ? 0 : -1;
  elements.rightNarrowTab.tabIndex = snapshot.rightVisible &&
    (!snapshot.leftVisible || snapshot.activeNarrowSide === "right") ? 0 : -1;

  elements.leftRegion.hidden = snapshot.narrow
    ? !snapshot.leftVisible || snapshot.activeNarrowSide !== "left"
    : !snapshot.leftVisible;
  elements.rightRegion.hidden = snapshot.narrow
    ? !snapshot.rightVisible || snapshot.activeNarrowSide !== "right"
    : !snapshot.rightVisible;
  elements.bottomRegion.hidden = !snapshot.bottomVisible;
  elements.leftSplitter.hidden = snapshot.narrow || !snapshot.leftVisible;
  elements.rightSplitter.hidden = snapshot.narrow || !snapshot.rightVisible;
  elements.bottomSplitter.hidden = !snapshot.bottomVisible;

  updateSeparator(elements.leftSplitter, snapshot.leftSize, "left");
  updateSeparator(elements.rightSplitter, snapshot.rightSize, "right");
  updateSeparator(elements.bottomSplitter, snapshot.bottomSize, "bottom");

  if (focusedRegion?.hidden) {
    const drawerTab = snapshot.narrow && focusedRegion === elements.leftRegion && snapshot.leftVisible
      ? elements.leftNarrowTab
      : snapshot.narrow && focusedRegion === elements.rightRegion && snapshot.rightVisible
        ? elements.rightNarrowTab
        : undefined;
    const fallback = drawerTab ?? elements.centerRegion.querySelector<HTMLElement>(
      "[role='tab'][aria-selected='true'], canvas, button, input, select, textarea",
    ) ?? elements.centerRegion;
    if (fallback === elements.centerRegion && fallback.tabIndex < 0) fallback.tabIndex = -1;
    fallback.focus();
  }
}

function updateSeparator(
  separator: HTMLElement,
  value: number,
  region: ResizableWorkbenchRegion,
): void {
  const constraint = WORKBENCH_REGION_CONSTRAINTS[region];
  separator.setAttribute("aria-valuemin", String(constraint.min));
  separator.setAttribute("aria-valuemax", String(constraint.max));
  separator.setAttribute("aria-valuenow", String(value));
  separator.setAttribute("aria-valuetext", `${value} pixels`);
}

function wireSplitter(
  splitter: HTMLElement,
  region: ResizableWorkbenchRegion,
  layout: WorkbenchLayoutController,
  hostWindow: Window,
): () => void {
  let releasePointerListeners: (() => void) | undefined;

  const pointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startCoordinate = region === "bottom" ? event.clientY : event.clientX;
    const startSize = regionSize(layout.snapshot, region);

    const pointerMove = (moveEvent: PointerEvent): void => {
      const coordinate = region === "bottom" ? moveEvent.clientY : moveEvent.clientX;
      const rawDelta = coordinate - startCoordinate;
      const sizeDelta = region === "left" ? rawDelta : -rawDelta;
      layout.setRegionSize(region, startSize + sizeDelta);
    };
    const pointerUp = (): void => release();
    const release = (): void => {
      hostWindow.removeEventListener("pointermove", pointerMove);
      hostWindow.removeEventListener("pointerup", pointerUp);
      hostWindow.removeEventListener("pointercancel", pointerUp);
      releasePointerListeners = undefined;
    };
    releasePointerListeners?.();
    releasePointerListeners = release;
    hostWindow.addEventListener("pointermove", pointerMove);
    hostWindow.addEventListener("pointerup", pointerUp);
    hostWindow.addEventListener("pointercancel", pointerUp);
  };

  const keyDown = (event: KeyboardEvent): void => {
    const constraint = WORKBENCH_REGION_CONSTRAINTS[region];
    if (event.key === "Home") {
      event.preventDefault();
      layout.setRegionSize(region, constraint.min);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      layout.setRegionSize(region, constraint.max);
      return;
    }
    const delta = workbenchKeyboardResizeDelta(region, event.key, event.shiftKey);
    if (delta === undefined) return;
    event.preventDefault();
    layout.resizeRegionBy(region, delta);
  };

  const reset = (): void => layout.resetRegionSize(region);
  splitter.addEventListener("pointerdown", pointerDown);
  splitter.addEventListener("keydown", keyDown);
  splitter.addEventListener("dblclick", reset);
  return () => {
    releasePointerListeners?.();
    splitter.removeEventListener("pointerdown", pointerDown);
    splitter.removeEventListener("keydown", keyDown);
    splitter.removeEventListener("dblclick", reset);
  };
}

function wireNarrowTabs(
  elements: WorkbenchShellElements,
  layout: WorkbenchLayoutController,
): () => void {
  const tabs: ReadonlyArray<readonly [HTMLButtonElement, NarrowWorkbenchSide]> = [
    [elements.leftNarrowTab, "left"],
    [elements.rightNarrowTab, "right"],
  ];
  const releases: Array<() => void> = [];

  tabs.forEach(([button, side], index) => {
    const click = (): void => {
      layout.toggleNarrowSide(side);
      if (layout.snapshot.activeNarrowSide === side) {
        queueMicrotask(() => focusRegion(side === "left" ? elements.leftRegion : elements.rightRegion));
      }
    };
    const keyDown = (event: KeyboardEvent): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" &&
          event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const targetIndex = event.key === "Home" || event.key === "ArrowLeft" ? 0 : tabs.length - 1;
      // Arrow keys form a two-item roving tab stop; index is retained to keep
      // the behavior obvious if another structural side is introduced later.
      tabs[targetIndex]?.[0].focus();
    };
    button.tabIndex = index === 0 ? 0 : -1;
    button.addEventListener("click", click);
    button.addEventListener("keydown", keyDown);
    releases.push(() => {
      button.removeEventListener("click", click);
      button.removeEventListener("keydown", keyDown);
    });
  });
  return () => releases.reverse().forEach((release) => release());
}

/** F6/Shift+F6 percorre regiões, sem conhecer painéis registrados. */
function wireRegionCycling(
  elements: WorkbenchShellElements,
  layout: WorkbenchLayoutController,
  hostWindow: Window,
): () => void {
  const keyDown = (event: KeyboardEvent): void => {
    if (event.key !== "F6" || event.altKey || event.ctrlKey || event.metaKey) return;
    const snapshot = layout.snapshot;
    const regions = snapshot.narrow
      ? [
          elements.toolbarRegion,
          ...(snapshot.activeNarrowSide === "left" ? [elements.leftRegion] : []),
          elements.centerRegion,
          ...(snapshot.activeNarrowSide === "right" ? [elements.rightRegion] : []),
          ...(!elements.bottomRegion.hidden ? [elements.bottomRegion] : []),
          elements.statusRegion,
        ]
      : [
          elements.toolbarRegion,
          ...(!elements.leftRegion.hidden ? [elements.leftRegion] : []),
          elements.centerRegion,
          ...(!elements.rightRegion.hidden ? [elements.rightRegion] : []),
          ...(!elements.bottomRegion.hidden ? [elements.bottomRegion] : []),
          elements.statusRegion,
        ];
    if (regions.length === 0) return;
    event.preventDefault();
    const active = hostWindow.document.activeElement;
    const currentIndex = regions.findIndex((region) => region === active || (active && region.contains(active)));
    const direction = event.shiftKey ? -1 : 1;
    const nextIndex = currentIndex < 0
      ? (event.shiftKey ? regions.length - 1 : 0)
      : (currentIndex + direction + regions.length) % regions.length;
    const next = regions[nextIndex];
    if (next) focusRegion(next);
  };
  hostWindow.addEventListener("keydown", keyDown);
  return () => hostWindow.removeEventListener("keydown", keyDown);
}

function regionSize(
  snapshot: WorkbenchLayoutSnapshot,
  region: ResizableWorkbenchRegion,
): number {
  if (region === "left") return snapshot.leftSize;
  if (region === "right") return snapshot.rightSize;
  return snapshot.bottomSize;
}

function focusRegion(region: HTMLElement): void {
  const focusable = region.querySelector<HTMLElement>(
    "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), " +
    "textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
  );
  (focusable ?? region).focus();
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Estrutura do workbench incompleta: ${selector}`);
  return element;
}
