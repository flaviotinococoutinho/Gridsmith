/**
 * Casca do workbench (E10): compõe os registros num objeto só.
 *
 * O `WorkbenchModel` continua sendo a porta que o renderer usa, mas deixou de
 * SABER quais painéis existem: ele pergunta aos registros. Trocar a lista
 * literal por contribuições é o que permite um painel novo (ou um comando, ou
 * uma seção de inspector) entrar sem tocar na casca — e é o que dá ao Ctrl+Z
 * um dono único e verificável.
 *
 * Módulo puro (regra F1).
 */

import type { ProjectState } from "../projectLifecycle.js";
import type { ResolvedExperienceLike } from "../experienceGate.js";
import { CapabilityRegistry } from "./capabilityRegistry.js";
import { CommandRegistry, type ResolvedCommand } from "./commandRegistry.js";
import { InspectorRegistry, type ResolvedSection } from "./inspectorRegistry.js";
import type { KeyStroke } from "./keybindings.js";
import { createPanelRegistry, type NavigationItem, type PanelRegistry } from "./panelRegistry.js";
import { SelectionService } from "./selectionService.js";
import { ToolRegistry, type ResolvedTool } from "./toolRegistry.js";
import { WorkbenchLayout } from "./workbenchLayout.js";

export type BottomTab = "problems" | "output" | "history";

/**
 * O que uma tecla significa AGORA. Resolver é síncrono e separado de executar
 * porque a casca precisa decidir o `preventDefault` antes de esperar o
 * handler — deixar a tecla vazar para o navegador enquanto o comando roda faz
 * o Ctrl+Z desfazer também no campo de texto por baixo.
 */
export type KeyOutcome =
  | { readonly kind: "command"; readonly commandId: string }
  | { readonly kind: "tool"; readonly toolId: string }
  | { readonly kind: "ignored" };

export class WorkbenchModel {
  readonly capabilities = new CapabilityRegistry();
  readonly panels: PanelRegistry = createPanelRegistry();
  readonly commands = new CommandRegistry();
  readonly tools = new ToolRegistry();
  readonly inspector = new InspectorRegistry();
  readonly selection = new SelectionService();
  readonly layout = new WorkbenchLayout();

  private activePanel: string | undefined;
  private bottomTab: BottomTab = "output";
  private readonly listeners = new Set<() => void>();
  /** Profundidade do agrupamento de notificações; ver `batch`. */
  private muted = 0;

  constructor() {
    // seleção e layout também redesenham a casca: sem isso o inspector só
    // atualizaria quando outra coisa notificasse por acaso
    this.selection.onChange(() => this.notify());
    this.layout.onChange(() => this.notify());
  }

  // ------------------------------------------------------------- resolução

  /** Recebida do gateway (`experience/resolve`); pode ser re-resolvida a qualquer momento. */
  applyExperience(experience: ResolvedExperienceLike): void {
    this.batch(() => {
      this.capabilities.applyExperience(experience);
      this.refocus();
    });
  }

  /** Estado do projeto observado; refoca ou desfoca no mesmo critério fail-safe. */
  applyProjectState(state: ProjectState): void {
    if (state === this.capabilities.currentProjectState) return;
    this.batch(() => {
      this.capabilities.applyProjectState(state);
      this.refocus();
    });
  }

  get currentProjectState(): ProjectState {
    return this.capabilities.currentProjectState;
  }

  get runtimeLabel(): string {
    return this.capabilities.runtimeLabel;
  }

  // ------------------------------------------------------------- navegação

  get currentPanel(): string | undefined {
    return this.activePanel;
  }

  navigation(): NavigationItem[] {
    return this.panels.navigation(this.capabilities, this.activePanel);
  }

  /** Ativa um painel. Painel desabilitado não ativa (retorna false). */
  activatePanel(panelId: string): boolean {
    const panel = this.panels.get(panelId);
    if (!panel || !this.capabilities.resolve(panel).enabled) return false;
    if (this.activePanel === panelId) return true;
    this.batch(() => {
      this.activePanel = panelId;
      // a seleção pertence ao painel que a criou: mantê-la ao trocar mostraria
      // no inspector um objeto que a vista corrente não sabe desenhar
      this.selection.clear();
    });
    return true;
  }

  /** Painel ativo perdeu a habilitação → perde o foco; sem foco → primeiro habilitado. */
  private refocus(): void {
    if (this.activePanel) {
      const panel = this.panels.get(this.activePanel);
      if (!panel || !this.capabilities.resolve(panel).enabled) {
        this.activePanel = undefined;
        this.selection.clear();
      }
    }
    this.activePanel ??= this.panels.firstEnabled(this.capabilities);
  }

  // ------------------------------------------------------- painel inferior

  get currentBottomTab(): BottomTab {
    return this.bottomTab;
  }

  selectBottomTab(tab: BottomTab): void {
    this.bottomTab = tab;
    this.notify();
  }

  // -------------------------------------------------- comandos e teclado

  resolveCommand(commandId: string): ResolvedCommand | undefined {
    return this.commands.resolve(commandId, this.capabilities);
  }

  resolveCommands(): ResolvedCommand[] {
    return this.commands.resolveAll(this.capabilities);
  }

  async executeCommand(commandId: string): Promise<void> {
    await this.commands.execute(commandId, this.capabilities);
  }

  /**
   * Traduz uma tecla em intenção. Comandos globais têm precedência sobre as
   * ferramentas do painel: um atalho global que dependesse do painel ativo
   * seria imprevisível para o usuário.
   */
  resolveKeyStroke(stroke: KeyStroke): KeyOutcome {
    const command = this.commands.commandForStroke(stroke);
    if (command) return { kind: "command", commandId: command.id };
    if (this.activePanel) {
      const tool = this.tools.toolForStroke(this.activePanel, stroke, this.capabilities);
      if (tool) return { kind: "tool", toolId: tool.id };
    }
    return { kind: "ignored" };
  }

  /**
   * Comandos que agem só sobre o estado da casca. Vivem aqui, e não no
   * renderer, porque são puros — e por isso testáveis sem DOM. Nenhum deles
   * exige governança ou projeto: são as ações que reorganizam a janela, e
   * prendê-las à conexão deixaria o usuário sem saída enquanto o middleware
   * não sobe.
   */
  registerViewCommands(): void {
    this.commands.register({
      id: "view.toggleInspector",
      label: "Mostrar/ocultar o inspector",
      category: "Ver",
      requires: [],
      requiresProject: false,
      order: 10,
      keybindings: ["Ctrl+Alt+I"],
      run: () => this.layout.toggle("inspector"),
    });
    this.commands.register({
      id: "view.toggleBottomPanel",
      label: "Mostrar/ocultar o painel inferior",
      category: "Ver",
      requires: [],
      requiresProject: false,
      order: 11,
      keybindings: ["Ctrl+J"],
      run: () => this.layout.toggle("bottom"),
    });
    this.commands.register({
      id: "view.resetLayout",
      label: "Restaurar o layout padrão",
      category: "Ver",
      requires: [],
      requiresProject: false,
      order: 12,
      run: () => this.layout.reset(),
    });
    this.commands.register({
      id: "selection.clear",
      label: "Limpar a seleção",
      category: "Seleção",
      requires: [],
      requiresProject: false,
      order: 13,
      keybindings: ["Escape"],
      run: () => this.selection.clear(),
    });
  }

  // ----------------------------------------------- ferramentas e inspector

  /** Ferramentas do painel ativo, resolvidas; vazio sem painel. */
  activeTools(): ResolvedTool[] {
    return this.activePanel ? this.tools.resolveAll(this.activePanel, this.capabilities) : [];
  }

  activateTool(toolId: string): boolean {
    if (!this.activePanel) return false;
    if (!this.tools.activate(this.activePanel, toolId, this.capabilities)) return false;
    this.notify();
    return true;
  }

  activeToolId(): string | undefined {
    return this.activePanel
      ? this.tools.activeTool(this.activePanel, this.capabilities)?.id
      : undefined;
  }

  inspectorSections(): ResolvedSection[] {
    return this.inspector.sectionsFor(this.selection.current, this.capabilities);
  }

  // ----------------------------------------------------------- observação

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Agrupa mudanças numa notificação só.
   *
   * Trocar de painel mexe em duas coisas (foco e seleção) e cada uma notifica;
   * sem o agrupamento a casca redesenharia no meio da operação, remontando a
   * vista com o painel novo e a seleção velha.
   */
  private batch(mutate: () => void): void {
    this.muted += 1;
    try {
      mutate();
    } finally {
      this.muted -= 1;
    }
    this.notify();
  }

  private notify(): void {
    if (this.muted > 0) return;
    for (const listener of this.listeners) listener();
  }
}
