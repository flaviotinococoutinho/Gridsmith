/**
 * Presets do editor de níveis (ALPHA-0.1 P0.4): a paleta de significados e as
 * regras de auto-tiling default do template "Plataforma 2D".
 *
 * As regras seguem o shape do contrato do middleware (AutoTileRule) e são
 * validadas contra ele por teste — o preview do canvas e o `level/define`
 * publicado usam EXATAMENTE o mesmo conjunto, então o que o usuário vê é o
 * que o runtime recebe.
 */

export interface PaletteEntry {
  readonly value: number;
  readonly name: string;
  /** Cor do SIGNIFICADO (modo IntGrid). */
  readonly color: string;
  /** Atalho de teclado (dígito). */
  readonly shortcut: string;
}

export const LEVEL_PALETTE: readonly PaletteEntry[] = [
  { value: 1, name: "Chão", color: "#7a5230", shortcut: "1" },
  { value: 2, name: "Parede", color: "#5a6a7a", shortcut: "2" },
  { value: 3, name: "Perigo", color: "#b8433a", shortcut: "3" },
];

/** Ids de tile produzidos pelas regras default → cor da ARTE (modo preview). */
export const TILE_COLORS: Readonly<Record<number, string>> = {
  100: "#4f8f3a", // grama (topo do chão exposto)
  101: "#5c9c45", // grama (variante)
  200: "#6b4a2b", // terra
  210: "#46525f", // parede
  220: "#c2554a", // perigo
};

/** Shape estrutural de AutoTileRule (contrato do middleware). */
export interface LevelRule {
  readonly name?: string;
  readonly patternSize: 1 | 3 | 5;
  readonly pattern: readonly (number | null)[];
  readonly tileIds: readonly number[];
  readonly chance?: number;
}

/**
 * Regras default: "pinte significado, derive arte" — chão com o topo exposto
 * vira grama (com variantes por seed), o resto vira terra; parede e perigo
 * mapeiam direto. Ordem importa: first-match-wins.
 */
export function defaultLevelRules(): LevelRule[] {
  return [
    {
      name: "grama-topo",
      patternSize: 3,
      // acima vazio, centro = chão
      pattern: [null, 0, null, null, 1, null, null, null, null],
      tileIds: [100, 101],
    },
    { name: "terra", patternSize: 1, pattern: [1], tileIds: [200] },
    { name: "parede", patternSize: 1, pattern: [2], tileIds: [210] },
    { name: "perigo", patternSize: 1, pattern: [3], tileIds: [220] },
  ];
}

/** Toda cor de tile referenciada pelas regras precisa existir no mapa de arte. */
export function assertPresetsConsistent(): void {
  for (const rule of defaultLevelRules()) {
    for (const tileId of rule.tileIds) {
      if (!(tileId in TILE_COLORS)) {
        throw new Error(`Rule "${rule.name}" produces tile ${tileId} without a TILE_COLORS entry`);
      }
    }
  }
  for (const entry of LEVEL_PALETTE) {
    const covered = defaultLevelRules().some((rule) =>
      rule.pattern.includes(entry.value),
    );
    if (!covered) {
      throw new Error(`Palette value ${entry.value} ("${entry.name}") has no default rule`);
    }
  }
}
