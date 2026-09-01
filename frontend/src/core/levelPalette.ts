/**
 * A paleta de significados que a VISTA desenha — resolvida a partir do
 * documento, não da constante de build.
 *
 * A E9 trouxe a paleta para dentro do Blueprint (documento v4) e criou
 * `level/palette`; a projeção `levels` já a entrega junto do nível. Faltava a
 * outra ponta: o editor continuava desenhando `LEVEL_PALETTE`, a constante
 * compilada. Num projeto cuja paleta divergisse — editado por um agente, à
 * mão, ou vindo de um template futuro — o editor mostrava nomes e cores que
 * não eram os dele, e o usuário pintava "Chão" no que o documento chama de
 * outra coisa. Não era um enfeite fora do lugar: era a interface afirmando o
 * que o projeto não diz.
 *
 * A constante permanece como FALLBACK, e só isso: documento sem paleta (v3 e
 * anteriores, ou nível recém-criado) continua abrindo com os significados
 * default, que é melhor que abrir sem paleta nenhuma.
 *
 * Módulo puro (regra F1).
 */

/** Entrada da paleta como a vista precisa dela. */
export interface ResolvedPaletteEntry {
  readonly value: number;
  readonly name: string;
  /** Cor de exibição, "#rrggbb". */
  readonly color: string;
  /**
   * Dígito que seleciona a entrada. É POSICIONAL, não o valor: o documento
   * pode nomear os valores 5, 7 e 9, e o usuário continua alcançando os três
   * com 1, 2 e 3. Ausente da décima entrada em diante — não há dígito.
   */
  readonly shortcut?: string;
}

/** Entrada da paleta como o documento a carrega (sem atalho). */
export interface DocumentPaletteEntry {
  readonly value: number;
  readonly name: string;
  readonly color: string;
}

/**
 * Resolve a paleta a desenhar. Sem paleta no documento, o fallback vale
 * inteiro; com ela, o documento manda — inclusive na ORDEM, que é a ordem dos
 * valores, para que o dígito de uma entrada não dance entre reidratações.
 */
export function resolveLevelPalette(
  documentPalette: readonly DocumentPaletteEntry[] | undefined,
  fallback: readonly ResolvedPaletteEntry[],
): readonly ResolvedPaletteEntry[] {
  if (!documentPalette || documentPalette.length === 0) return fallback;
  return [...documentPalette]
    .sort((a, b) => a.value - b.value)
    .map((entry, index) => ({
      value: entry.value,
      name: entry.name,
      color: entry.color,
      ...(index < 9 ? { shortcut: String(index + 1) } : {}),
    }));
}

/**
 * Valor que deve ficar ativo depois de a paleta mudar.
 *
 * Trocar de projeto (ou reidratar sobre um documento com outra paleta) pode
 * tirar do mapa o valor selecionado. Mantê-lo ativo deixaria o pincel pintando
 * um significado que a paleta corrente não nomeia — o usuário veria uma cor
 * sem nome e não teria como voltar a ela pelos swatches.
 */
export function keepActiveValue(
  palette: readonly ResolvedPaletteEntry[],
  activeValue: number,
): number {
  if (palette.some((entry) => entry.value === activeValue)) return activeValue;
  return palette[0]?.value ?? activeValue;
}
