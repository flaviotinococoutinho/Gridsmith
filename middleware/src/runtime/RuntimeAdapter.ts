/**
 * Contrato dos adapters de runtime (docs/CANONICAL-MODEL.md §2).
 *
 * O modelo canônico não conhece runtimes: adapters projetam eventos do
 * Blueprint nas APIs concretas de cada runtime. Um evento que o runtime não
 * suporta é PULADO COM RAZÃO, nunca um erro silencioso — a governança usa
 * essas razões para explicar a experiência.
 */

import type { BlueprintEvent, BlueprintStore } from "../domain/BlueprintStore.js";

/**
 * Geração monotônica da engine que recebe projeções. O valor muda em toda
 * troca efetiva (connect, supersession ou disconnect), portanto também
 * identifica de forma inequívoca o estado "sem engine" entre duas conexões.
 */
export type RuntimeSessionEpoch = number;

export interface RuntimeIdentity {
  /** Grupo tecnológico ("monogame", ...). */
  readonly family: string;
  /** Versão concreta reportada pelo runtime vivo. */
  readonly version: string;
  readonly displayName?: string;
}

export type ProjectionResult =
  | {
      readonly event: BlueprintEvent["kind"];
      readonly status: "projected";
      /** Resposta do runtime à projeção — diagnóstico/UI. */
      readonly detail?: unknown;
      readonly reason?: never;
    }
  | {
      readonly event: BlueprintEvent["kind"];
      readonly status: "skipped";
      /** Explica por que o evento não pertence à superfície deste runtime. */
      readonly reason: string;
      readonly detail?: never;
    }
  | {
      readonly event: BlueprintEvent["kind"];
      readonly status: "deferred";
      /** Explica a condição temporária que impede a projeção. */
      readonly reason: string;
      readonly detail?: never;
    };

export type RuntimeSessionResetResult =
  | {
      readonly status: "reset";
      /** Epoch que foi efetivamente resetado; deve ser reutilizado no replay. */
      readonly runtimeSessionEpoch: RuntimeSessionEpoch;
      readonly detail?: unknown;
      readonly reason?: never;
    }
  | {
      readonly status: "deferred";
      /** Epoch desconectado observado pelo reset; protege contra reconnect no meio do replay. */
      readonly runtimeSessionEpoch: RuntimeSessionEpoch;
      readonly reason: string;
      readonly detail?: never;
    };

export interface RuntimeAdapter {
  readonly family: string;

  /** true quando há uma instância do runtime conectada e apta a receber projeções. */
  readonly isConnected: boolean;

  /** Identidade do runtime vivo (família + versão) — alimenta a resolução de perfil. */
  identify(): RuntimeIdentity | undefined;

  /** Projeta um evento canônico no runtime. */
  project(
    event: BlueprintEvent,
    expectedRuntimeSessionEpoch?: RuntimeSessionEpoch,
    /** Snapshot canônico já confirmado, para eventos incrementais sem payload completo. */
    canonicalStore?: BlueprintStore,
  ): Promise<ProjectionResult>;

  /**
   * Remove todo estado pertencente ao projeto anterior. Sem runtime conectado,
   * o reset é adiado explicitamente; nunca é tratado como sucesso silencioso.
   */
  resetSession(): Promise<RuntimeSessionResetResult>;

  /**
   * Reprojeta o snapshot canônico completo na ordem de dependência. Quando um
   * epoch é informado, nenhum evento pode ser enviado para outra engine.
   */
  rehydrateFrom(
    store: BlueprintStore,
    expectedRuntimeSessionEpoch?: RuntimeSessionEpoch,
  ): Promise<readonly ProjectionResult[]>;
}

/** Erro recuperável: a engine alvo deixou de ser corrente durante uma projeção. */
export class RuntimeSessionSupersededError extends Error {
  constructor(
    readonly expectedRuntimeSessionEpoch: RuntimeSessionEpoch,
    readonly actualRuntimeSessionEpoch: RuntimeSessionEpoch,
  ) {
    super(
      `Runtime session changed during projection ` +
        `(expected epoch ${expectedRuntimeSessionEpoch}, got ${actualRuntimeSessionEpoch})`,
    );
    this.name = "RuntimeSessionSupersededError";
  }
}
