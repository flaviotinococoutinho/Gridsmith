/**
 * Contrato mínimo de capabilities consumido pelas contribuições da interface.
 *
 * O resolver é deliberadamente uma função: a shell pode adaptá-lo de um
 * ExperienceGate, de testes ou de outro provedor sem os registries conhecerem
 * perfis, transports ou Electron.
 */

export interface CapabilityDecision {
  readonly enabled: boolean;
  /** Razão humana e traduzida fornecida pela camada de governança. */
  readonly reason: string;
}

export type CapabilityResolver = (capability: string) => CapabilityDecision;

/** Capability efêmera que bloqueia gestos enquanto o projeto é substituído. */
export const PROJECT_STABLE_CAPABILITY = "editor.project.stable";

export interface ContributionAvailability {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly missingCapabilities: readonly string[];
}

export const ALL_CAPABILITIES: CapabilityResolver = (capability) => ({
  enabled: true,
  reason: `Capability disponível: ${capability}`,
});

export function denyUnknownCapabilities(
  decisions: Readonly<Record<string, CapabilityDecision>>,
): CapabilityResolver {
  return (capability) => decisions[capability] ?? {
    enabled: false,
    reason: `O recurso “${capability}” não está disponível neste perfil.`,
  };
}

/** Todas as capacidades são obrigatórias; ausência é fail-safe. */
export function evaluateCapabilities(
  requiredCapabilities: readonly string[],
  resolve: CapabilityResolver,
): ContributionAvailability {
  const failures = requiredCapabilities
    .map((capability) => ({ capability, decision: resolve(capability) }))
    .filter(({ decision }) => !decision.enabled);

  if (failures.length === 0) {
    return { visible: true, enabled: true, missingCapabilities: [] };
  }

  return {
    visible: true,
    enabled: false,
    reason: failures.map(({ decision }) => decision.reason).join(" · "),
    missingCapabilities: failures.map(({ capability }) => capability),
  };
}

export class ContributionUnavailableError extends Error {
  readonly contributionId: string;
  readonly missingCapabilities: readonly string[];

  constructor(
    contributionId: string,
    reason: string,
    missingCapabilities: readonly string[] = [],
  ) {
    super(reason);
    this.name = "ContributionUnavailableError";
    this.contributionId = contributionId;
    this.missingCapabilities = [...missingCapabilities];
  }
}
