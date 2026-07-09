/**
 * Auto-tiling determinístico por regras de padrão — inspirado nos auto-layers
 * do LDtk e nos Wang tiles do Tiled (ver docs/RESEARCH-EDITOR-LANDSCAPE.md).
 *
 * O designer pinta SIGNIFICADO em um IntGrid (colisão, água, perigo...) e as
 * regras derivam a arte: cada regra tem um padrão NxN comparado à vizinhança
 * de cada célula. A resolução é uma FUNÇÃO PURA com seed — mesmo grid, mesmas
 * regras e mesmo seed produzem exatamente o mesmo resultado, o que torna o
 * pipeline verificável por testes e reproduzível em qualquer máquina.
 *
 * Semântica do padrão (célula a célula, linha-maior, centro = célula alvo):
 * - `null`  → ignora (wildcard);
 * - `0`     → deve estar VAZIA (IntGrid 0);
 * - `v > 0` → deve conter exatamente o valor v;
 * - `v < 0` → NÃO pode conter o valor |v| (negação);
 * - `ANY_FILLED` → deve conter qualquer valor ≠ 0.
 *
 * Células fora dos limites do grid são tratadas como vazias (0).
 * As regras aplicam em ordem: a primeira que casar vence a célula
 * (first-match-wins), como nos grupos de regras do LDtk.
 */

/** Sentinela: casa com qualquer célula preenchida (≠ 0). */
export const ANY_FILLED = Number.MIN_SAFE_INTEGER;

export type PatternCell = number | null;

export interface AutoTileRule {
  /** Nome para diagnóstico/editor. */
  readonly name?: string;
  /** Lado do padrão quadrado (1, 3 ou 5). */
  readonly patternSize: 1 | 3 | 5;
  /** patternSize² células, linha-maior, centro = célula avaliada. */
  readonly pattern: readonly PatternCell[];
  /** Variantes de tile; a escolha é determinística por célula+seed. */
  readonly tileIds: readonly number[];
  /** Probabilidade de aplicar (0..1]; decidida por hash determinístico. Default 1. */
  readonly chance?: number;
}

export interface IntGrid {
  readonly width: number;
  readonly height: number;
  /** width*height valores, linha-maior; 0 = vazio. */
  readonly values: readonly number[];
}

export interface ResolvedTilemap {
  readonly width: number;
  readonly height: number;
  /** width*height tileIds, linha-maior; -1 = sem tile. */
  readonly tiles: Int32Array;
  /** Índice da regra vencedora por célula; -1 = nenhuma. */
  readonly ruleIndex: Int32Array;
}

export function validateRules(rules: readonly AutoTileRule[]): void {
  rules.forEach((rule, index) => {
    const label = rule.name ?? `#${index}`;
    if (![1, 3, 5].includes(rule.patternSize)) {
      throw new Error(`Rule ${label}: patternSize must be 1, 3 or 5`);
    }
    if (rule.pattern.length !== rule.patternSize * rule.patternSize) {
      throw new Error(
        `Rule ${label}: pattern must have ${rule.patternSize * rule.patternSize} cells ` +
          `(got ${rule.pattern.length})`,
      );
    }
    if (rule.tileIds.length === 0) {
      throw new Error(`Rule ${label}: tileIds must not be empty`);
    }
    if (rule.chance !== undefined && !(rule.chance > 0 && rule.chance <= 1)) {
      throw new Error(`Rule ${label}: chance must be in (0, 1]`);
    }
  });
}

export function validateGrid(grid: IntGrid): void {
  if (!Number.isInteger(grid.width) || grid.width < 1 || !Number.isInteger(grid.height) || grid.height < 1) {
    throw new Error("Grid dimensions must be positive integers");
  }
  if (grid.values.length !== grid.width * grid.height) {
    throw new Error(`Grid expects ${grid.width * grid.height} values (got ${grid.values.length})`);
  }
}

/**
 * Hash determinístico por célula (mistura estilo Wang/xxHash simplificada) —
 * decide `chance` e a variante do tile sem nenhum estado global.
 */
export function cellHash(x: number, y: number, seed: number, salt: number): number {
  let h = (x * 0x8da6b343) ^ (y * 0xd8163841) ^ (seed | 0) ^ (salt * 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function cellMatches(expected: PatternCell, actual: number): boolean {
  if (expected === null) return true;
  if (expected === ANY_FILLED) return actual !== 0;
  if (expected < 0) return actual !== -expected;
  return actual === expected;
}

function ruleMatchesAt(rule: AutoTileRule, grid: IntGrid, cx: number, cy: number): boolean {
  const half = (rule.patternSize - 1) / 2;
  for (let py = 0; py < rule.patternSize; py++) {
    for (let px = 0; px < rule.patternSize; px++) {
      const gx = cx + px - half;
      const gy = cy + py - half;
      const actual =
        gx < 0 || gy < 0 || gx >= grid.width || gy >= grid.height
          ? 0 // fora dos limites = vazio
          : grid.values[gy * grid.width + gx]!;
      if (!cellMatches(rule.pattern[py * rule.patternSize + px]!, actual)) {
        return false;
      }
    }
  }
  return true;
}

/** Resolve o IntGrid em tiles. Pura e determinística: (grid, rules, seed) → tiles. */
export function resolveAutoTiles(
  grid: IntGrid,
  rules: readonly AutoTileRule[],
  seed = 0,
): ResolvedTilemap {
  validateGrid(grid);
  validateRules(rules);

  const tiles = new Int32Array(grid.width * grid.height).fill(-1);
  const ruleIndex = new Int32Array(grid.width * grid.height).fill(-1);

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const cell = y * grid.width + x;
      for (let r = 0; r < rules.length; r++) {
        const rule = rules[r]!;
        if (!ruleMatchesAt(rule, grid, x, y)) continue;

        if (rule.chance !== undefined && rule.chance < 1) {
          const roll = cellHash(x, y, seed, r) / 0x100000000; // [0, 1)
          if (roll >= rule.chance) continue;
        }

        const variant =
          rule.tileIds.length === 1
            ? rule.tileIds[0]!
            : rule.tileIds[cellHash(x, y, seed, r + 0x5f5e100) % rule.tileIds.length]!;
        tiles[cell] = variant;
        ruleIndex[cell] = r;
        break; // first-match-wins
      }
    }
  }

  return { width: grid.width, height: grid.height, tiles, ruleIndex };
}
