/**
 * Lógica PURA das ferramentas do editor de níveis (P0.4) — separada da vista
 * para ser testável e portável a workers (regra F1: só imports relativos).
 *
 * A vista (renderer/levelEditorView.ts) fica com DOM/eventos; aqui vivem as
 * decisões: quais células um arrasto cobre (ghost), o que cada pincel faz,
 * snap ao centro da célula e hit-test de marcadores de entidade.
 */

import { IntGridDocument, lineCells, type CellChange } from "./intGridDocument.js";

export type LevelTool = "pencil" | "eraser" | "flood" | "rect" | "line" | "picker" | "entity";

export interface CellPoint {
  readonly x: number;
  readonly y: number;
}

/** Células cobertas por um arrasto de retângulo/linha (ghost e commit). */
export function dragCells(
  tool: LevelTool,
  anchor: CellPoint | undefined,
  current: CellPoint | undefined,
): Array<[number, number]> {
  if (!anchor || !current) return [];
  if (tool === "line") return lineCells(anchor.x, anchor.y, current.x, current.y);
  if (tool !== "rect") return [];
  const cells: Array<[number, number]> = [];
  const [minX, maxX] = anchor.x <= current.x ? [anchor.x, current.x] : [current.x, anchor.x];
  const [minY, maxY] = anchor.y <= current.y ? [anchor.y, current.y] : [current.y, anchor.y];
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) cells.push([x, y]);
  return cells;
}

/**
 * Pincéis pontuais (pencil/eraser/flood). Devolve as células que MUDARAM — é
 * esse lote que o gesto acumula para virar `level/patch` (F6); lote vazio
 * significa que o traço passou por onde já estava pintado assim.
 */
export function applyBrushAt(
  doc: IntGridDocument,
  tool: LevelTool,
  x: number,
  y: number,
  activeValue: number,
): readonly CellChange[] {
  if (tool === "pencil") return doc.paint(x, y, activeValue);
  if (tool === "eraser") return doc.paint(x, y, 0);
  if (tool === "flood") return doc.floodFill(x, y, activeValue);
  return [];
}

/** Commit de um arrasto rect/line — um gesto só, logo um comando só. */
export function commitDrag(
  doc: IntGridDocument,
  tool: LevelTool,
  anchor: CellPoint,
  current: CellPoint,
  activeValue: number,
): readonly CellChange[] {
  if (tool === "rect") return doc.fillRect(anchor.x, anchor.y, current.x, current.y, activeValue);
  if (tool === "line") return doc.paintLine(anchor.x, anchor.y, current.x, current.y, activeValue);
  return [];
}

/** Posição no mundo (pixels) ancorada ao CENTRO da célula. */
export function cellCenter(cellX: number, cellY: number, tileSize: number): [number, number] {
  return [cellX * tileSize + tileSize / 2, cellY * tileSize + tileSize / 2];
}

export interface MarkerLike {
  readonly entityId: string;
  readonly position: readonly [number, number];
}

/**
 * Hit-test de marcadores em coordenadas de TELA. `project` converte
 * mundo→tela (injetado pela vista a partir do viewport) — o teste fica puro.
 */
export function hitMarker<T extends MarkerLike>(
  markers: Iterable<T>,
  screenX: number,
  screenY: number,
  project: (worldX: number, worldY: number) => { x: number; y: number },
  hitRadius: number,
): T | undefined {
  for (const marker of markers) {
    const screen = project(marker.position[0], marker.position[1]);
    if (Math.hypot(screen.x - screenX, screen.y - screenY) <= hitRadius) return marker;
  }
  return undefined;
}

/** Próximo id livre para instâncias `prefix-N` (placement incremental). */
export function nextEntityId(existing: ReadonlySet<string> | ReadonlyMap<string, unknown>, prefix: string): string {
  const has = (id: string): boolean => ("has" in existing ? existing.has(id) : false);
  let n = ("size" in existing ? existing.size : 0) + 1;
  while (has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/**
 * Escolhe o nível que a vista deve abrir.
 *
 * O editor NÃO pode assumir um id: um projeto pode vir do template canônico,
 * de um agente MCP ou de outro editor, cada um com seus próprios ids. Sem
 * isto, um projeto cujo nível se chame diferente abre com o canvas vazio e a
 * publicação cria um SEGUNDO nível ao lado do original.
 *
 * Preferido quando informado (seleção explícita do usuário); senão o primeiro
 * da projeção, que é a ordem canônica do Blueprint.
 */
export function pickLevel<T extends { levelId: string }>(
  levels: readonly T[],
  preferredId?: string,
): T | undefined {
  if (preferredId !== undefined) {
    const preferred = levels.find((level) => level.levelId === preferredId);
    if (preferred) return preferred;
  }
  return levels[0];
}

/**
 * Escolhe a definição de entidade que a ferramenta de placement usa.
 *
 * Prefere uma definição COM `archetypeId`: só essas viram ator vivo no
 * runtime — sem ele a projeção devolve `skipped` com razão, e o usuário
 * posiciona algo que nunca aparece no jogo.
 */
export function pickEntityDef<T extends { entityDefId: string; archetypeId?: string }>(
  defs: readonly T[],
): T | undefined {
  return defs.find((def) => typeof def.archetypeId === "string" && def.archetypeId.length > 0)
    ?? defs[0];
}
