/**
 * Layout do workbench (E10, pendência D2): tamanhos e visibilidade das áreas,
 * com serialização versionada.
 *
 * Único redimensionamento que existia era o do canvas, e nada era lembrado
 * entre sessões. Aqui o estado é puro e clampado: a casca só materializa
 * pixels, e um layout salvo por uma versão futura — ou corrompido — volta ao
 * default em vez de deixar a janela sem rail nem inspector.
 *
 * Módulo puro (regra F1): a persistência (localStorage/arquivo) é da casca.
 */

/** Áreas redimensionáveis do workbench. */
export type LayoutArea = "rail" | "inspector" | "bottom";

export interface AreaLayout {
  /** Largura (rail/inspector) ou altura (bottom), em pixels de CSS. */
  readonly size: number;
  readonly visible: boolean;
}

interface AreaBounds {
  readonly min: number;
  readonly max: number;
  readonly initial: number;
}

/**
 * Limites por área. `min` não é estético: abaixo dele o conteúdo deixa de ser
 * clicável, e uma área presente mas inutilizável é pior que uma escondida —
 * quem quer espaço fecha a área, e o botão de fechar diz isso ao usuário.
 */
const BOUNDS: Readonly<Record<LayoutArea, AreaBounds>> = {
  rail: { min: 140, max: 420, initial: 220 },
  inspector: { min: 200, max: 560, initial: 300 },
  bottom: { min: 120, max: 640, initial: 200 },
};

export const LAYOUT_AREAS: readonly LayoutArea[] = ["rail", "inspector", "bottom"];

/** Formato persistido. A versão é o que permite mudar os limites sem quebrar. */
export const LAYOUT_SCHEMA_VERSION = 1;

export interface SerializedLayout {
  readonly version: number;
  readonly areas: Readonly<Record<string, { size: number; visible: boolean }>>;
}

export function clampArea(area: LayoutArea, size: number): number {
  const bounds = BOUNDS[area];
  if (!Number.isFinite(size)) return bounds.initial;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(size)));
}

export function areaBounds(area: LayoutArea): AreaBounds {
  return BOUNDS[area];
}

export class WorkbenchLayout {
  private readonly areas = new Map<LayoutArea, AreaLayout>(
    LAYOUT_AREAS.map((area) => [area, { size: BOUNDS[area].initial, visible: true }]),
  );
  private readonly listeners = new Set<() => void>();

  get(area: LayoutArea): AreaLayout {
    return this.areas.get(area)!;
  }

  /** Tamanho efetivo: área escondida ocupa zero, e a casca não precisa saber disso. */
  effectiveSize(area: LayoutArea): number {
    const layout = this.get(area);
    return layout.visible ? layout.size : 0;
  }

  resize(area: LayoutArea, size: number): void {
    const current = this.get(area);
    const clamped = clampArea(area, size);
    if (clamped === current.size) return;
    this.areas.set(area, { ...current, size: clamped });
    this.notify();
  }

  setVisible(area: LayoutArea, visible: boolean): void {
    const current = this.get(area);
    if (current.visible === visible) return;
    this.areas.set(area, { ...current, visible });
    this.notify();
  }

  toggle(area: LayoutArea): void {
    this.setVisible(area, !this.get(area).visible);
  }

  /** Volta ao default de fábrica — a saída para quem se perdeu no layout. */
  reset(): void {
    for (const area of LAYOUT_AREAS) {
      this.areas.set(area, { size: BOUNDS[area].initial, visible: true });
    }
    this.notify();
  }

  serialize(): SerializedLayout {
    return {
      version: LAYOUT_SCHEMA_VERSION,
      areas: Object.fromEntries(
        LAYOUT_AREAS.map((area) => {
          const layout = this.get(area);
          return [area, { size: layout.size, visible: layout.visible }];
        }),
      ),
    };
  }

  /**
   * Restaura o que reconhecer e IGNORA o resto, sem lançar.
   *
   * Layout é conforto, não dado do projeto: falhar a abertura do editor porque
   * a preferência de largura veio corrompida trocaria um problema invisível por
   * um fatal. Áreas desconhecidas, versão diferente e valores fora dos limites
   * caem no default; devolve `false` quando nada foi aproveitado.
   */
  restore(raw: unknown): boolean {
    if (typeof raw !== "object" || raw === null) return false;
    const candidate = raw as Partial<SerializedLayout>;
    if (candidate.version !== LAYOUT_SCHEMA_VERSION) return false;
    const areas = candidate.areas;
    if (typeof areas !== "object" || areas === null) return false;

    let restored = false;
    for (const area of LAYOUT_AREAS) {
      const entry = (areas as Record<string, unknown>)[area];
      if (typeof entry !== "object" || entry === null) continue;
      const { size, visible } = entry as { size?: unknown; visible?: unknown };
      const next: AreaLayout = {
        size: typeof size === "number" ? clampArea(area, size) : BOUNDS[area].initial,
        visible: typeof visible === "boolean" ? visible : true,
      };
      this.areas.set(area, next);
      restored = true;
    }
    if (restored) this.notify();
    return restored;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
