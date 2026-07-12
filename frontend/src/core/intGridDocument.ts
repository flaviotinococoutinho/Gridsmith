/**
 * Documento de edição de IntGrid — o modelo do painel de níveis LDtk-like.
 *
 * O designer pinta SIGNIFICADO (inteiros) com pincéis; cada operação vira um
 * comando de editor com inverso registrado (undo/redo célula a célula, sem
 * snapshots do grid inteiro). Ao publicar, `toLevelPayload` produz o payload
 * do comando canônico `level/define` — a resolução em tiles acontece no
 * middleware/adapter, nunca aqui.
 */

export interface CellChange {
  readonly index: number;
  readonly before: number;
  readonly after: number;
}

interface EditorOp {
  readonly label: string;
  readonly changes: readonly CellChange[];
}

export interface LevelPayloadOptions {
  readonly levelId: string;
  readonly tileSize: number;
  readonly seed: number;
  readonly rules: readonly unknown[];
}

export class IntGridDocument {
  readonly width: number;
  readonly height: number;
  private readonly values: Int16Array;
  private readonly undoStack: EditorOp[] = [];
  private readonly redoStack: EditorOp[] = [];

  constructor(width: number, height: number, initial?: readonly number[]) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError("width and height must be positive integers");
    }
    this.width = width;
    this.height = height;
    this.values = new Int16Array(width * height);
    if (initial) {
      if (initial.length !== width * height) {
        throw new RangeError(`initial values must have ${width * height} cells`);
      }
      this.values.set(initial);
    }
  }

  valueAt(x: number, y: number): number {
    this.assertInside(x, y);
    return this.values[y * this.width + x]!;
  }

  /** Cópia dos valores correntes (para render/serialização). */
  snapshot(): number[] {
    return [...this.values];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Pincel pontual. Pintar o valor já presente é no-op (não entra no histórico). */
  paint(x: number, y: number, value: number): boolean {
    this.assertInside(x, y);
    this.assertValue(value);
    const index = y * this.width + x;
    if (this.values[index] === value) return false;
    this.commit("paint", [{ index, before: this.values[index]!, after: value }]);
    return true;
  }

  /** Preenchimento retangular (inclusivo; cantos em qualquer ordem). */
  fillRect(x0: number, y0: number, x1: number, y1: number, value: number): boolean {
    this.assertInside(x0, y0);
    this.assertInside(x1, y1);
    this.assertValue(value);
    const [minX, maxX] = x0 <= x1 ? [x0, x1] : [x1, x0];
    const [minY, maxY] = y0 <= y1 ? [y0, y1] : [y1, y0];

    const changes: CellChange[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const index = y * this.width + x;
        if (this.values[index] !== value) {
          changes.push({ index, before: this.values[index]!, after: value });
        }
      }
    }
    if (changes.length === 0) return false;
    this.commit("fillRect", changes);
    return true;
  }

  /** Linha de Bresenham entre duas células (inclusiva) — uma única operação de undo. */
  paintLine(x0: number, y0: number, x1: number, y1: number, value: number): boolean {
    this.assertInside(x0, y0);
    this.assertInside(x1, y1);
    this.assertValue(value);

    const changes: CellChange[] = [];
    const touched = new Set<number>();
    for (const [x, y] of lineCells(x0, y0, x1, y1)) {
      const index = y * this.width + x;
      if (!touched.has(index) && this.values[index] !== value) {
        touched.add(index);
        changes.push({ index, before: this.values[index]!, after: value });
      }
    }
    if (changes.length === 0) return false;
    this.commit("paintLine", changes);
    return true;
  }

  /** Balde: preenche a região 4-conectada com o mesmo valor de origem. */
  floodFill(x: number, y: number, value: number): boolean {
    this.assertInside(x, y);
    this.assertValue(value);
    const origin = this.values[y * this.width + x]!;
    if (origin === value) return false;

    const changes: CellChange[] = [];
    const visited = new Uint8Array(this.values.length);
    const queue: number[] = [y * this.width + x];
    visited[y * this.width + x] = 1;

    while (queue.length > 0) {
      const index = queue.pop()!;
      if (this.values[index] !== origin) continue;
      changes.push({ index, before: origin, after: value });

      const cx = index % this.width;
      const neighbors = [
        cx > 0 ? index - 1 : -1,
        cx < this.width - 1 ? index + 1 : -1,
        index - this.width,
        index + this.width,
      ];
      for (const next of neighbors) {
        if (next >= 0 && next < this.values.length && !visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }

    this.commit("floodFill", changes);
    return true;
  }

  undo(): boolean {
    const op = this.undoStack.pop();
    if (!op) return false;
    for (const change of op.changes) {
      this.values[change.index] = change.before;
    }
    this.redoStack.push(op);
    return true;
  }

  redo(): boolean {
    const op = this.redoStack.pop();
    if (!op) return false;
    for (const change of op.changes) {
      this.values[change.index] = change.after;
    }
    this.undoStack.push(op);
    return true;
  }

  /** Payload do comando canônico `level/define` (dispatch via gateway). */
  toLevelPayload(options: LevelPayloadOptions): Record<string, unknown> {
    return {
      levelId: options.levelId,
      width: this.width,
      height: this.height,
      tileSize: options.tileSize,
      seed: options.seed,
      intGrid: this.snapshot(),
      rules: [...options.rules],
    };
  }

  private commit(label: string, changes: readonly CellChange[]): void {
    for (const change of changes) {
      this.values[change.index] = change.after;
    }
    this.undoStack.push({ label, changes });
    this.redoStack.length = 0; // uma edição nova invalida o futuro
  }

  private assertInside(x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new RangeError(`cell (${x}, ${y}) outside ${this.width}×${this.height}`);
    }
  }

  private assertValue(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 32767) {
      throw new RangeError(`IntGrid value must be an integer in [0, 32767] (got ${value})`);
    }
  }
}

/** Células da linha de Bresenham (inclusiva) — também usada pelo ghost do arrasto. */
export function lineCells(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    cells.push([x, y]);
    if (x === x1 && y === y1) return cells;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
}
