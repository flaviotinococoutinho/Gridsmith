/** Lightweight UI diagnostics shown by the internal Performance panel. */

export interface WorkbenchMetricSnapshot {
  readonly startedAt: number;
  readonly blueprintEvents: number;
  readonly projectionResyncs: number;
  readonly commandsExecuted: number;
  readonly panelActivations: number;
}

export class WorkbenchMetrics {
  private readonly startedAt: number;
  private blueprintEvents = 0;
  private projectionResyncs = 0;
  private commandsExecuted = 0;
  private panelActivations = 0;
  private readonly listeners = new Set<() => void>();

  constructor(now: () => number = Date.now) {
    this.startedAt = now();
  }

  record(kind: "blueprint-event" | "projection-resync" | "command" | "panel-activation"): void {
    if (kind === "blueprint-event") this.blueprintEvents++;
    else if (kind === "projection-resync") this.projectionResyncs++;
    else if (kind === "command") this.commandsExecuted++;
    else this.panelActivations++;
    for (const listener of [...this.listeners]) listener();
  }

  get snapshot(): WorkbenchMetricSnapshot {
    return Object.freeze({
      startedAt: this.startedAt,
      blueprintEvents: this.blueprintEvents,
      projectionResyncs: this.projectionResyncs,
      commandsExecuted: this.commandsExecuted,
      panelActivations: this.panelActivations,
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
