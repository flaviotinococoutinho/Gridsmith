/**
 * Coordena commits assíncronos iniciados por controles do inspector.
 *
 * A UI pode disparar `change` ao perder foco e, no mesmo gesto, solicitar
 * Save/Close. O coordinator mantém o boundary de projeto aguardando o estado
 * canônico, e conserva uma falha por campo até que aquele campo seja corrigido.
 */
export class PendingEditCoordinator {
  private readonly pending = new Set<Promise<void>>();
  private readonly latest = new Map<string, symbol>();
  private readonly failures = new Map<string, unknown>();

  track<T>(key: string, operation: Promise<T>): Promise<T> {
    const token = Symbol(key);
    this.latest.set(key, token);
    const observed = operation.then(
      (value) => {
        if (this.latest.get(key) === token) this.failures.delete(key);
        return value;
      },
      (error: unknown) => {
        if (this.latest.get(key) === token) this.failures.set(key, error);
        throw error;
      },
    );
    let settled!: Promise<void>;
    settled = observed.then(() => undefined, () => undefined).finally(() => {
      this.pending.delete(settled);
    });
    this.pending.add(settled);
    return observed;
  }

  async flush(): Promise<void> {
    // Um commit pode iniciar outro durante a reconciliação; esvazie até ficar estável.
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    const failure = this.failures.values().next();
    if (!failure.done) throw failure.value;
  }

  clear(): void {
    this.pending.clear();
    this.latest.clear();
    this.failures.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}
