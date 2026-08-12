/**
 * Registro do inspector (E10): seções contribuídas por tipo de seleção.
 *
 * O inspector nunca existiu no editor — a frente F4 inteira estava vazia. Ele
 * entra como registro em vez de painel monolítico porque cada domínio
 * (entidade, nível, luz) precisa acrescentar as próprias seções sem tocar na
 * casca, e porque cada seção responde à MESMA governança dos painéis: um
 * campo que edita um recurso desabilitado não pode aparecer editável.
 *
 * Módulo puro (regra F1).
 */

import type { CapabilityRegistry } from "./capabilityRegistry.js";
import { ContributionRegistry, type Contribution } from "./contributions.js";
import type { Selection, SelectionKind } from "./selectionService.js";

export interface InspectorSection extends Contribution {
  /** Tipos de seleção que a seção sabe representar. */
  readonly appliesTo: readonly SelectionKind[];
  /**
   * A seção suporta seleção múltipla. Quem não suporta some quando há mais de
   * um item — melhor ausente do que mostrando os valores do primeiro como se
   * fossem os de todos.
   */
  readonly multiple: boolean;
}

export interface ResolvedSection {
  readonly section: InspectorSection;
  readonly enabled: boolean;
  /** Razão de somente-leitura; ausente quando editável. */
  readonly reason?: string;
}

export class InspectorRegistry extends ContributionRegistry<InspectorSection> {
  constructor() {
    super("seção de inspector");
  }

  /**
   * Seções aplicáveis a uma seleção, em ordem, já resolvidas.
   *
   * Seção governada como desabilitada continua VISÍVEL, em somente-leitura com
   * a razão: esconder o campo faria o usuário achar que o objeto não tem
   * aquela propriedade, quando o que existe é uma decisão de perfil.
   */
  sectionsFor(
    selection: Selection | undefined,
    capabilities: CapabilityRegistry,
  ): ResolvedSection[] {
    if (!selection) return [];
    return this.all()
      .filter((section) => section.appliesTo.includes(selection.kind))
      .filter((section) => section.multiple || selection.ids.length === 1)
      .map((section) => {
        const answer = capabilities.resolve(section);
        return {
          section,
          enabled: answer.enabled,
          ...(answer.enabled ? {} : { reason: answer.reason }),
        };
      });
  }
}
