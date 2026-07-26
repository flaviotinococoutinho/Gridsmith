/**
 * View-model do workbench (ALPHA-0.1 P0.3): o estado de navegação da UI —
 * qual painel está ativo, quais itens o rail mostra (com rótulo humano,
 * habilitação e razão traduzível), e qual aba do painel inferior está aberta.
 * Puro e testável; o renderer só materializa.
 */

import { ExperienceGate, PANEL_REQUIREMENTS, type ResolvedExperienceLike } from "./experienceGate.js";
import type { ProjectState } from "./projectLifecycle.js";
import { panelLabel } from "./vocabulary.js";

/** Razão do segundo eixo: painel de edição exige projeto aberto. */
const NO_PROJECT_REASON = "Crie ou abra um projeto para usar este painel.";

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
  /**
   * Segundo eixo de habilitação, composto AQUI e não dentro do
   * ExperienceGate: "há projeto aberto?" é fato de SESSÃO, não capacidade de
   * runtime. Enfiá-lo no gate quebraria a origem da razão (`profile-rule` /
   * `live-manifest`), que a UI promete nunca genericizar.
   *
   * Default fail-safe: sem informação de projeto, nenhum painel de edição.
   */
  private projectState: ProjectState = "no-project";
  private activePanel: string | undefined;
  private bottomTab: BottomTab = "output";
  private readonly listeners = new Set<() => void>();

  /** Recebida do gateway (experience/resolve); pode ser re-resolvida a qualquer momento. */
  applyExperience(experience: ResolvedExperienceLike): void {
    this.gate = new ExperienceGate(experience);
    // painel ativo que ficou desabilitado perde o foco (fail-safe)
    if (this.activePanel && !this.isEnabled(this.activePanel)) {
      this.activePanel = undefined;
    }
    // sem painel ativo: foca o primeiro habilitado
    if (!this.activePanel) {
      this.activePanel = this.navigation().find((item) => item.enabled)?.panelId;
    }
    this.notify();
  }

  /** Estado do projeto observado; refoca ou desfoca no mesmo critério fail-safe. */
  applyProjectState(state: ProjectState): void {
    if (state === this.projectState) return;
    this.projectState = state;
    if (this.activePanel && !this.isEnabled(this.activePanel)) {
      this.activePanel = undefined;
    }
    if (!this.activePanel) {
      this.activePanel = this.navigation().find((item) => item.enabled)?.panelId;
    }
    this.notify();
  }

  get currentProjectState(): ProjectState {
    return this.projectState;
  }

  private isEnabled(panelId: string): boolean {
    return this.navigation().find((item) => item.panelId === panelId)?.enabled === true;
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
    const hasProject = this.projectState !== "no-project";
    return Object.keys(PANEL_REQUIREMENTS).map((panelId) => {
      const answer = this.gate?.panel(panelId) ?? {
        enabled: false,
        reason: "Aguardando conexão com o middleware",
      };
      // PRECEDÊNCIA: a governança fala primeiro. Um painel negado pelo perfil
      // ou pelo manifesto vivo mantém ESSA razão mesmo sem projeto — trocá-la
      // por "abra um projeto" esconderia o motivo real do usuário.
      const enabled = answer.enabled && hasProject;
      const reason = !answer.enabled ? answer.reason : NO_PROJECT_REASON;
      return {
        panelId,
        label: panelLabel(panelId),
        enabled,
        ...(enabled ? {} : { reason }),
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
