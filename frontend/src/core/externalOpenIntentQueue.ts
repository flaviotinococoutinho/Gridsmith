/** Fila serial e testável para paths recebidos da segunda instância/OS. */

export type ExternalOpenIntentOutcome = "consumed" | "blocked";
export type ExternalOpenIntentHandler = (
  filePath: string,
) => Promise<ExternalOpenIntentOutcome>;

export class ExternalOpenIntentQueue {
  private readonly paths: string[] = [];
  private activeDrain: Promise<void> | undefined;

  constructor(private readonly handle: ExternalOpenIntentHandler) {}

  enqueue(filePath: string): Promise<void> {
    if (!filePath.trim()) throw new Error("External open filePath is required.");
    this.paths.push(filePath);
    return this.drain();
  }

  /** Reexecuta o primeiro intent preservado depois que um draft foi corrigido. */
  retry(): Promise<void> {
    const active = this.activeDrain;
    return active ? active.then(() => this.drain()) : this.drain();
  }

  get pendingPaths(): readonly string[] {
    return Object.freeze([...this.paths]);
  }

  private drain(): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    let task!: Promise<void>;
    task = this.drainLoop().finally(() => {
      if (this.activeDrain === task) this.activeDrain = undefined;
    });
    this.activeDrain = task;
    return task;
  }

  private async drainLoop(): Promise<void> {
    while (this.paths.length > 0) {
      const filePath = this.paths[0]!;
      if (await this.handle(filePath) === "blocked") return;
      this.paths.shift();
    }
  }
}
