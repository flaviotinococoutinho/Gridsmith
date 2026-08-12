/**
 * Registro de ferramentas (E10): a barra de ferramentas de cada painel.
 *
 * A vista de níveis criava os botões à mão e guardava a ferramenta ativa numa
 * variável do closure — a governança de `entities.spawn` era aplicada uma vez,
 * na montagem, e nunca mais: se o perfil mudasse com o painel aberto, o botão
 * continuava clicável. Aqui a habilitação é RESOLVIDA a cada leitura.
 *
 * Módulo puro (regra F1).
 */

import type { CapabilityRegistry } from "./capabilityRegistry.js";
import { ContributionRegistry, type Contribution } from "./contributions.js";
import {
  chordFromStroke,
  chordKey,
  formatChord,
  parseChord,
  type KeyStroke,
} from "./keybindings.js";

export interface ToolContribution extends Contribution {
  /** Painel dono da ferramenta; ferramenta não existe fora de um painel. */
  readonly panelId: string;
  /** Dica exibida no tooltip, antes da razão de governança. */
  readonly hint?: string;
  /**
   * Acorde de seleção da ferramenta. Fica FORA do registro de comandos de
   * propósito: é modal ao painel ativo, e reivindicar a tecla globalmente
   * tiraria o "1" de qualquer outro painel.
   */
  readonly keybinding?: string;
}

export interface ResolvedTool {
  readonly tool: ToolContribution;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly active: boolean;
  readonly shortcut?: string;
}

export class ToolRegistry extends ContributionRegistry<ToolContribution> {
  /** painel → ferramenta ativa. Cada painel lembra a sua. */
  private readonly active = new Map<string, string>();

  constructor() {
    super("ferramenta");
  }

  toolsOf(panelId: string): readonly ToolContribution[] {
    return this.all().filter((tool) => tool.panelId === panelId);
  }

  /**
   * Ferramenta ativa do painel. Se a ativa ficou desabilitada (o perfil mudou,
   * a engine caiu), cai para a primeira habilitada em vez de continuar
   * apontando para uma ferramenta que o próximo clique recusaria.
   */
  activeTool(panelId: string, capabilities: CapabilityRegistry): ToolContribution | undefined {
    const enabled = this.toolsOf(panelId).filter((tool) => capabilities.resolve(tool).enabled);
    const currentId = this.active.get(panelId);
    return enabled.find((tool) => tool.id === currentId) ?? enabled[0];
  }

  /** Ativa uma ferramenta. Desabilitada ou de outro painel é recusada. */
  activate(panelId: string, toolId: string, capabilities: CapabilityRegistry): boolean {
    const tool = this.get(toolId);
    if (!tool || tool.panelId !== panelId) return false;
    if (!capabilities.resolve(tool).enabled) return false;
    this.active.set(panelId, toolId);
    return true;
  }

  /**
   * Ferramenta do painel disparada por uma tecla, já filtrada por habilitação.
   * Compara o ACORDE inteiro: comparar só a tecla faria um "1" simples ativar
   * uma ferramenta ligada a Ctrl+1.
   */
  toolForStroke(
    panelId: string,
    stroke: KeyStroke,
    capabilities: CapabilityRegistry,
  ): ToolContribution | undefined {
    const pressed = chordKey(chordFromStroke(stroke));
    return this.toolsOf(panelId).find((tool) => {
      if (tool.keybinding === undefined) return false;
      if (chordKey(parseChord(tool.keybinding)) !== pressed) return false;
      return capabilities.resolve(tool).enabled;
    });
  }

  resolveAll(panelId: string, capabilities: CapabilityRegistry): ResolvedTool[] {
    const activeId = this.activeTool(panelId, capabilities)?.id;
    return this.toolsOf(panelId).map((tool) => {
      const answer = capabilities.resolve(tool);
      return {
        tool,
        enabled: answer.enabled,
        ...(answer.enabled ? {} : { reason: answer.reason }),
        active: tool.id === activeId,
        ...(tool.keybinding === undefined
          ? {}
          : { shortcut: formatChord(parseChord(tool.keybinding)) }),
      };
    });
  }
}
