/**
 * Diário de eventos do Blueprint compartilhado pelos transports do editor.
 *
 * A posição de consumo não é apenas um número: `seq` só é monotônico dentro
 * de uma instância do middleware. O cursor completo é
 * `(middlewareInstanceId, seq)`, o que permite distinguir uma reconexão normal
 * de um processo novo cujo contador voltou a zero.
 *
 * Internamente a sequência é `bigint`; nas bordas ela é sempre serializada
 * como string decimal (GraphQL) ou `uint64` carregado como string (gRPC).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type EventSequence = bigint;
export type EventSequenceInput = string | number | bigint;

export interface EventEnvelope {
  readonly seq: EventSequence;
  readonly kind: string;
  readonly payload: unknown;
}

export type ResyncReason =
  | "instance_changed"
  | "journal_gap"
  | "cursor_ahead"
  | "invalid_cursor";

export interface JournalPosition {
  readonly middlewareInstanceId: string;
  readonly firstAvailableSeq: EventSequence;
  readonly lastEventSeq: EventSequence;
}

export interface JournalReadResult extends JournalPosition {
  readonly resyncRequired: boolean;
  readonly resyncReason?: ResyncReason;
  /** Vazio sempre que `resyncRequired` for true: nunca aplica uma cauda parcial. */
  readonly events: readonly EventEnvelope[];
}

const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Converte um cursor externo em sequência válida. A função é exportada para as
 * bordas validarem consistentemente GraphQL String e protobuf uint64/string.
 */
export function parseEventSequence(value: unknown): EventSequence | undefined {
  if (typeof value === "bigint") {
    return value >= 0n && value <= UINT64_MAX ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed <= UINT64_MAX ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Eventos: "event" (EventEnvelope) a cada append. */
export class EventJournal extends EventEmitter {
  private readonly ring: EventEnvelope[] = [];
  private nextSeq = 1n;

  constructor(
    private readonly capacity = 512,
    readonly middlewareInstanceId = randomUUID(),
  ) {
    super();
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`EventJournal capacity must be a positive integer (got ${capacity})`);
    }
    if (typeof middlewareInstanceId !== "string" || middlewareInstanceId.trim().length === 0) {
      throw new TypeError("middlewareInstanceId must be a non-empty string");
    }
  }

  get lastSeq(): EventSequence {
    return this.nextSeq - 1n;
  }

  /** Primeiro evento ainda reentregável; em diário vazio, `lastSeq + 1`. */
  get firstAvailableSeq(): EventSequence {
    return this.ring[0]?.seq ?? this.nextSeq;
  }

  get position(): JournalPosition {
    return Object.freeze({
      middlewareInstanceId: this.middlewareInstanceId,
      firstAvailableSeq: this.firstAvailableSeq,
      lastEventSeq: this.lastSeq,
    });
  }

  append(kind: string, payload: unknown): EventEnvelope {
    if (this.nextSeq > UINT64_MAX) {
      throw new RangeError("EventJournal exhausted the uint64 sequence space; restart with a new instance id");
    }
    const envelope: EventEnvelope = Object.freeze({ seq: this.nextSeq++, kind, payload });
    this.ring.push(envelope);
    if (this.ring.length > this.capacity) this.ring.shift();
    this.emit("event", envelope);
    return envelope;
  }

  /** Eventos com `seq > afterSeq`, apenas quando o cursor é válido nesta janela. */
  since(afterSeq: EventSequenceInput): readonly EventEnvelope[] {
    const seq = parseEventSequence(afterSeq);
    if (seq === undefined) return [];
    return this.ring.filter((event) => event.seq > seq);
  }

  /**
   * Resolve um cursor completo. Instância nova, gap, cursor futuro ou entrada
   * inválida exigem snapshot completo e nunca retornam uma cauda parcial.
   */
  readSince(middlewareInstanceId: unknown, afterSeq: unknown): JournalReadResult {
    const position = this.position;
    const seq = parseEventSequence(afterSeq);
    if (
      typeof middlewareInstanceId !== "string" ||
      middlewareInstanceId.length === 0 ||
      seq === undefined
    ) {
      return this.resync(position, "invalid_cursor");
    }
    if (middlewareInstanceId !== this.middlewareInstanceId) {
      return this.resync(position, "instance_changed");
    }
    if (seq > this.lastSeq) {
      return this.resync(position, "cursor_ahead");
    }
    if (seq + 1n < this.firstAvailableSeq) {
      return this.resync(position, "journal_gap");
    }
    return Object.freeze({
      ...position,
      resyncRequired: false,
      events: Object.freeze([...this.ring.filter((event) => event.seq > seq)]),
    });
  }

  /** Compatibilidade interna: resume apenas dentro da janela e nunca de cursor futuro. */
  canResumeFrom(afterSeq: EventSequenceInput): boolean {
    return !this.readSince(this.middlewareInstanceId, afterSeq).resyncRequired;
  }

  private resync(position: JournalPosition, reason: ResyncReason): JournalReadResult {
    return Object.freeze({
      ...position,
      resyncRequired: true,
      resyncReason: reason,
      events: Object.freeze([]),
    });
  }
}
