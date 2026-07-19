import {
  ContributionUnavailableError,
  evaluateCapabilities,
  type ContributionAvailability,
} from "./capabilityRegistry.js";
import type { ContributionContext } from "./contributionContext.js";
import {
  supportsSelections,
  type SelectionMatchPolicy,
  type SelectionKind,
} from "./selectionService.js";

export type PanelRegion = "left" | "center" | "right" | "bottom";

export interface PanelContext<TMountTarget = unknown> extends ContributionContext {
  readonly mountTarget: TMountTarget;
}

export type { ContributionContext } from "./contributionContext.js";

export interface PanelInstance {
  activate?(): void;
  deactivate?(): void;
  focus?(): void;
  dispose(): void;
}

export interface PanelContribution<TMountTarget = unknown> {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly defaultRegion: PanelRegion;
  readonly requiredCapabilities: readonly string[];
  readonly supportedSelections?: readonly SelectionKind[];
  readonly selectionPolicy?: SelectionMatchPolicy;
  readonly order?: number;
  /** Filtro contextual; seleção incompatível também torna o painel invisível. */
  readonly visibleWhen?: (context: ContributionContext) => boolean;
  mount(context: PanelContext<TMountTarget>): PanelInstance;
}

export interface ResolvedPanel<TMountTarget = unknown> extends ContributionAvailability {
  readonly contribution: PanelContribution<TMountTarget>;
}

export interface PanelListOptions {
  /** Inclui itens invisíveis para diagnóstico/testes. */
  readonly includeHidden?: boolean;
  /** Inclui itens visíveis, porém bloqueados por capability. O padrão é true. */
  readonly includeDisabled?: boolean;
  readonly region?: PanelRegion;
}

export class PanelRegistry<TMountTarget = unknown> {
  private readonly contributions = new Map<string, PanelContribution<TMountTarget>>();
  private readonly listeners = new Set<() => void>();

  register(contribution: PanelContribution<TMountTarget>): () => void {
    assertContributionIdentity(contribution.id, contribution.label);
    if (this.contributions.has(contribution.id)) {
      throw new Error(`Panel contribution “${contribution.id}” is already registered.`);
    }
    this.contributions.set(contribution.id, contribution);
    this.notify();
    return () => {
      if (this.contributions.get(contribution.id) !== contribution) return;
      this.contributions.delete(contribution.id);
      this.notify();
    };
  }

  get(id: string): PanelContribution<TMountTarget> | undefined {
    return this.contributions.get(id);
  }

  availability(id: string, context: ContributionContext): ResolvedPanel<TMountTarget> | undefined {
    const contribution = this.contributions.get(id);
    if (!contribution) return undefined;
    const capability = evaluateCapabilities(contribution.requiredCapabilities, context.capabilities);
    const selectionSupported = supportsSelections(
      contribution.supportedSelections,
      context.selection.selections,
      contribution.selectionPolicy,
    );
    const visible = selectionSupported && (contribution.visibleWhen?.(context) ?? true);
    return {
      contribution,
      visible,
      enabled: visible && capability.enabled,
      ...(!selectionSupported
        ? { reason: "O painel não se aplica à seleção atual." }
        : capability.reason
          ? { reason: capability.reason }
          : {}),
      missingCapabilities: capability.missingCapabilities,
    };
  }

  list(context: ContributionContext, options: PanelListOptions = {}): ResolvedPanel<TMountTarget>[] {
    const resolved = [...this.contributions.keys()]
      .map((id) => this.availability(id, context)!)
      .filter(({ contribution }) => !options.region || contribution.defaultRegion === options.region)
      .filter((panel) => options.includeHidden || panel.visible)
      .filter((panel) => options.includeDisabled !== false || panel.enabled);
    return resolved.sort(comparePanels);
  }

  mount(id: string, context: PanelContext<TMountTarget>): PanelInstance {
    const resolved = this.availability(id, context);
    if (!resolved) throw new Error(`Unknown panel contribution “${id}”.`);
    if (!resolved.enabled) {
      throw new ContributionUnavailableError(
        id,
        resolved.reason ?? "O painel não está disponível.",
        resolved.missingCapabilities,
      );
    }
    return resolved.contribution.mount(context);
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function assertContributionIdentity(id: string, label: string): void {
  if (!id.trim()) throw new Error("Contribution id must not be empty.");
  if (!label.trim()) throw new Error(`Contribution “${id}” must have a label.`);
}

function comparePanels<T>(left: ResolvedPanel<T>, right: ResolvedPanel<T>): number {
  return (left.contribution.order ?? 0) - (right.contribution.order ?? 0)
    || left.contribution.label.localeCompare(right.contribution.label, "pt-BR")
    || left.contribution.id.localeCompare(right.contribution.id);
}
