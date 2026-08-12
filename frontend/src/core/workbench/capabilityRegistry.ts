/**
 * Registro de capacidades (E10): o ÚNICO lugar que responde "isto está
 * habilitado, e por quê?".
 *
 * Antes cada consumidor compunha os dois eixos por conta própria — o rail
 * fazia isso dentro do `WorkbenchModel`, a vista de níveis chamava
 * `gate.feature()` direto, e nada mais consultava nada. Com painel, comando,
 * ferramenta e inspector todos governados, repetir a composição em quatro
 * lugares garantiria que um deles divergisse.
 *
 * Módulo puro (regra F1).
 */

import { ExperienceGate, type ResolvedExperienceLike } from "../experienceGate.js";
import type { ProjectState } from "../projectLifecycle.js";
import type { CapabilityAnswer, Requirement } from "./contributions.js";

/** Razão do eixo de sessão. Preservada palavra por palavra desde o P0.3. */
export const NO_PROJECT_REASON = "Crie ou abra um projeto para usar este painel.";

/** Razão de antes da primeira resolução: a governança ainda não falou. */
export const AWAITING_REASON = "Aguardando conexão com o middleware";

export class CapabilityRegistry {
  private gate: ExperienceGate | undefined;
  /**
   * Default fail-safe: sem informação de projeto, nada que edite habilita.
   * Nascer em "aberto" faria a UI oferecer edição sobre coisa nenhuma durante
   * a janela entre o boot e o primeiro status.
   */
  private projectState: ProjectState = "no-project";

  applyExperience(experience: ResolvedExperienceLike): void {
    this.gate = new ExperienceGate(experience);
  }

  applyProjectState(state: ProjectState): void {
    this.projectState = state;
  }

  get currentProjectState(): ProjectState {
    return this.projectState;
  }

  get hasProject(): boolean {
    return this.projectState !== "no-project";
  }

  get runtimeLabel(): string {
    return this.gate?.runtimeLabel ?? "Runtime desconectado";
  }

  /** Limites numéricos do perfil (ex.: tamanho máximo de nível); vazio offline. */
  get constraints(): Readonly<Record<string, number>> {
    return this.gate?.constraints ?? {};
  }

  /** Recurso governado isolado — para quem não é contribuição (ex.: uma tool interna). */
  feature(feature: string): CapabilityAnswer {
    if (!this.gate) return { enabled: false, reason: AWAITING_REASON, origin: "fail-safe" };
    const answer = this.gate.feature(feature);
    return answer.enabled
      ? { enabled: true, reason: answer.reason, origin: "governance" }
      : { enabled: false, reason: answer.reason, origin: "governance" };
  }

  /**
   * Resolve os dois eixos de um requisito.
   *
   * PRECEDÊNCIA: a governança fala primeiro. Um recurso negado pelo perfil ou
   * pelo manifesto vivo mantém ESSA razão mesmo sem projeto aberto — trocá-la
   * por "abra um projeto" esconderia do usuário o motivo real, e ele abriria
   * um projeto para descobrir que continua desabilitado.
   */
  resolve(requirement: Requirement): CapabilityAnswer {
    // Contribuição que não pede NADA à governança nem à sessão habilita mesmo
    // offline: são as ações da própria casca (esconder o inspector, redefinir
    // o layout). Deixá-las esperando o middleware prenderia o usuário numa
    // janela que ele não consegue nem reorganizar enquanto a conexão não vem.
    if (requirement.requires.length === 0 && !requirement.requiresProject) {
      return { enabled: true, reason: "ação da própria interface", origin: "fail-safe" };
    }
    if (!this.gate) return { enabled: false, reason: AWAITING_REASON, origin: "fail-safe" };
    for (const feature of requirement.requires) {
      const answer = this.gate.feature(feature);
      if (!answer.enabled) {
        return { enabled: false, reason: answer.reason, origin: "governance" };
      }
    }
    if (requirement.requiresProject && !this.hasProject) {
      return { enabled: false, reason: NO_PROJECT_REASON, origin: "session" };
    }
    return {
      enabled: true,
      reason: `requisitos satisfeitos por ${this.runtimeLabel}`,
      origin: "governance",
    };
  }
}
