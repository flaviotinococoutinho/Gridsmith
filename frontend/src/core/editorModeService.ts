/**
 * Estado de apresentação do workbench. Ele descreve qual conjunto de
 * contribuições deve aparecer; não inicia nem controla um runtime de preview.
 */

export type EditorMode = "edit" | "playing" | "paused";

export interface EditorModeChange {
  readonly previous: EditorMode;
  readonly current: EditorMode;
  readonly source: string;
}

export class EditorModeService {
  private value: EditorMode;
  private readonly listeners = new Set<(change: EditorModeChange) => void>();

  constructor(initial: EditorMode = "edit") {
    this.value = initial;
  }

  get current(): EditorMode {
    return this.value;
  }

  set(mode: EditorMode, source = "unknown"): boolean {
    if (mode === this.value) return false;
    const previous = this.value;
    this.value = mode;
    const change = Object.freeze({ previous, current: mode, source });
    for (const listener of [...this.listeners]) listener(change);
    return true;
  }

  subscribe(listener: (change: EditorModeChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
