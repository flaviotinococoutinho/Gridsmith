/**
 * Política de roteamento entre os transports do app (ADR-017):
 * gRPC PRIORITÁRIO; em falha DE TRANSPORTE, fallback IMEDIATO para GraphQL;
 * recovery por sondas com backoff e HISTERESE (N sondas boas consecutivas
 * antes de repromover) para não flapar entre transports.
 *
 * Núcleo PURO (regra F1): sem sockets, sem timers — o dono (EditorClient no
 * processo main) executa as chamadas e injeta o relógio; este módulo decide.
 *
 *   grpc ──falha de transporte──▶ graphql ──sondas ok (histerese)──▶ grpc
 *
 * Falha de DOMÍNIO (comando inválido etc.) NUNCA muda de transporte — o erro
 * pertence ao chamador; fallback é para indisponibilidade, não para bugs.
 */

export type TransportName = "grpc" | "graphql";

export type RouterMode = "primary" | "fallback";

export interface TransportRouterOptions {
  /** Falhas de transporte consecutivas no gRPC antes do fallback (default 1 — "caso dê problema, use GraphQL"). */
  readonly failureThreshold?: number;
  /** Escada de backoff (ms) entre sondas de recovery. Última entrada repete. */
  readonly recoveryBackoffMs?: readonly number[];
  /** Sondas boas CONSECUTIVAS para repromover ao gRPC (histerese; default 2). */
  readonly promoteAfterProbes?: number;
}

export interface RouterTransition {
  readonly from: RouterMode;
  readonly to: RouterMode;
  readonly reason: string;
}

export interface RouterSnapshot {
  readonly mode: RouterMode;
  readonly active: TransportName;
  readonly consecutiveFailures: number;
  readonly consecutiveProbeSuccesses: number;
  readonly probesAttempted: number;
  readonly nextProbeAtMs: number | undefined;
}

const DEFAULT_BACKOFF = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

export class TransportRouter {
  private mode: RouterMode = "primary";
  private consecutiveFailures = 0;
  private consecutiveProbeSuccesses = 0;
  private probesAttempted = 0;
  private nextProbeAtMs: number | undefined;
  private readonly failureThreshold: number;
  private readonly backoff: readonly number[];
  private readonly promoteAfterProbes: number;
  private readonly transitions: RouterTransition[] = [];

  constructor(options: TransportRouterOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 1;
    this.backoff = options.recoveryBackoffMs ?? DEFAULT_BACKOFF;
    this.promoteAfterProbes = options.promoteAfterProbes ?? 2;
    if (this.failureThreshold < 1) throw new RangeError("failureThreshold must be >= 1");
    if (this.promoteAfterProbes < 1) throw new RangeError("promoteAfterProbes must be >= 1");
    if (this.backoff.length === 0) throw new RangeError("recoveryBackoffMs must not be empty");
  }

  /** Transporte que as chamadas devem usar AGORA. */
  get active(): TransportName {
    return this.mode === "primary" ? "grpc" : "graphql";
  }

  get snapshot(): RouterSnapshot {
    return {
      mode: this.mode,
      active: this.active,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveProbeSuccesses: this.consecutiveProbeSuccesses,
      probesAttempted: this.probesAttempted,
      nextProbeAtMs: this.nextProbeAtMs,
    };
  }

  /** Histórico de transições (telemetria/diagnóstico; razões legíveis). */
  get history(): readonly RouterTransition[] {
    return this.transitions;
  }

  /** Chamada bem-sucedida no transporte ativo: zera o contador de falhas. */
  onCallSuccess(transport: TransportName): void {
    if (transport === "grpc" && this.mode === "primary") this.consecutiveFailures = 0;
  }

  /**
   * Falha DE TRANSPORTE no gRPC. Retorna "fellBack" quando o limiar foi
   * atingido e o roteamento mudou para GraphQL (o chamador reexecuta a
   * chamada corrente no fallback). Falhas no GraphQL nunca mudam o modo —
   * não há transporte abaixo dele.
   */
  onTransportFailure(
    transport: TransportName,
    nowMs: number,
    failure: ClassifiedError,
  ): "stay" | "fellBack" {
    // Invariante de segurança vive AQUI, não nos call-sites: credencial e
    // domínio jamais podem ser mascarados por outro transporte.
    if (
      failure.category !== "availability" ||
      transport !== "grpc" ||
      this.mode !== "primary"
    ) {
      return "stay";
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures < this.failureThreshold) return "stay";
    this.transition("fallback", `grpc transport failure: ${failure.reason}`);
    this.consecutiveProbeSuccesses = 0;
    this.probesAttempted = 0;
    this.nextProbeAtMs = nowMs + this.backoff[0]!;
    return "fellBack";
  }

  /** Em fallback: há sonda de recovery vencida? */
  shouldProbe(nowMs: number): boolean {
    return this.mode === "fallback" && this.nextProbeAtMs !== undefined && nowMs >= this.nextProbeAtMs;
  }

  /**
   * Resultado de uma sonda (Health do gRPC). Com `promoteAfterProbes` sondas
   * boas CONSECUTIVAS, repromove ao primário (histerese anti-flap).
   */
  onProbeResult(ok: boolean, nowMs: number): "promoted" | "probing" {
    if (this.mode !== "fallback") return "probing";
    this.probesAttempted++;
    if (!ok) {
      this.consecutiveProbeSuccesses = 0;
      const step = Math.min(this.probesAttempted, this.backoff.length - 1);
      this.nextProbeAtMs = nowMs + this.backoff[step]!;
      return "probing";
    }
    this.consecutiveProbeSuccesses++;
    if (this.consecutiveProbeSuccesses < this.promoteAfterProbes) {
      // sonda boa: reavalia logo (primeiro degrau), sem esperar a escada toda
      this.nextProbeAtMs = nowMs + this.backoff[0]!;
      return "probing";
    }
    this.transition("primary", `grpc healthy after ${this.consecutiveProbeSuccesses} consecutive probes`);
    this.consecutiveFailures = 0;
    this.consecutiveProbeSuccesses = 0;
    this.probesAttempted = 0;
    this.nextProbeAtMs = undefined;
    return "promoted";
  }

  private transition(to: RouterMode, reason: string): void {
    const from = this.mode;
    this.mode = to;
    this.transitions.push({ from, to, reason });
  }
}

export type TransportErrorCategory = "availability" | "authentication" | "domain";

/** Classificação de erro: só indisponibilidade justifica fallback. */
export interface ClassifiedError {
  readonly category: TransportErrorCategory;
  /** Compatibilidade legível: true somente para category=availability. */
  readonly transport: boolean;
  readonly reason: string;
}

/**
 * Classificador padrão: códigos gRPC de indisponibilidade (14 UNAVAILABLE,
 * 4 DEADLINE_EXCEEDED) e erros de socket (ECONNREFUSED/ENOENT/ECONNRESET/
 * EPIPE) são transporte; o resto é domínio e sobe ao chamador.
 */
export function classifyTransportError(err: unknown): ClassifiedError {
  const e = err as { code?: unknown; message?: unknown; statusCode?: unknown };
  const message = typeof e?.message === "string" ? e.message : String(err);
  if (
    e?.code === 16 ||
    e?.code === 7 ||
    e?.code === "P7M_AUTHENTICATION_FAILED" ||
    e?.code === "P7M_AUTH_CONFIGURATION" ||
    e?.statusCode === 401 ||
    e?.statusCode === 403
  ) {
    return { category: "authentication", transport: false, reason: "authentication failed" };
  }
  if (typeof e?.code === "number" && (e.code === 14 || e.code === 4)) {
    return { category: "availability", transport: true, reason: `grpc status ${e.code}: ${message}` };
  }
  if (
    typeof e?.code === "string" &&
    ["ECONNREFUSED", "ENOENT", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(e.code)
  ) {
    return { category: "availability", transport: true, reason: `socket ${e.code}` };
  }
  return { category: "domain", transport: false, reason: message };
}
