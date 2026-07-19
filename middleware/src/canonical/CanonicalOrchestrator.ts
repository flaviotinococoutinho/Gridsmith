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
import { CommandHistory } from "./CommandHistory.js";

export interface DispatchResult {
  readonly event: BlueprintEvent;
  readonly projection: ProjectionResult | undefined;
  readonly commandSequence: bigint;
}

export interface DispatchOptions {
  /** Replay de preparação: valida/faz apply no store temporário, sem side-effects externos. */
  readonly mode?: "live" | "prepare";
}

export class CanonicalOrchestrator {
  constructor(
    private readonly store: BlueprintStore,
    private readonly hooks: HookBus,
    private readonly adapter?: RuntimeAdapter,
    readonly history = new CommandHistory(),
  ) {}

  async dispatch(command: BlueprintCommand, options: DispatchOptions = {}): Promise<DispatchResult> {
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

    // Store + histórico formam o commit canônico síncrono. Nenhum await pode
    // existir entre ambos: projeção/runtime é consequência recuperável e não
    // pode deixar o documento à frente de commandSequence/EventJournal.
    const event = this.store.apply(filtered);
    const entry = this.history.append(filtered, event);
    const preparing = options.mode === "prepare";
    if (!preparing) await this.hooks.doAction(`event:${event.kind}`, event);

    let projection: ProjectionResult | undefined;
    if (!preparing && this.adapter) {
      try {
        projection = await this.adapter.project(event);
      } catch (error) {
        // O Blueprint é a fonte de verdade. Uma falha externa após o commit
        // vira estado deferred explícito e será reparada por rehydrateFrom;
        // jamais transforma um comando aplicado em mutação invisível.
        projection = {
          event: event.kind,
          status: "deferred",
          reason: `runtime projection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (projection) {
      await this.hooks.doAction("projection:completed", projection);
    }

    return { event, projection, commandSequence: entry.commandSequence };
  }
}
