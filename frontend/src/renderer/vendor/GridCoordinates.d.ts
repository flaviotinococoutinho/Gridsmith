export interface GridCell {
  readonly x: number;
  readonly y: number;
}

export function cellToWorldCenter(
  cell: GridCell,
  tileSize: number,
): readonly [number, number];
