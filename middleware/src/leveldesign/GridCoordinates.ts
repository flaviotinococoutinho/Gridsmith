/**
 * Conversões espaciais canônicas do editor.
 *
 * Células são índices inteiros com origem no canto superior esquerdo. Toda
 * posição persistida de entidade/luz usa PIXELS do mundo e âncora no centro
 * da célula — é o que `contracts/schemas/actors.methods.schema.json` exige, e
 * nenhuma camada converte unidade no caminho: o middleware repassa cru e a
 * engine consome cru.
 *
 * Templates, migrações e ferramentas passam por estas funções em vez de
 * reinterpretar coordenadas localmente. Foi exatamente uma reinterpretação
 * local que colocou o template de plataforma em coordenadas de célula, com o
 * player nascendo dentro da célula (0,0) do mundo.
 */

export const WORLD_POSITION_UNIT = "world-pixel" as const;
export const CELL_ORIGIN = "top-left" as const;
export const WORLD_Y_AXIS = "down" as const;
export const ENTITY_ANCHOR = "center" as const;

export interface GridCell {
  readonly x: number;
  readonly y: number;
}

/**
 * Centro da célula, em pixels do mundo.
 *
 * Recusa célula fracionária de propósito: "meia célula" não é uma célula, e
 * aceitar 4.5 aqui reintroduziria a ambiguidade que esta função existe para
 * eliminar. Quem precisa de um ponto que não é centro de célula deve dizer
 * isso explicitamente na origem, com o motivo.
 */
export function cellToWorldCenter(cell: GridCell, tileSize: number): readonly [number, number] {
  assertCell(cell);
  assertTileSize(tileSize);
  return Object.freeze([
    cell.x * tileSize + tileSize / 2,
    cell.y * tileSize + tileSize / 2,
  ]) as readonly [number, number];
}

/** Pixels do mundo → célula que os contém. */
export function worldToCell(position: readonly [number, number], tileSize: number): GridCell {
  assertTileSize(tileSize);
  if (
    !Array.isArray(position) ||
    position.length !== 2 ||
    !position.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    throw new TypeError("world position must contain two finite numbers");
  }
  return Object.freeze({
    x: Math.floor(position[0] / tileSize),
    y: Math.floor(position[1] / tileSize),
  });
}

function assertCell(cell: GridCell): void {
  if (!Number.isInteger(cell.x) || cell.x < 0 || !Number.isInteger(cell.y) || cell.y < 0) {
    throw new RangeError("cell coordinates must be non-negative integers");
  }
}

function assertTileSize(tileSize: number): void {
  if (!Number.isInteger(tileSize) || tileSize < 1) {
    throw new RangeError("tileSize must be a positive integer");
  }
}
