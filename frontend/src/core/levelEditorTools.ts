/**
 * Lógica PURA das ferramentas do editor de níveis (P0.4) — separada da vista
 * para ser testável e portável a workers (regra F1: só imports relativos).
 *
 * A vista (renderer/levelEditorView.ts) fica com DOM/eventos; aqui vivem as
 * decisões: quais células um arrasto cobre (ghost), o que cada pincel faz,
 * snap ao centro da célula e hit-test de marcadores de entidade.
 */

import { IntGridDocument, lineCells } from "./intGridDocument.js";
import type { ToolContext, ToolInstance, ToolKind } from "./toolRegistry.js";

export type LevelTool = "pencil" | "eraser" | "flood" | "rect" | "line" | "picker" | "entity";

/**
 * Ferramentas cujo comportamento de canvas já pertence ao editor de níveis.
 * Os demais kinds podem continuar registrados (e explicar por que estão
 * indisponíveis), sem obrigar a vista a conhecer IDs de contribuição.
 */
export type LevelEditorToolKind = Extract<
  ToolKind,
  | "selection"
  | "pencil"
  | "eraser"
  | "line"
  | "rectangle"
  | "flood"
  | "picker"
  | "entity"
>;

/** Chave da porta privada injetada pela vista no contexto das contribuições. */
export const LEVEL_EDITOR_TOOL_CONTROLLER_SERVICE = "level-editor.tool-controller";

/**
 * Entrada independente de DOM entregue pelo canvas à ferramenta ativa. Assim,
 * mousedown/mousemove/teclado não precisam de um switch de IDs na casca.
 */
export type LevelEditorToolInput =
  | {
    readonly type: "pointer-down";
    readonly screenX: number;
    readonly screenY: number;
    readonly button: number;
  }
  | {
    readonly type: "pointer-move";
    readonly screenX: number;
    readonly screenY: number;
  }
  | { readonly type: "pointer-up" }
  | { readonly type: "delete" };

export interface LevelEditorToolInstance extends ToolInstance {
  handleInput(input: LevelEditorToolInput): void;
}

export interface LevelEditorToolController {
  activate(kind: LevelEditorToolKind): LevelEditorToolInstance;
}

/**
 * Adapter usado por contribuições internas no ToolRegistry. O registro declara
 * apenas o kind; a implementação concreta continua pertencendo à vista ativa.
 */
export function activateLevelEditorTool(
  kind: LevelEditorToolKind,
  context: ToolContext,
): LevelEditorToolInstance {
  const candidate = context.services?.get(LEVEL_EDITOR_TOOL_CONTROLLER_SERVICE);
  if (!isLevelEditorToolController(candidate)) {
    throw new Error("O editor de níveis ativo não forneceu o controlador de ferramentas.");
  }
  return candidate.activate(kind);
}

function isLevelEditorToolController(value: unknown): value is LevelEditorToolController {
  return typeof value === "object"
    && value !== null
    && "activate" in value
    && typeof value.activate === "function";
}

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

/** Pincéis pontuais (pencil/eraser/flood) dentro do gesto já aberto. */
export function applyBrushAt(
  doc: IntGridDocument,
  tool: LevelTool,
  x: number,
  y: number,
  activeValue: number,
): boolean {
  if (tool === "pencil") return doc.paint(x, y, activeValue);
  if (tool === "eraser") return doc.paint(x, y, 0);
  if (tool === "flood") return doc.floodFill(x, y, activeValue);
  return false;
}

/**
 * Segmento contínuo de pincel/borracha. Interpolar evita buracos quando o SO
 * entrega pointermoves espaçados; o IntGrid agrega tudo na mesma transação.
 */
export function applyBrushStroke(
  doc: IntGridDocument,
  tool: "pencil" | "eraser",
  from: CellPoint,
  to: CellPoint,
  activeValue: number,
): boolean {
  let changed = false;
  for (const [x, y] of lineCells(from.x, from.y, to.x, to.y)) {
    changed = doc.paint(x, y, tool === "eraser" ? 0 : activeValue) || changed;
  }
  return changed;
}

/** Commit de um arrasto rect/line dentro da transação corrente. */
export function commitDrag(
  doc: IntGridDocument,
  tool: LevelTool,
  anchor: CellPoint,
  current: CellPoint,
  activeValue: number,
): boolean {
  if (tool === "rect") return doc.fillRect(anchor.x, anchor.y, current.x, current.y, activeValue);
  if (tool === "line") return doc.paintLine(anchor.x, anchor.y, current.x, current.y, activeValue);
  return false;
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
