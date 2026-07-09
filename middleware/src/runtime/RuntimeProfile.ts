/**
 * Perfis versionados de runtime (docs/CANONICAL-MODEL.md §3).
 *
 * A FAMÍLIA define o grupo tecnológico ("monogame"); a VERSÃO define o perfil
 * concreto de compatibilidade; capabilities e editorRules determinam quais
 * recursos da ferramenta visual existem para aquela combinação. Perfis são
 * dados declarativos versionados no repositório (runtime/profiles/) e seguem
 * o contrato contracts/schemas/runtime.profile.schema.json.
 */

export interface EditorRule {
  /** Recurso da ferramenta visual (ex.: "assets.mgcb-compile"). */
  readonly feature: string;
  readonly effect: "enable" | "disable";
  /** Exigência de capability do perfil (para effect "enable"). */
  readonly requiresCapability?: string;
  /** Exigência de subsistema "available" no manifesto vivo da engine. */
  readonly requiresSubsystem?: string;
  /** Justificativa exibida na UI e nas respostas MCP. */
  readonly reason: string;
}

export interface RuntimeProfile {
  readonly family: string;
  /** Versão semântica "MAJOR.MINOR[.PATCH]". */
  readonly version: string;
  readonly displayName: string;
  /** Capacidades tecnológicas da combinação família+versão. */
  readonly capabilities: readonly string[];
  readonly editorRules: readonly EditorRule[];
  readonly constraints?: Readonly<Record<string, number>>;
}

export class UnknownRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownRuntimeError";
  }
}

/** Compara versões "a.b.c" numericamente (componentes ausentes = 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export class RuntimeProfileRegistry {
  private readonly profiles = new Map<string, RuntimeProfile[]>();

  register(profile: RuntimeProfile): void {
    if (!profile.family || !/^\d+\.\d+(\.\d+)?$/.test(profile.version)) {
      throw new Error(`Profile requires a family and a semantic version (got "${profile.version}")`);
    }
    const list = this.profiles.get(profile.family) ?? [];
    if (list.some((p) => p.version === profile.version)) {
      throw new Error(
        `Profile ${profile.family}@${profile.version} is already registered — published profiles are immutable; register a new version instead`,
      );
    }
    list.push(profile);
    list.sort((a, b) => compareVersions(a.version, b.version));
    this.profiles.set(profile.family, list);
  }

  families(): readonly string[] {
    return [...this.profiles.keys()];
  }

  versionsOf(family: string): readonly string[] {
    return (this.profiles.get(family) ?? []).map((p) => p.version);
  }

  /**
   * Resolve o perfil para família+versão: match exato, senão o perfil mais
   * alto ≤ versão pedida (compatibilidade descendente), senão erro tipado.
   */
  resolve(family: string, version: string): RuntimeProfile {
    const list = this.profiles.get(family);
    if (!list || list.length === 0) {
      throw new UnknownRuntimeError(
        `No profiles registered for runtime family "${family}" (known: ${this.families().join(", ") || "none"})`,
      );
    }

    let best: RuntimeProfile | undefined;
    for (const profile of list) {
      if (compareVersions(profile.version, version) <= 0) {
        best = profile; // lista ordenada: o último ≤ pedido é o maior
      }
    }

    if (!best) {
      throw new UnknownRuntimeError(
        `Runtime ${family}@${version} predates the oldest known profile (${list[0]!.version})`,
      );
    }
    return best;
  }
}
