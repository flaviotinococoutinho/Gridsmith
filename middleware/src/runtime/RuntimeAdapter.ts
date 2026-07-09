/**
 * Contrato dos adapters de runtime (docs/CANONICAL-MODEL.md §2).
 *
 * O modelo canônico não conhece runtimes: adapters projetam eventos do
 * Blueprint nas APIs concretas de cada runtime. Um evento que o runtime não
 * suporta é PULADO COM RAZÃO, nunca um erro silencioso — a governança usa
 * essas razões para explicar a experiência.
 */

import type { BlueprintEvent } from "../domain/BlueprintStore.js";

export interface RuntimeIdentity {
  /** Grupo tecnológico ("monogame", ...). */
  readonly family: string;
  /** Versão concreta reportada pelo runtime vivo. */
  readonly version: string;
  readonly displayName?: string;
}

export interface ProjectionResult {
  readonly event: BlueprintEvent["kind"];
  readonly status: "projected" | "skipped" | "deferred";
  /** Obrigatória quando skipped/deferred. */
  readonly reason?: string;
}

export interface RuntimeAdapter {
  readonly family: string;

  /** true quando há uma instância do runtime conectada e apta a receber projeções. */
  readonly isConnected: boolean;

  /** Identidade do runtime vivo (família + versão) — alimenta a resolução de perfil. */
  identify(): RuntimeIdentity | undefined;

  /** Projeta um evento canônico no runtime. */
  project(event: BlueprintEvent): Promise<ProjectionResult>;
}
