/**
 * Estado persistente e adaptativo do layout do workbench.
 *
 * Este módulo não conhece DOM, Electron, painéis concretos ou localStorage. A
 * persistência entra por uma porta pequena para que o mesmo comportamento possa
 * ser exercitado em testes e, no futuro, sincronizado com preferências do projeto.
 */

export type ResizableWorkbenchRegion = "left" | "right" | "bottom";
export type NarrowWorkbenchSide = "left" | "right";

export interface PersistedWorkbenchLayout {
  readonly version: 1;
  readonly leftSize: number;
  readonly rightSize: number;
  readonly bottomSize: number;
  readonly leftVisible: boolean;
  readonly rightVisible: boolean;
  readonly bottomVisible: boolean;
}

export interface WorkbenchLayoutSnapshot extends PersistedWorkbenchLayout {
  /** Estado derivado do viewport; nunca é gravado nas preferências duráveis. */
  readonly narrow: boolean;
  /** Drawer lateral aberto no modo estreito; também é deliberadamente efêmero. */
  readonly activeNarrowSide?: NarrowWorkbenchSide;
}

export interface WorkbenchLayoutPersistence {
  load(): unknown;
  save(layout: PersistedWorkbenchLayout): void;
}

export interface WorkbenchLayoutControllerOptions {
  readonly persistence?: WorkbenchLayoutPersistence;
  readonly viewportWidth?: number;
  readonly narrowBreakpoint?: number;
}

export interface WorkbenchRegionConstraint {
  readonly min: number;
  readonly max: number;
  readonly defaultSize: number;
}

export const WORKBENCH_LAYOUT_VERSION = 1 as const;
export const DEFAULT_NARROW_BREAKPOINT = 880;
export const WORKBENCH_KEYBOARD_RESIZE_STEP = 16;
export const WORKBENCH_KEYBOARD_RESIZE_LARGE_STEP = 48;

export const WORKBENCH_REGION_CONSTRAINTS: Readonly<
  Record<ResizableWorkbenchRegion, WorkbenchRegionConstraint>
> = Object.freeze({
  left: Object.freeze({ min: 180, max: 480, defaultSize: 230 }),
  right: Object.freeze({ min: 220, max: 520, defaultSize: 280 }),
  bottom: Object.freeze({ min: 120, max: 480, defaultSize: 190 }),
});

export const DEFAULT_WORKBENCH_LAYOUT: PersistedWorkbenchLayout = Object.freeze({
  version: WORKBENCH_LAYOUT_VERSION,
  leftSize: WORKBENCH_REGION_CONSTRAINTS.left.defaultSize,
  rightSize: WORKBENCH_REGION_CONSTRAINTS.right.defaultSize,
  bottomSize: WORKBENCH_REGION_CONSTRAINTS.bottom.defaultSize,
  leftVisible: true,
  rightVisible: true,
  bottomVisible: true,
});

type SizeProperty = "leftSize" | "rightSize" | "bottomSize";
type VisibilityProperty = "leftVisible" | "rightVisible" | "bottomVisible";

const SIZE_PROPERTY: Readonly<Record<ResizableWorkbenchRegion, SizeProperty>> = Object.freeze({
  left: "leftSize",
  right: "rightSize",
  bottom: "bottomSize",
});

const VISIBILITY_PROPERTY: Readonly<Record<ResizableWorkbenchRegion, VisibilityProperty>> =
  Object.freeze({
    left: "leftVisible",
    right: "rightVisible",
    bottom: "bottomVisible",
  });

/**
 * Fonte única do estado do layout. Mudanças duráveis são persistidas de forma
 * defensiva; falha no adapter não impede o editor de continuar funcionando.
 */
export class WorkbenchLayoutController {
  private readonly persistence: WorkbenchLayoutPersistence | undefined;
  private readonly narrowBreakpoint: number;
  private persisted: PersistedWorkbenchLayout;
  private narrow: boolean;
  private activeNarrowSide: NarrowWorkbenchSide | undefined;
  private readonly listeners = new Set<(layout: WorkbenchLayoutSnapshot) => void>();

  constructor(options: WorkbenchLayoutControllerOptions = {}) {
    this.persistence = options.persistence;
    this.narrowBreakpoint = positiveFiniteOr(
      options.narrowBreakpoint,
      DEFAULT_NARROW_BREAKPOINT,
    );
    this.persisted = sanitizeWorkbenchLayout(this.tryLoad());
    this.narrow = isNarrowViewport(options.viewportWidth, this.narrowBreakpoint);
  }

  get snapshot(): WorkbenchLayoutSnapshot {
    return freezeSnapshot(this.persisted, this.narrow, this.activeNarrowSide);
  }

  onChange(listener: (layout: WorkbenchLayoutSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setViewportWidth(width: number): void {
    if (!Number.isFinite(width) || width < 0) return;
    const nextNarrow = width < this.narrowBreakpoint;
    if (nextNarrow === this.narrow) return;
    this.narrow = nextNarrow;
    if (!nextNarrow) this.activeNarrowSide = undefined;
    this.notify();
  }

  setRegionSize(region: ResizableWorkbenchRegion, requestedSize: number): void {
    if (!Number.isFinite(requestedSize)) return;
    const property = SIZE_PROPERTY[region];
    const constraint = WORKBENCH_REGION_CONSTRAINTS[region];
    const size = clamp(Math.round(requestedSize), constraint.min, constraint.max);
    if (this.persisted[property] === size) return;
    this.commit({ ...this.persisted, [property]: size });
  }

  resizeRegionBy(region: ResizableWorkbenchRegion, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.setRegionSize(region, this.persisted[SIZE_PROPERTY[region]] + delta);
  }

  resetRegionSize(region: ResizableWorkbenchRegion): void {
    this.setRegionSize(region, WORKBENCH_REGION_CONSTRAINTS[region].defaultSize);
  }

  setRegionVisible(region: ResizableWorkbenchRegion, visible: boolean): void {
    const property = VISIBILITY_PROPERTY[region];
    if (this.persisted[property] === visible) return;
    if (!visible && this.activeNarrowSide === region) this.activeNarrowSide = undefined;
    if (visible && this.narrow && (region === "left" || region === "right")) {
      this.activeNarrowSide = region;
    }
    this.commit({ ...this.persisted, [property]: visible });
  }

  toggleRegion(region: ResizableWorkbenchRegion): void {
    if (this.narrow && (region === "left" || region === "right")) {
      if (!this.persisted[VISIBILITY_PROPERTY[region]]) this.setRegionVisible(region, true);
      else this.toggleNarrowSide(region);
      return;
    }
    this.setRegionVisible(region, !this.persisted[VISIBILITY_PROPERTY[region]]);
  }

  /** Abre ou fecha uma região lateral como drawer quando a janela está estreita. */
  toggleNarrowSide(side: NarrowWorkbenchSide): void {
    if (!this.narrow) return;
    this.setActiveNarrowSide(this.activeNarrowSide === side ? undefined : side);
  }

  setActiveNarrowSide(side: NarrowWorkbenchSide | undefined): void {
    if (!this.narrow && side !== undefined) return;
    if (this.activeNarrowSide === side) return;
    this.activeNarrowSide = side;
    this.notify();
  }

  restoreDefaults(): void {
    const changed = !samePersistedLayout(this.persisted, DEFAULT_WORKBENCH_LAYOUT);
    const hadDrawer = this.activeNarrowSide !== undefined;
    this.persisted = DEFAULT_WORKBENCH_LAYOUT;
    this.activeNarrowSide = undefined;
    if (changed) this.trySave();
    if (changed || hadDrawer) this.notify();
  }

  private commit(layout: PersistedWorkbenchLayout): void {
    this.persisted = Object.freeze({ ...layout });
    this.trySave();
    this.notify();
  }

  private tryLoad(): unknown {
    try {
      return this.persistence?.load();
    } catch {
      return undefined;
    }
  }

  private trySave(): void {
    try {
      this.persistence?.save(this.persisted);
    } catch {
      // Preferências são best-effort; uma quota/localStorage indisponível não
      // pode impedir a edição do projeto.
    }
  }

  private notify(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function sanitizeWorkbenchLayout(value: unknown): PersistedWorkbenchLayout {
  if (!isRecord(value) || value["version"] !== WORKBENCH_LAYOUT_VERSION) {
    return DEFAULT_WORKBENCH_LAYOUT;
  }
  return Object.freeze({
    version: WORKBENCH_LAYOUT_VERSION,
    leftSize: sanitizeSize(value["leftSize"], WORKBENCH_REGION_CONSTRAINTS.left),
    rightSize: sanitizeSize(value["rightSize"], WORKBENCH_REGION_CONSTRAINTS.right),
    bottomSize: sanitizeSize(value["bottomSize"], WORKBENCH_REGION_CONSTRAINTS.bottom),
    leftVisible: booleanOr(value["leftVisible"], DEFAULT_WORKBENCH_LAYOUT.leftVisible),
    rightVisible: booleanOr(value["rightVisible"], DEFAULT_WORKBENCH_LAYOUT.rightVisible),
    bottomVisible: booleanOr(value["bottomVisible"], DEFAULT_WORKBENCH_LAYOUT.bottomVisible),
  });
}

/**
 * Traduz teclas do separator em delta de tamanho. O sinal representa o tamanho
 * da região (não a posição física do divisor), por isso direita/canto inferior
 * possuem direção invertida.
 */
export function workbenchKeyboardResizeDelta(
  region: ResizableWorkbenchRegion,
  key: string,
  largeStep = false,
): number | undefined {
  const step = largeStep
    ? WORKBENCH_KEYBOARD_RESIZE_LARGE_STEP
    : WORKBENCH_KEYBOARD_RESIZE_STEP;
  if (region === "left") {
    if (key === "ArrowLeft") return -step;
    if (key === "ArrowRight") return step;
  } else if (region === "right") {
    if (key === "ArrowLeft") return step;
    if (key === "ArrowRight") return -step;
  } else {
    if (key === "ArrowUp") return step;
    if (key === "ArrowDown") return -step;
  }
  return undefined;
}

function freezeSnapshot(
  persisted: PersistedWorkbenchLayout,
  narrow: boolean,
  activeNarrowSide: NarrowWorkbenchSide | undefined,
): WorkbenchLayoutSnapshot {
  return Object.freeze({
    ...persisted,
    narrow,
    ...(activeNarrowSide ? { activeNarrowSide } : {}),
  });
}

function sanitizeSize(value: unknown, constraint: WorkbenchRegionConstraint): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(Math.round(value), constraint.min, constraint.max)
    : constraint.defaultSize;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isNarrowViewport(width: number | undefined, breakpoint: number): boolean {
  return typeof width === "number" && Number.isFinite(width) && width >= 0
    ? width < breakpoint
    : false;
}

function positiveFiniteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePersistedLayout(
  left: PersistedWorkbenchLayout,
  right: PersistedWorkbenchLayout,
): boolean {
  return left.version === right.version &&
    left.leftSize === right.leftSize &&
    left.rightSize === right.rightSize &&
    left.bottomSize === right.bottomSize &&
    left.leftVisible === right.leftVisible &&
    left.rightVisible === right.rightVisible &&
    left.bottomVisible === right.bottomVisible;
}
