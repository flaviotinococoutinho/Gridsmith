/**
 * Estado de foco do workbench, alimentado por PanelRegistry. O modelo não
 * contém catálogo de painéis, labels ou capability IDs próprios.
 */

import type { ContributionContext } from "./contributionContext.js";
import type { PanelRegistry } from "./panelRegistry.js";

export interface NavigationItem {
  readonly panelId: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly active: boolean;
}

export class WorkbenchModel<TMountTarget = unknown> {
  private activePanel: string | undefined;
  private bottomTab: string | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly panels: PanelRegistry<TMountTarget>,
    private context: ContributionContext,
  ) {
    this.reconcile();
  }

  get currentPanel(): string | undefined {
    return this.activePanel;
  }

  get currentBottomTab(): string | undefined {
    return this.bottomTab;
  }

  updateContext(context: ContributionContext): void {
    this.context = context;
    this.reconcile();
    this.notify();
  }

  navigation(): NavigationItem[] {
    return this.panels.list(this.context, { includeDisabled: true }).map((panel) => ({
      panelId: panel.contribution.id,
      label: panel.contribution.label,
      enabled: panel.enabled,
      ...(panel.reason ? { reason: panel.reason } : {}),
      active: panel.contribution.id === this.activePanel,
    }));
  }

  activatePanel(panelId: string): boolean {
    const panel = this.panels.availability(panelId, this.context);
    if (!panel?.visible || !panel.enabled) return false;
    if (this.activePanel === panelId) return true;
    this.activePanel = panelId;
    this.notify();
    return true;
  }

  selectBottomTab(panelId: string): boolean {
    const panel = this.panels.availability(panelId, this.context);
    if (!panel?.visible || !panel.enabled || panel.contribution.defaultRegion !== "bottom") {
      return false;
    }
    if (this.bottomTab === panelId) return true;
    this.bottomTab = panelId;
    this.notify();
    return true;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private reconcile(): void {
    const visible = this.panels.list(this.context, { includeDisabled: true });
    if (!visible.some((panel) => panel.enabled && panel.contribution.id === this.activePanel)) {
      this.activePanel = visible.find((panel) => panel.enabled)?.contribution.id;
    }
    const bottom = visible.filter((panel) => panel.contribution.defaultRegion === "bottom");
    if (!bottom.some((panel) => panel.enabled && panel.contribution.id === this.bottomTab)) {
      this.bottomTab = bottom.find((panel) => panel.enabled)?.contribution.id;
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
