/**
 * Projeção otimista do IntGrid canônico.
 *
 * O documento não possui histórico local: ele mantém uma base confirmada,
 * uma transação de gesto aberta e patches aguardando confirmação. Undo e
 * redo pertencem ao CommandHistory da sessão no middleware.
 */

export interface CellChange {
  readonly index: number;
  readonly before: number;
  readonly after: number;
}

export interface IntGridGesture {
  readonly transactionId: string;
  readonly label: string;
  readonly changes: readonly CellChange[];
}

interface MutableGesture {
  readonly transactionId: string;
  readonly label: string;
  readonly changes: Map<number, CellChange>;
}

interface PendingGesture extends IntGridGesture {
  acknowledged: boolean;
}

export class IntGridDocument {
  readonly width: number;
  readonly height: number;
  private readonly confirmed: Int16Array;
  private readonly visible: Int16Array;
  private readonly pending: PendingGesture[] = [];
  private draft: MutableGesture | undefined;

  constructor(width: number, height: number, initial?: readonly number[]) {
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
      throw new RangeError("width and height must be positive integers");
    }
    this.width = width;
    this.height = height;
    this.confirmed = new Int16Array(width * height);
    if (initial) {
      if (initial.length !== width * height) {
        throw new RangeError(`initial values must have ${width * height} cells`);
      }
      for (const value of initial) this.assertValue(value);
      this.confirmed.set(initial);
    }
    this.visible = new Int16Array(this.confirmed);
  }

  valueAt(x: number, y: number): number {
    this.assertInside(x, y);
    return this.visible[y * this.width + x]!;
  }

  /** Estado exibido: base confirmada + patches pendentes + gesto aberto. */
  snapshot(): number[] {
    return [...this.visible];
  }

  /** Estado que já recebeu ack do caminho canônico. */
  confirmedSnapshot(): number[] {
    return [...this.confirmed];
  }

  get hasOpenGesture(): boolean {
    return this.draft !== undefined;
  }

  get pendingTransactionIds(): readonly string[] {
    return this.pending.map((gesture) => gesture.transactionId);
  }

  beginGesture(transactionId: string, label: string): void {
    if (this.draft) throw new Error(`gesture "${this.draft.transactionId}" is already open`);
    if (!transactionId.trim()) throw new Error("transactionId is required");
    if (!label.trim()) throw new Error("gesture label is required");
    if (this.pending.some((gesture) => gesture.transactionId === transactionId)) {
      throw new Error(`transactionId "${transactionId}" is already pending`);
    }
    this.draft = { transactionId, label, changes: new Map() };
  }

  /**
   * Fecha o gesto e o mantém como camada otimista até ack/rejeição. Um
   * gesto sem mudanças reais não produz comando nem histórico.
   */
  finishGesture(): IntGridGesture | undefined {
    const draft = this.requireDraft();
    this.draft = undefined;
    if (draft.changes.size === 0) return undefined;
    const gesture: PendingGesture = {
      transactionId: draft.transactionId,
      label: draft.label,
      changes: Object.freeze([...draft.changes.values()].sort((a, b) => a.index - b.index)),
      acknowledged: false,
    };
    this.pending.push(gesture);
    return Object.freeze({
      transactionId: gesture.transactionId,
      label: gesture.label,
      changes: gesture.changes,
    });
  }

  cancelGesture(): boolean {
    if (!this.draft) return false;
    this.draft = undefined;
    this.rebuildVisible();
    return true;
  }

  /** Confirma o patch. A base só avança na ordem em que os gestos saíram. */
  acknowledge(transactionId: string): boolean {
    const gesture = this.pending.find((candidate) => candidate.transactionId === transactionId);
    if (!gesture) return false;
    gesture.acknowledged = true;
    while (this.pending[0]?.acknowledged) {
      const confirmed = this.pending.shift()!;
      this.applyTo(this.confirmed, confirmed.changes, "after");
    }
    this.rebuildVisible();
    return true;
  }

  /**
   * Remove uma camada rejeitada e recompõe a projeção. Camadas posteriores
   * continuam visíveis e podem ser confirmadas/rejeitadas independentemente.
   */
  reject(transactionId: string): boolean {
    const index = this.pending.findIndex((gesture) => gesture.transactionId === transactionId);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.rebuildVisible();
    return true;
  }

  /**
   * Resolve um ACK atrasado sem reaplicar seu `after`. O snapshot/evento mais
   * novo já avançou a base canônica; só a camada otimista obsoleta é retirada.
   */
  settlePending(transactionId: string): boolean {
    const index = this.pending.findIndex((gesture) => gesture.transactionId === transactionId);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.rebuildVisible();
    return true;
  }

  /**
   * Aplica evento vindo de outro cliente. Se o evento é o eco de uma camada
   * local, o transactionId funciona como ack idempotente.
   */
  applyCanonical(changes: readonly CellChange[], transactionId?: string): void {
    this.validateChanges(changes);
    if (transactionId && this.acknowledge(transactionId)) return;
    this.applyTo(this.confirmed, changes, "after");
    this.rebuildVisible();
  }

  /** Substitui a base somente em Open/resync; não é uma operação de undo. */
  replaceCanonical(values: readonly number[]): void {
    if (values.length !== this.confirmed.length) {
      throw new RangeError(`canonical values must have ${this.confirmed.length} cells`);
    }
    for (const value of values) this.assertValue(value);
    this.confirmed.set(values);
    this.pending.length = 0;
    this.draft = undefined;
    this.rebuildVisible();
  }

  paint(x: number, y: number, value: number): boolean {
    this.assertInside(x, y);
    this.assertValue(value);
    return this.change(y * this.width + x, value);
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, value: number): boolean {
    this.assertInside(x0, y0);
    this.assertInside(x1, y1);
    this.assertValue(value);
    const [minX, maxX] = x0 <= x1 ? [x0, x1] : [x1, x0];
    const [minY, maxY] = y0 <= y1 ? [y0, y1] : [y1, y0];
    let changed = false;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        changed = this.change(y * this.width + x, value) || changed;
      }
    }
    return changed;
  }

  paintLine(x0: number, y0: number, x1: number, y1: number, value: number): boolean {
    this.assertInside(x0, y0);
    this.assertInside(x1, y1);
    this.assertValue(value);
    let changed = false;
    for (const [x, y] of lineCells(x0, y0, x1, y1)) {
      changed = this.change(y * this.width + x, value) || changed;
    }
    return changed;
  }

  floodFill(x: number, y: number, value: number): boolean {
    this.assertInside(x, y);
    this.assertValue(value);
    const origin = this.visible[y * this.width + x]!;
    if (origin === value) return false;

    const visited = new Uint8Array(this.visible.length);
    const queue: number[] = [y * this.width + x];
    visited[y * this.width + x] = 1;
    let changed = false;
    while (queue.length > 0) {
      const index = queue.pop()!;
      if (this.visible[index] !== origin) continue;
      changed = this.change(index, value) || changed;
      const cx = index % this.width;
      const neighbors = [
        cx > 0 ? index - 1 : -1,
        cx < this.width - 1 ? index + 1 : -1,
        index - this.width,
        index + this.width,
      ];
      for (const next of neighbors) {
        if (next >= 0 && next < this.visible.length && !visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    return changed;
  }

  private change(index: number, after: number): boolean {
    const draft = this.requireDraft();
    const current = this.visible[index]!;
    if (current === after) return false;
    const existing = draft.changes.get(index);
    const before = existing?.before ?? current;
    if (after === before) draft.changes.delete(index);
    else draft.changes.set(index, { index, before, after });
    this.visible[index] = after;
    return true;
  }

  private rebuildVisible(): void {
    this.visible.set(this.confirmed);
    for (const gesture of this.pending) this.applyTo(this.visible, gesture.changes, "after");
    if (this.draft) this.applyTo(this.visible, this.draft.changes.values(), "after");
  }

  private applyTo(
    target: Int16Array,
    changes: Iterable<CellChange>,
    side: "before" | "after",
  ): void {
    for (const change of changes) target[change.index] = change[side];
  }

  private validateChanges(changes: readonly CellChange[]): void {
    const seen = new Set<number>();
    for (const change of changes) {
      if (!Number.isInteger(change.index) || change.index < 0 || change.index >= this.confirmed.length) {
        throw new RangeError(`cell index ${change.index} outside grid`);
      }
      if (seen.has(change.index)) throw new RangeError(`duplicate cell index ${change.index}`);
      seen.add(change.index);
      this.assertValue(change.before);
      this.assertValue(change.after);
    }
  }

  private requireDraft(): MutableGesture {
    if (!this.draft) throw new Error("an IntGrid gesture must be open before editing");
    return this.draft;
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

/** Células da linha de Bresenham (inclusiva). */
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
