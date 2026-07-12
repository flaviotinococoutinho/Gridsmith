/**
 * View-model do workbench (ALPHA-0.1 P0.3): o estado de navegação da UI —
 * qual painel está ativo, quais itens o rail mostra (com rótulo humano,
 * habilitação e razão traduzível), e qual aba do painel inferior está aberta.
 * Puro e testável; o renderer só materializa.
 */

import { ExperienceGate, PANEL_REQUIREMENTS, type ResolvedExperienceLike } from "./experienceGate.js";
import { panelLabel } from "./vocabulary.js";

export interface NavigationItem {
  readonly panelId: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Razão de desabilitado (tooltip); ausente quando habilitado. */
  readonly reason?: string;
  readonly active: boolean;
}

export type BottomTab = "problems" | "output" | "history";

export class WorkbenchModel {
  private gate: ExperienceGate | undefined;
  private activePanel: string | undefined;
  private bottomTab: BottomTab = "output";
  private readonly listeners = new Set<() => void>();

  /** Recebida do gateway (experience/resolve); pode ser re-resolvida a qualquer momento. */
  applyExperience(experience: ResolvedExperienceLike): void {
    this.gate = new ExperienceGate(experience);
    // painel ativo que ficou desabilitado perde o foco (fail-safe)
    if (this.activePanel && !this.gate.panel(this.activePanel).enabled) {
      this.activePanel = undefined;
    }
    // sem painel ativo: foca o primeiro habilitado
    if (!this.activePanel) {
      this.activePanel = this.navigation().find((item) => item.enabled)?.panelId;
    }
    this.notify();
  }

  get runtimeLabel(): string {
    return this.gate?.runtimeLabel ?? "Runtime desconectado";
  }

  get currentPanel(): string | undefined {
    return this.activePanel;
  }

  get currentBottomTab(): BottomTab {
    return this.bottomTab;
  }

  /** Itens do rail, na ordem canônica dos painéis. */
  navigation(): NavigationItem[] {
    return Object.keys(PANEL_REQUIREMENTS).map((panelId) => {
      const answer = this.gate?.panel(panelId) ?? {
        enabled: false,
        reason: "Aguardando conexão com o middleware",
      };
      return {
        panelId,
        label: panelLabel(panelId),
        enabled: answer.enabled,
        ...(answer.enabled ? {} : { reason: answer.reason }),
        active: panelId === this.activePanel,
      };
    });
  }

  /** Ativa um painel. Painel desabilitado não ativa (retorna false). */
  activatePanel(panelId: string): boolean {
    const item = this.navigation().find((i) => i.panelId === panelId);
    if (!item?.enabled) return false;
    this.activePanel = panelId;
    this.notify();
    return true;
  }

  selectBottomTab(tab: BottomTab): void {
    this.bottomTab = tab;
    this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
