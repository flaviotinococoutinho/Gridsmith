/**
 * Governança da experiência por runtime (docs/CANONICAL-MODEL.md §3).
 *
 * Cruza três fontes para decidir cada recurso da ferramenta visual:
 *  1. o PERFIL estático (família+versão) — o que a combinação suporta em tese;
 *  2. o MANIFESTO VIVO (engine/describe) — o que a instância conectada expõe;
 *  3. as REGRAS do perfil — exigências e desabilitações explícitas.
 *
 * O resultado é uma matriz de decisões auto-explicativa: a UI habilita/
 * desabilita painéis e gizmos por ela, e agentes consultam a MESMA matriz
 * via MCP (`runtime_experience`) — a ferramenta nunca assume suporte.
 */

import type { CapabilityRegistry, EngineManifest } from "../domain/CapabilityRegistry.js";
import {
  RuntimeProfileRegistry,
  type RuntimeProfile,
} from "./RuntimeProfile.js";

export interface FeatureDecision {
  readonly feature: string;
  readonly enabled: boolean;
  /** O que determinou a decisão. */
  readonly source: "profile-rule" | "live-manifest";
  readonly reason: string;
}

export interface ResolvedExperience {
  readonly family: string;
  readonly requestedVersion: string;
  /** Versão do perfil efetivamente aplicado (match descendente). */
  readonly profileVersion: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly constraints: Readonly<Record<string, number>>;
  readonly decisions: readonly FeatureDecision[];
  /** true quando o manifesto vivo participou das decisões. */
  readonly liveManifestConsidered: boolean;
}

export class ExperienceGovernor {
  constructor(
    private readonly profiles: RuntimeProfileRegistry,
    private readonly liveCapabilities?: CapabilityRegistry,
  ) {}

  /**
   * Resolve a experiência para família+versão. Sem engine conectada, regras
   * com `requiresSubsystem` resolvem para DESABILITADO (fail-safe): a UI só
   * habilita o que está comprovadamente disponível.
   */
  resolve(family: string, version: string): ResolvedExperience {
    const profile = this.profiles.resolve(family, version);
    const manifest = this.liveCapabilities?.manifest;

    const decisions = profile.editorRules.map((rule) => this.decide(rule, profile, manifest));

    return {
      family,
      requestedVersion: version,
      profileVersion: profile.version,
      displayName: profile.displayName,
      capabilities: profile.capabilities,
      constraints: profile.constraints ?? {},
      decisions,
      liveManifestConsidered: manifest !== undefined,
    };
  }

  private decide(
    rule: RuntimeProfile["editorRules"][number],
    profile: RuntimeProfile,
    manifest: EngineManifest | undefined,
  ): FeatureDecision {
    if (rule.effect === "disable") {
      return {
        feature: rule.feature,
        enabled: false,
        source: "profile-rule",
        reason: rule.reason,
      };
    }

    if (rule.requiresCapability && !profile.capabilities.includes(rule.requiresCapability)) {
      return {
        feature: rule.feature,
        enabled: false,
        source: "profile-rule",
        reason: `capability "${rule.requiresCapability}" absent from ${profile.family}@${profile.version}`,
      };
    }

    if (rule.requiresSubsystem) {
      const subsystem = manifest?.subsystems[rule.requiresSubsystem];
      if (subsystem?.status !== "available") {
        return {
          feature: rule.feature,
          enabled: false,
          source: "live-manifest",
          reason: manifest
            ? `subsystem "${rule.requiresSubsystem}" is ${subsystem?.status ?? "absent"} in the connected engine`
            : `no engine connected to confirm subsystem "${rule.requiresSubsystem}" (fail-safe: disabled)`,
        };
      }
      return {
        feature: rule.feature,
        enabled: true,
        source: "live-manifest",
        reason: rule.reason,
      };
    }

    return {
      feature: rule.feature,
      enabled: true,
      source: "profile-rule",
      reason: rule.reason,
    };
  }
}
