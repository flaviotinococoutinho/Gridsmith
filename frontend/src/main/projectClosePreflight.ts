/** Handshake main→renderer que sela drafts antes de qualquer fechamento. */

import type {
  ProjectClosePreflightReason,
  ProjectClosePreflightRequest,
  ProjectClosePreflightResponse,
} from "../core/projectApi.js";

const MAX_RESPONSE_REASON_LENGTH = 240;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f\u2028\u2029]/u;

export class ProjectClosePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectClosePreflightError";
  }
}

interface PendingPreflight {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export interface ProjectClosePreflightOptions {
  readonly send: (request: ProjectClosePreflightRequest) => void;
  readonly createId: () => string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export class ProjectClosePreflight {
  private readonly pending = new Map<string, PendingPreflight>();
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly options: ProjectClosePreflightOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new RangeError("Project close preflight timeout must be an integer in [100, 30000]");
    }
  }

  request(reason: ProjectClosePreflightReason): Promise<void> {
    const requestId = this.options.createId();
    if (!SAFE_REQUEST_ID.test(requestId) || this.pending.has(requestId)) {
      return Promise.reject(new ProjectClosePreflightError("Não foi possível identificar o preflight de fechamento."));
    }
    const request = Object.freeze({
      requestId,
      reason,
      deadlineUnixMs: this.now() + this.timeoutMs,
    }) satisfies ProjectClosePreflightRequest;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ProjectClosePreflightError(
          "O editor não confirmou as alterações em edição dentro do prazo; o fechamento foi cancelado.",
        ));
      }, this.timeoutMs);
      const pending: PendingPreflight = {
        timer,
        resolve: () => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(error);
        },
      };
      this.pending.set(requestId, pending);
      try {
        this.options.send(request);
      } catch (error) {
        pending.reject(new ProjectClosePreflightError(
          `Não foi possível consultar as edições pendentes; o fechamento foi cancelado: ${errorMessage(error)}`,
        ));
      }
    });
  }

  /** Retorna false para respostas atrasadas ou que não pertencem a este host. */
  accept(value: unknown): boolean {
    const requestId = responseRequestId(value);
    if (!requestId) return false;
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    let response: ProjectClosePreflightResponse;
    try {
      response = validatedResponse(value);
    } catch (error) {
      pending.reject(new ProjectClosePreflightError(
        `Resposta inválida ao confirmar edições; o fechamento foi cancelado: ${errorMessage(error)}`,
      ));
      return true;
    }
    if (response.status === "ready") pending.resolve();
    else {
      pending.reject(new ProjectClosePreflightError(
        `Há uma edição que não pôde ser confirmada; o fechamento foi cancelado: ${response.reason}`,
      ));
    }
    return true;
  }

  cancelAll(reason = "O renderer foi encerrado antes de confirmar as edições."): void {
    const error = new ProjectClosePreflightError(reason);
    for (const pending of [...this.pending.values()]) pending.reject(error);
  }

  get size(): number {
    return this.pending.size;
  }
}

function validatedResponse(value: unknown): ProjectClosePreflightResponse {
  if (!isPlainRecord(value)) throw new TypeError("response must be a plain object");
  const keys = Object.keys(value).sort();
  const requestId = responseRequestId(value);
  if (!requestId || !SAFE_REQUEST_ID.test(requestId)) throw new TypeError("requestId is invalid");
  if (value["status"] === "ready") {
    if (keys.join(",") !== "requestId,status") throw new TypeError("ready response has extra fields");
    return { requestId, status: "ready" };
  }
  if (value["status"] !== "rejected") throw new TypeError("status is invalid");
  if (keys.join(",") !== "reason,requestId,status") {
    throw new TypeError("rejected response has missing or extra fields");
  }
  const reason = value["reason"];
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > MAX_RESPONSE_REASON_LENGTH ||
    reason !== reason.trim() ||
    CONTROL_CHARACTER.test(reason)
  ) {
    throw new TypeError("rejection reason is invalid");
  }
  return { requestId, status: "rejected", reason };
}

function responseRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const requestId = (value as Record<string, unknown>)["requestId"];
  return typeof requestId === "string" ? requestId : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
