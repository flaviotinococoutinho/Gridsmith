import {
  ContributionUnavailableError,
  evaluateCapabilities,
  type ContributionAvailability,
} from "./capabilityRegistry.js";
import type { ContributionContext } from "./contributionContext.js";
import {
  supportsSelections,
  type SelectionKind,
  type SelectionMatchPolicy,
} from "./selectionService.js";

export type BuiltInToolKind =
  | "selection"
  | "pencil"
  | "eraser"
  | "line"
  | "rectangle"
  | "flood"
  | "eyedropper"
  /** Alias interno mantido enquanto o editor de nível migra para eyedropper. */
  | "picker"
  | "entity"
  | "camera"
  | "light"
  | "spawn"
  | "trigger";

/** Mantém autocomplete dos tipos do MVP sem fechar o registry a ferramentas futuras. */
export type ToolKind = BuiltInToolKind | (string & {});

export interface ToolContext extends ContributionContext {
  readonly executeCommand?: (commandId: string, args?: unknown) => Promise<unknown>;
}

export interface ToolInstance {
  cancel?(reason: string): void;
  dispose(): void;
}

export interface ToolContribution {
  readonly id: string;
  readonly kind: ToolKind;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly cursor?: string;
  readonly order?: number;
  readonly requiredCapabilities: readonly string[];
  readonly supportedSelections?: readonly SelectionKind[];
  readonly selectionPolicy?: SelectionMatchPolicy;
  readonly visibleWhen?: (context: ContributionContext) => boolean;
  activate(context: ToolContext): ToolInstance;
}

export interface ResolvedTool extends ContributionAvailability {
  readonly contribution: ToolContribution;
}

export interface ToolListOptions {
  readonly includeHidden?: boolean;
  readonly includeDisabled?: boolean;
}

export interface ToolActivationChange {
  readonly previousId?: string;
  readonly activeId?: string;
  readonly reason: "activate" | "deactivate" | "unavailable" | "unregister";
}

export class ToolRegistry {
  private readonly contributions = new Map<string, ToolContribution>();
  private readonly registrationListeners = new Set<() => void>();
  private readonly activationListeners = new Set<(change: ToolActivationChange) => void>();
  private active: { readonly contribution: ToolContribution; readonly instance: ToolInstance } | undefined;

  register(contribution: ToolContribution): () => void {
    assertTool(contribution);
    if (this.contributions.has(contribution.id)) {
      throw new Error(`Tool contribution “${contribution.id}” is already registered.`);
    }
    this.contributions.set(contribution.id, contribution);
    this.notifyRegistration();
    return () => {
      if (this.contributions.get(contribution.id) !== contribution) return;
      if (this.active?.contribution === contribution) this.deactivate("unregister");
      this.contributions.delete(contribution.id);
      this.notifyRegistration();
    };
  }

  get activeId(): string | undefined {
    return this.active?.contribution.id;
  }

  get activeInstance(): ToolInstance | undefined {
    return this.active?.instance;
  }

  get activeTool(): ToolContribution | undefined {
    return this.active?.contribution;
  }

  get(id: string): ToolContribution | undefined {
    return this.contributions.get(id);
  }

  availability(id: string, context: ContributionContext): ResolvedTool | undefined {
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
        ? { reason: "A ferramenta não se aplica à seleção atual." }
        : capability.reason
          ? { reason: capability.reason }
          : {}),
      missingCapabilities: capability.missingCapabilities,
    };
  }

  list(context: ContributionContext, options: ToolListOptions = {}): ResolvedTool[] {
    return [...this.contributions.keys()]
      .map((id) => this.availability(id, context)!)
      .filter((tool) => options.includeHidden || tool.visible)
      .filter((tool) => options.includeDisabled !== false || tool.enabled)
      .sort(compareTools);
  }

  activate(id: string, context: ToolContext): ToolInstance {
    const resolved = this.availability(id, context);
    if (!resolved) throw new Error(`Unknown tool contribution “${id}”.`);
    if (!resolved.enabled) {
      throw new ContributionUnavailableError(
        id,
        resolved.reason ?? "A ferramenta não está disponível.",
        resolved.missingCapabilities,
      );
    }
    if (this.active?.contribution.id === id) return this.active.instance;

    // A nova instância é preparada antes de encerrar a ferramenta anterior.
    // Se activate falhar, a interação corrente permanece íntegra.
    const next = resolved.contribution.activate(context);
    const previous = this.active;
    this.active = { contribution: resolved.contribution, instance: next };
    previous?.instance.cancel?.("tool-changed");
    previous?.instance.dispose();
    this.notifyActivation({
      ...(previous ? { previousId: previous.contribution.id } : {}),
      activeId: id,
      reason: "activate",
    });
    return next;
  }

  deactivate(reason: ToolActivationChange["reason"] = "deactivate"): boolean {
    if (!this.active) return false;
    const previous = this.active;
    this.active = undefined;
    previous.instance.cancel?.(reason);
    previous.instance.dispose();
    this.notifyActivation({ previousId: previous.contribution.id, reason });
    return true;
  }

  /** Reavalia o tool ativo quando capability, seleção ou modo mudam. */
  refresh(context: ContributionContext): boolean {
    if (!this.active) return false;
    const resolved = this.availability(this.active.contribution.id, context);
    if (resolved?.enabled) return false;
    return this.deactivate("unavailable");
  }

  onDidChange(listener: () => void): () => void {
    this.registrationListeners.add(listener);
    return () => this.registrationListeners.delete(listener);
  }

  onDidActivate(listener: (change: ToolActivationChange) => void): () => void {
    this.activationListeners.add(listener);
    return () => this.activationListeners.delete(listener);
  }

  private notifyRegistration(): void {
    for (const listener of [...this.registrationListeners]) listener();
  }

  private notifyActivation(change: ToolActivationChange): void {
    for (const listener of [...this.activationListeners]) listener(change);
  }
}

function assertTool(tool: ToolContribution): void {
  if (!tool.id.trim()) throw new Error("Tool id must not be empty.");
  if (!tool.label.trim()) throw new Error(`Tool “${tool.id}” must have a label.`);
  if (!tool.kind.trim()) throw new Error(`Tool “${tool.id}” must have a kind.`);
}

function compareTools(left: ResolvedTool, right: ResolvedTool): number {
  return (left.contribution.order ?? 0) - (right.contribution.order ?? 0)
    || left.contribution.label.localeCompare(right.contribution.label, "pt-BR")
    || left.contribution.id.localeCompare(right.contribution.id);
}
