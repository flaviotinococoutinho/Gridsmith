/**
 * Gate de experiência do editor: consome a matriz de decisões da governança
 * (`experience/resolve` do gateway) e responde, para cada recurso da UI, se
 * ele está habilitado e POR QUÊ — o tooltip de um painel desabilitado mostra
 * a razão vinda do perfil/manifesto, nunca um genérico "indisponível".
 *
 * A UI NUNCA consulta capacidades diretamente: todo gating passa por aqui.
 * A associação capability→contribuição pertence aos registries; este módulo
 * não conhece painéis ou ferramentas concretos.
 */

import { featureLabel } from "./vocabulary.js";

export interface FeatureDecision {
  readonly feature: string;
  readonly enabled: boolean;
  readonly source: "profile-rule" | "live-manifest";
  readonly reason: string;
}

export interface ResolvedExperienceLike {
  readonly family: string;
  readonly profileVersion: string;
  readonly displayName: string;
  readonly decisions: readonly FeatureDecision[];
  readonly constraints: Readonly<Record<string, number>>;
}

export interface GateAnswer {
  readonly enabled: boolean;
  readonly reason: string;
}

export class ExperienceGate {
  private readonly decisions = new Map<string, FeatureDecision>();
  readonly runtimeLabel: string;
  readonly constraints: Readonly<Record<string, number>>;

  constructor(experience: ResolvedExperienceLike) {
    for (const decision of experience.decisions) {
      this.decisions.set(decision.feature, decision);
    }
    this.runtimeLabel = `${experience.displayName} (perfil ${experience.profileVersion})`;
    this.constraints = experience.constraints;
  }

  /**
   * Recurso individual. Recursos SEM decisão explícita são desabilitados
   * (fail-safe): só existe o que a governança conhece.
   */
  feature(feature: string): GateAnswer {
    const decision = this.decisions.get(feature);
    if (!decision) {
      return {
        enabled: false,
        reason: `${featureLabel(feature)} não está disponível no perfil ${this.runtimeLabel}.`,
      };
    }
    return { enabled: decision.enabled, reason: localizeCapabilityReason(decision.reason) };
  }

}

/** Traduz os diagnósticos estruturais ainda emitidos em inglês pelo governor. */
export function localizeCapabilityReason(reason: string): string {
  const missingCapability = /^capability "([^"]+)" absent from (.+)$/u.exec(reason);
  if (missingCapability) {
    return `A capacidade “${featureLabel(missingCapability[1]!)}” não existe em ${missingCapability[2]}.`;
  }
  const subsystem = /^subsystem "([^"]+)" is ([^ ]+) in the connected engine$/u.exec(reason);
  if (subsystem) {
    const translations: Readonly<Record<string, string>> = {
      absent: "ausente",
      unavailable: "indisponível",
      degraded: "degradado",
    };
    return `O subsistema “${subsystem[1]}” está ${translations[subsystem[2]!] ?? subsystem[2]} na engine conectada.`;
  }
  const noEngine = /^no engine connected to confirm subsystem "([^"]+)" \(fail-safe: disabled\)$/u.exec(reason);
  if (noEngine) {
    return `Nenhuma engine está conectada para confirmar o subsistema “${noEngine[1]}”; recurso desabilitado por segurança.`;
  }
  return reason;
}
