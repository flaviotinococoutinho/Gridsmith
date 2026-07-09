/**
 * Orquestrador do modelo canônico (docs/CANONICAL-MODEL.md §1): o ÚNICO
 * caminho de mutação do domínio.
 *
 *   dispatch(comando)
 *     = applyFilters("command:<kind>", comando)   // filters interceptam
 *     → store.apply(...)                          // validação + evento
 *     → doAction("event:<kind>", evento)          // actions notificam
 *     → adapter.project(evento)                   // projeção no runtime
 *
 * UI, ferramentas MCP e agentes usam o mesmo dispatch — mesma validação,
 * mesmos hooks, mesma projeção.
 */

import type { BlueprintCommand, BlueprintEvent, BlueprintStore } from "../domain/BlueprintStore.js";
import type { HookBus } from "./HookBus.js";
import type { ProjectionResult, RuntimeAdapter } from "../runtime/RuntimeAdapter.js";

export interface DispatchResult {
  readonly event: BlueprintEvent;
  readonly projection: ProjectionResult | undefined;
}

export class CanonicalOrchestrator {
  constructor(
    private readonly store: BlueprintStore,
    private readonly hooks: HookBus,
    private readonly adapter?: RuntimeAdapter,
  ) {}

  async dispatch(command: BlueprintCommand): Promise<DispatchResult> {
    const filtered = await this.hooks.applyFilters<BlueprintCommand>(
      `command:${command.kind}`,
      command,
    );
    if (filtered?.kind !== command.kind) {
      throw new Error(
        `Filter chain for "command:${command.kind}" must preserve the command kind ` +
          `(got "${filtered?.kind}")`,
      );
    }

    const event = this.store.apply(filtered);
    await this.hooks.doAction(`event:${event.kind}`, event);

    const projection = this.adapter ? await this.adapter.project(event) : undefined;
    if (projection) {
      await this.hooks.doAction("projection:completed", projection);
    }

    return { event, projection };
  }
}
