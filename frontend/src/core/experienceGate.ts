/**
 * Gate de experiência do editor: consome a matriz de decisões da governança
 * (`experience/resolve` do gateway) e responde, para cada recurso da UI, se
 * ele está habilitado e POR QUÊ — o tooltip de um painel desabilitado mostra
 * a razão vinda do perfil/manifesto, nunca um genérico "indisponível".
 *
 * A UI NUNCA consulta capacidades diretamente: todo gating passa por aqui.
 */

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

/** Painéis da UI e os recursos governados que eles exigem. */
export const PANEL_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  "level-editor": ["level.intgrid-editor"],
  "lighting-pipeline": ["lighting.deferred-pipeline"],
  "shader-editor": ["shaders.hlsl-editing"],
  "asset-compiler": ["assets.mgcb-compile"],
  "embedded-preview": ["preview.embedded"],
  "debug-overlay": ["debug.overlay"],
};

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
        reason: `feature "${feature}" is not governed by the ${this.runtimeLabel} profile (fail-safe: disabled)`,
      };
    }
    return { enabled: decision.enabled, reason: decision.reason };
  }

  /** Painel: habilitado sse TODOS os recursos exigidos estão habilitados. */
  panel(panelId: string): GateAnswer {
    const requirements = PANEL_REQUIREMENTS[panelId];
    if (!requirements) {
      return { enabled: false, reason: `unknown panel "${panelId}"` };
    }
    for (const feature of requirements) {
      const answer = this.feature(feature);
      if (!answer.enabled) {
        return { enabled: false, reason: answer.reason };
      }
    }
    return { enabled: true, reason: `all requirements satisfied by ${this.runtimeLabel}` };
  }

  /** Mapa completo painel → decisão, pronto para renderizar a shell da UI. */
  allPanels(): Readonly<Record<string, GateAnswer>> {
    return Object.fromEntries(
      Object.keys(PANEL_REQUIREMENTS).map((panelId) => [panelId, this.panel(panelId)]),
    );
  }
}
