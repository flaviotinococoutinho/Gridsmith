/**
 * Barramento de extensibilidade do modelo canônico: actions e filters com
 * prioridade (docs/CANONICAL-MODEL.md §1).
 *
 * - **Filters** transformam um valor em cadeia (`applyFilters`): cada handler
 *   recebe o valor corrente e devolve o próximo. Usados para interceptar
 *   comandos antes da aplicação e estágios de pipeline.
 * - **Actions** notificam sem transformar (`doAction`): side-effects
 *   desacoplados. Erros em um handler são ISOLADOS — coletados e expostos,
 *   nunca interrompem o dispatch nem os demais handlers.
 *
 * O barramento é inspecionável (`listHooks`) para que agentes LLM descubram
 * os pontos de extensão em runtime.
 */

export type ActionHandler = (payload: unknown) => void | Promise<void>;
export type FilterHandler = (value: unknown) => unknown | Promise<unknown>;

interface Registration {
  readonly id: string;
  readonly priority: number;
  readonly order: number; // desempate estável para prioridades iguais
  readonly handler: ActionHandler | FilterHandler;
}

export interface HookInfo {
  readonly hook: string;
  readonly kind: "action" | "filter";
  readonly handlers: readonly { id: string; priority: number }[];
}

export interface ActionResult {
  /** Handlers executados com sucesso. */
  readonly completed: number;
  /** Erros isolados por handler (id → mensagem). */
  readonly errors: readonly { handlerId: string; message: string }[];
}

export class HookBus {
  private readonly actions = new Map<string, Registration[]>();
  private readonly filters = new Map<string, Registration[]>();
  private counter = 0;

  /** Registra uma action. Retorna a função de remoção. */
  addAction(hook: string, handler: ActionHandler, options?: { priority?: number; id?: string }): () => void {
    return this.register(this.actions, hook, handler, options);
  }

  /** Registra um filter. Retorna a função de remoção. */
  addFilter(hook: string, handler: FilterHandler, options?: { priority?: number; id?: string }): () => void {
    return this.register(this.filters, hook, handler, options);
  }

  /** Dispara uma action: todos os handlers, em ordem de prioridade, com erros isolados. */
  async doAction(hook: string, payload: unknown): Promise<ActionResult> {
    const errors: { handlerId: string; message: string }[] = [];
    let completed = 0;
    for (const registration of this.sorted(this.actions.get(hook))) {
      try {
        await (registration.handler as ActionHandler)(payload);
        completed++;
      } catch (err) {
        errors.push({
          handlerId: registration.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { completed, errors };
  }

  /**
   * Aplica a cadeia de filters ao valor. Um filter que lança interrompe a
   * cadeia (filters participam de validação/transformação — o erro é do
   * chamador tratar).
   */
  async applyFilters<T>(hook: string, initial: T): Promise<T> {
    let value: unknown = initial;
    for (const registration of this.sorted(this.filters.get(hook))) {
      value = await (registration.handler as FilterHandler)(value);
    }
    return value as T;
  }

  /** Inventário completo dos pontos de extensão registrados. */
  listHooks(): HookInfo[] {
    const describe = (map: Map<string, Registration[]>, kind: "action" | "filter"): HookInfo[] =>
      [...map.entries()].map(([hook, registrations]) => ({
        hook,
        kind,
        handlers: this.sorted(registrations).map((r) => ({ id: r.id, priority: r.priority })),
      }));
    return [...describe(this.actions, "action"), ...describe(this.filters, "filter")];
  }

  private register(
    map: Map<string, Registration[]>,
    hook: string,
    handler: ActionHandler | FilterHandler,
    options?: { priority?: number; id?: string },
  ): () => void {
    const registration: Registration = {
      id: options?.id ?? `handler-${++this.counter}`,
      priority: options?.priority ?? 10,
      order: this.counter++,
      handler,
    };
    const list = map.get(hook) ?? [];
    list.push(registration);
    map.set(hook, list);
    return () => {
      const current = map.get(hook);
      if (!current) return;
      const index = current.indexOf(registration);
      if (index >= 0) current.splice(index, 1);
    };
  }

  private sorted(registrations: Registration[] | undefined): Registration[] {
    if (!registrations) return [];
    return [...registrations].sort((a, b) => a.priority - b.priority || a.order - b.order);
  }
}
