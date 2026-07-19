/**
 * Reconcilia uma região do workbench com o PanelRegistry.
 *
 * A reconciliação é por identidade: mudanças em seleção ou layout não
 * desmontam o painel ativo enquanto a mesma contribuição continuar
 * elegível. Isso protege gestos abertos no editor central.
 */

import type { ContributionContext } from "../core/contributionContext.js";
import {
  PanelRegistry,
  type PanelInstance,
  type PanelRegion,
  type ResolvedPanel,
} from "../core/panelRegistry.js";

export interface PanelHostOptions {
  readonly region: PanelRegion;
  readonly content: HTMLElement;
  readonly registry: PanelRegistry<HTMLElement>;
  readonly context: () => ContributionContext;
  readonly tabs?: HTMLElement;
  readonly emptyLabel?: string;
  /** Mudança de chave força uma nova instância mesmo com o mesmo panelId. */
  readonly instanceKey?: () => string | undefined;
  readonly onActivated?: (panelId: string | undefined) => void;
  readonly onError?: (panelId: string, error: unknown) => void;
}

export class PanelHostController {
  private activeId: string | undefined;
  private mountedId: string | undefined;
  private mountedKey: string | undefined;
  private instance: PanelInstance | undefined;
  private blockedId: string | undefined;
  private failedId: string | undefined;
  private failedKey: string | undefined;
  private readonly releases: Array<() => void> = [];

  constructor(private readonly options: PanelHostOptions) {
    this.releases.push(options.registry.onDidChange(() => this.refresh()));
    this.refresh();
  }

  get currentPanelId(): string | undefined {
    return this.activeId;
  }

  activate(panelId: string, focus = false): boolean {
    const resolved = this.options.registry.availability(panelId, this.options.context());
    if (!resolved?.visible || resolved.contribution.defaultRegion !== this.options.region) {
      return false;
    }
    const changed = this.activeId !== panelId;
    this.activeId = panelId;
    this.renderTabs(this.availablePanels());
    this.reconcile(resolved);
    if (focus) this.instance?.focus?.();
    if (changed) this.options.onActivated?.(panelId);
    return resolved.enabled && Boolean(this.instance);
  }

  /** Atualiza eligibility/navegação sem remontar uma contribuição estável. */
  refresh(): void {
    const panels = this.availablePanels();
    const current = panels.find(({ contribution }) => contribution.id === this.activeId);
    const next = current ?? panels.find((panel) => panel.enabled) ?? panels[0];
    const nextId = next?.contribution.id;
    const changed = nextId !== this.activeId;
    this.activeId = nextId;
    this.renderTabs(panels);
    this.reconcile(next);
    if (changed) this.options.onActivated?.(nextId);
  }

  /** Solicita atualização ao painel sem destruir sua instância. */
  activateCurrent(): void {
    if (!this.instance?.activate) return;
    try {
      this.instance.activate();
    } catch (error) {
      const panelId = this.mountedId;
      const panel = panelId
        ? this.options.registry.availability(panelId, this.options.context())
        : undefined;
      if (panel) this.failPanel(panel, error, this.mountedKey);
      else if (panelId) this.options.onError?.(panelId, error);
    }
  }

  dispose(): void {
    this.disposeInstance();
    for (const release of this.releases.splice(0).reverse()) release();
    this.options.tabs?.querySelectorAll("[data-panel-tab]").forEach((node) => node.remove());
  }

  private availablePanels(): ResolvedPanel<HTMLElement>[] {
    return this.options.registry.list(this.options.context(), {
      region: this.options.region,
      includeDisabled: true,
    });
  }

  private reconcile(panel: ResolvedPanel<HTMLElement> | undefined): void {
    if (!panel) {
      this.disposeInstance();
      this.blockedId = undefined;
      this.failedId = undefined;
      this.failedKey = undefined;
      this.options.content.replaceChildren(emptyState(this.options.emptyLabel ?? "Nenhum painel disponível."));
      return;
    }

    const id = panel.contribution.id;
    if (!panel.enabled) {
      if (this.blockedId === id && this.mountedId === undefined) return;
      this.disposeInstance();
      this.blockedId = id;
      this.failedId = undefined;
      this.failedKey = undefined;
      this.options.content.replaceChildren(unavailableState(panel.contribution.label, panel.reason));
      return;
    }

    const instanceKey = this.options.instanceKey?.();
    this.blockedId = undefined;
    if (this.failedId === id && this.failedKey === instanceKey && this.mountedId === undefined) return;
    if (canReusePanelInstance(this.mountedId, this.mountedKey, id, instanceKey, Boolean(this.instance))) {
      try {
        this.instance?.activate?.();
      } catch (error) {
        this.failPanel(panel, error);
      }
      return;
    }

    this.disposeInstance();
    this.options.content.replaceChildren();
    try {
      this.instance = this.options.registry.mount(id, {
        ...this.options.context(),
        mountTarget: this.options.content,
      });
      this.mountedId = id;
      this.mountedKey = instanceKey;
      this.failedId = undefined;
      this.failedKey = undefined;
      this.instance.activate?.();
    } catch (error) {
      this.failPanel(panel, error, instanceKey);
    }
  }

  private disposeInstance(): void {
    const instance = this.instance;
    const panelId = this.mountedId;
    this.instance = undefined;
    this.mountedId = undefined;
    this.mountedKey = undefined;
    if (!instance) return;
    try {
      instance.deactivate?.();
    } catch (error) {
      if (panelId) this.options.onError?.(panelId, error);
    }
    try {
      instance.dispose();
    } catch (error) {
      if (panelId) this.options.onError?.(panelId, error);
    }
  }

  private failPanel(
    panel: ResolvedPanel<HTMLElement>,
    error: unknown,
    instanceKey = this.options.instanceKey?.(),
  ): void {
    const id = panel.contribution.id;
    const focusWasInsidePanel = this.options.content.contains(
      this.options.content.ownerDocument.activeElement,
    );
    this.disposeInstance();
    this.failedId = id;
    this.failedKey = instanceKey;
    this.options.onError?.(id, error);
    const errorState = panelErrorState(
      panel.contribution.label,
      error,
      () => {
        this.failedId = undefined;
        this.failedKey = undefined;
        this.refresh();
        if (this.instance?.focus) this.instance.focus();
        else {
          const activeTab = this.options.tabs?.querySelector<HTMLElement>(
            "[data-panel-tab][aria-selected='true']",
          );
          if (activeTab) activeTab.focus();
          else {
            if (this.options.content.tabIndex < 0) this.options.content.tabIndex = -1;
            this.options.content.focus();
          }
        }
      },
    );
    this.options.content.replaceChildren(errorState);
    if (focusWasInsidePanel) errorState.querySelector<HTMLButtonElement>("button")?.focus();
  }

  private renderTabs(panels: readonly ResolvedPanel<HTMLElement>[]): void {
    const host = this.options.tabs;
    if (!host) return;
    const tabsHadFocus = host.contains(document.activeElement);
    const focusedPanelId = tabsHadFocus
      ? (document.activeElement as HTMLElement).dataset["panelTab"]
      : undefined;
    const tail = host.querySelector<HTMLElement>("[data-panel-tabs-tail]");
    host.querySelectorAll("[data-panel-tab]").forEach((node) => node.remove());
    this.options.content.removeAttribute("aria-labelledby");

    const buttons = panels.map((panel, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["panelTab"] = panel.contribution.id;
      button.role = "tab";
      button.textContent = panel.contribution.icon
        ? `${panel.contribution.icon} ${panel.contribution.label}`
        : panel.contribution.label;
      button.setAttribute("aria-selected", String(panel.contribution.id === this.activeId));
      button.setAttribute("aria-controls", this.options.content.id);
      button.id = `${this.options.content.id}-tab-${safeId(panel.contribution.id)}`;
      button.tabIndex = panel.contribution.id === this.activeId || (!this.activeId && index === 0) ? 0 : -1;
      button.setAttribute("aria-disabled", String(!panel.enabled));
      if (!panel.enabled) button.classList.add("panel-tab-disabled");
      if (panel.reason) {
        button.title = panel.reason;
        button.setAttribute("aria-label", `${panel.contribution.label}. ${panel.reason}`);
      }
      button.addEventListener("click", () => {
        if (!panel.enabled) return;
        this.activate(panel.contribution.id, true);
      });
      button.addEventListener("keydown", (event) => this.navigateTabs(event, buttons, index));
      host.insertBefore(button, tail ?? null);
      if (panel.contribution.id === this.activeId) {
        this.options.content.setAttribute("aria-labelledby", button.id);
      }
      return button;
    });
    if (tabsHadFocus) {
      const target = buttons.find((button) => button.dataset["panelTab"] === focusedPanelId);
      const fallback = buttons.find((button) => button.dataset["panelTab"] === this.activeId &&
        button.getAttribute("aria-disabled") !== "true") ??
        buttons.find((button) => button.getAttribute("aria-disabled") !== "true");
      const nextFocus = target ?? fallback;
      if (!nextFocus) return;
      buttons.forEach((button) => { button.tabIndex = button === nextFocus ? 0 : -1; });
      nextFocus.focus();
    }
  }

  private navigateTabs(
    event: KeyboardEvent,
    buttons: readonly HTMLButtonElement[],
    index: number,
  ): void {
    const enabled = buttons.filter((button) => button.getAttribute("aria-disabled") !== "true");
    if (enabled.length === 0) return;
    const currentEnabledIndex = enabled.indexOf(buttons[index]!);
    let target: HTMLButtonElement | undefined;
    if (event.key === "Home") target = enabled[0];
    else if (event.key === "End") target = enabled.at(-1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      target = enabled[(Math.max(0, currentEnabledIndex) - 1 + enabled.length) % enabled.length];
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      target = enabled[(Math.max(0, currentEnabledIndex) + 1) % enabled.length];
    } else return;
    event.preventDefault();
    target?.focus();
    const id = target?.dataset["panelTab"];
    if (id) this.activate(id);
  }
}

export function canReusePanelInstance(
  mountedId: string | undefined,
  mountedKey: string | undefined,
  nextId: string,
  nextKey: string | undefined,
  hasInstance: boolean,
): boolean {
  return hasInstance && mountedId === nextId && mountedKey === nextKey;
}

function emptyState(message: string): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = "muted panel-empty-state";
  paragraph.textContent = message;
  return paragraph;
}

function unavailableState(label: string, reason: string | undefined): HTMLElement {
  const card = document.createElement("section");
  card.className = "panel-unavailable";
  card.setAttribute("role", "status");
  const heading = document.createElement("h2");
  heading.textContent = `${label} indisponível`;
  const explanation = document.createElement("p");
  explanation.textContent = reason ?? "Esta contribuição não está disponível no contexto atual.";
  card.append(heading, explanation);
  return card;
}

function panelErrorState(label: string, error: unknown, retry: () => void): HTMLElement {
  const card = document.createElement("section");
  card.className = "panel-unavailable";
  card.setAttribute("role", "alert");
  const heading = document.createElement("h2");
  heading.textContent = `${label} encontrou um erro`;
  const explanation = document.createElement("p");
  explanation.textContent = error instanceof Error ? error.message : String(error);
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Tentar novamente";
  button.addEventListener("click", retry);
  card.append(heading, explanation, button);
  return card;
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-");
}
