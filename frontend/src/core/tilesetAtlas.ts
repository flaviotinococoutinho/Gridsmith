/**
 * A tabela do atlas no lado do editor — o ESPELHO exato do `TilesetSpec` do
 * documento v5 e da `TilesetTable` da engine.
 *
 * A região de um `tileId` é FÓRMULA sobre quatro números — coluna
 * `id % columns`, linha `id / columns`, célula de `tileSize` px — nunca
 * tabela por tile. É isso que torna a paridade visual da ADR-022 verificável:
 * o canvas e o host só podem discordar se os quatro números discordarem, e os
 * testes dos dois lados fixam os MESMOS casos com os MESMOS resultados.
 *
 * Um `tileId` fora de `[0, tileCount)` não tem arte: devolve `undefined`, e o
 * chamador desenha o fallback determinístico — o mesmo do host, JUNTOS.
 *
 * Módulo puro (regra F1).
 */

/** Estruturalmente idêntico ao `TilesetSpec` que a consulta `tilesets` entrega. */
export interface TilesetTable {
  readonly tilesetId: string;
  /** Referência da imagem (caminho relativo ao projeto ou id de artefato). */
  readonly image: string;
  /** Lado da célula do atlas, em pixels da imagem. */
  readonly tileSize: number;
  readonly columns: number;
  /** Ids válidos são `0..tileCount-1`. */
  readonly tileCount: number;
}

/** Região retangular na imagem do atlas, em pixels. */
export interface AtlasRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Região do tile na imagem, ou `undefined` quando o id está fora da tabela.
 * Sem arte não é erro — é o fallback determinístico, nos dois lados.
 */
export function tileRegion(table: TilesetTable, tileId: number): AtlasRegion | undefined {
  if (!Number.isInteger(tileId) || tileId < 0 || tileId >= table.tileCount) {
    return undefined;
  }
  return {
    x: (tileId % table.columns) * table.tileSize,
    y: Math.floor(tileId / table.columns) * table.tileSize,
    width: table.tileSize,
    height: table.tileSize,
  };
}

/**
 * Cor determinística de fallback por `tileId` — o MESMO hash do host
 * (`GridsmithGame.ColorOf`): multiplicação de Knuth em 32 bits e um canal por
 * byte. Divergir aqui faria os dois lados degradarem para cores DIFERENTES, e
 * a degradação conjunta é parte do contrato.
 */
export function fallbackTileColor(tileId: number): string {
  const hash = (Math.imul(tileId, 2654435761) >>> 0) >>> 0;
  const r = 80 + (hash & 0x7f);
  const g = 80 + ((hash >> 8) & 0x7f);
  const b = 80 + ((hash >> 16) & 0x7f);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
