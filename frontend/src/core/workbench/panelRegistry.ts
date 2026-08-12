/**
 * Registro de painéis (E10): o rail do workbench virou DADO.
 *
 * Antes a lista de painéis era a ordem das chaves de `PANEL_REQUIREMENTS` e a
 * vista de cada um era um `if` no renderer — acrescentar um painel exigia
 * mexer em três arquivos e ninguém garantia que o rótulo existisse. Agora o
 * painel se declara, e o teste de paridade recusa painel sem requisito
 * governado (habilitaria fora da governança) e requisito sem painel (recurso
 * governado que nenhuma UI oferece).
 *
 * Módulo puro (regra F1).
 */

import { PANEL_REQUIREMENTS } from "../experienceGate.js";
import { panelLabel } from "../vocabulary.js";
import type { CapabilityRegistry } from "./capabilityRegistry.js";
import { ContributionRegistry, type Contribution } from "./contributions.js";

export interface PanelContribution extends Contribution {
  /**
   * Dica curta exibida quando o painel ainda não tem vista montável. Sem ela
   * o usuário clicava e via uma tela morta sem explicação.
   */
  readonly summary?: string;
}

/** Item do rail já resolvido: rótulo, habilitação, razão e foco. */
export interface NavigationItem {
  readonly panelId: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Razão de desabilitado (tooltip); ausente quando habilitado. */
  readonly reason?: string;
  readonly active: boolean;
}

export class PanelRegistry extends ContributionRegistry<PanelContribution> {
  constructor() {
    super("painel");
  }

  /**
   * Rail resolvido contra as capacidades correntes. `activeId` é só o foco: um
   * painel desabilitado nunca sai como ativo, mesmo que o chamador insista.
   */
  navigation(capabilities: CapabilityRegistry, activeId: string | undefined): NavigationItem[] {
    return this.all().map((panel) => {
      const answer = capabilities.resolve(panel);
      return {
        panelId: panel.id,
        label: panel.label,
        enabled: answer.enabled,
        ...(answer.enabled ? {} : { reason: answer.reason }),
        active: answer.enabled && panel.id === activeId,
      };
    });
  }

  /** Primeiro painel habilitado na ordem canônica — o alvo do foco automático. */
  firstEnabled(capabilities: CapabilityRegistry): string | undefined {
    return this.all().find((panel) => capabilities.resolve(panel).enabled)?.id;
  }
}

/**
 * Contribuições padrão do editor. Derivadas de `PANEL_REQUIREMENTS` de
 * propósito: o mapa de requisitos é a fonte da governança, e gerar os painéis
 * dele torna impossível contribuir um painel que a governança não conheça.
 * A ordem de declaração vira a ordem do rail.
 */
export function defaultPanels(): PanelContribution[] {
  const summaries: Readonly<Record<string, string>> = {
    "level-editor": "Pinte significado no IntGrid e derive a arte pelas regras.",
    "lighting-pipeline": "Luzes e pipeline diferido do runtime.",
    "shader-editor": "Edição de shaders HLSL do projeto.",
    "asset-compiler": "Compilação de assets pelo MGCB.",
    "embedded-preview": "O jogo rodando dentro do editor.",
    "debug-overlay": "Sobreposição de diagnóstico do runtime.",
  };
  return Object.entries(PANEL_REQUIREMENTS).map(([id, requires], index) => {
    const summary = summaries[id];
    return {
      id,
      label: panelLabel(id),
      requires,
      // todo painel de edição exige projeto: um editor sobre coisa nenhuma é
      // uma tela que aceita gesto e descarta o resultado
      requiresProject: true,
      order: index,
      ...(summary === undefined ? {} : { summary }),
    };
  });
}

/** Registro pré-carregado com as contribuições padrão. */
export function createPanelRegistry(): PanelRegistry {
  const registry = new PanelRegistry();
  registry.registerAll(defaultPanels());
  return registry;
}
