import type { CapabilityResolver } from "./capabilityRegistry.js";
import type { SelectionService } from "./selectionService.js";

/** Estado transversal consultado por painéis, comandos e ferramentas. */
export interface ContributionContext {
  readonly selection: SelectionService;
  readonly capabilities: CapabilityResolver;
  /** Modo aberto da aplicação, por exemplo `edit`, `play` ou `pause`. */
  readonly mode: string;
  /** Portas internas injetadas pela composição; o registry não conhece seus IDs. */
  readonly services?: ReadonlyMap<string, unknown>;
}
