/**
 * Diário de eventos do Blueprint para os transports do editor.
 *
 * Ring buffer com sequência MONOTÔNICA por processo: o gRPC transmite ao vivo
 * (StreamEvents com catch-up por `after_seq`) e o GraphQL faz polling
 * incremental (`eventsSince(afterSeq)`) — os dois transports leem o MESMO
 * diário, então o fallback nunca perde eventos dentro da janela do ring.
 *
 * Puro (zero imports além de node:events): capacidade fixa, sem I/O.
 */

import { EventEmitter } from "node:events";

export interface EventEnvelope {
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
}

/** Eventos: "event" (EventEnvelope) a cada append. */
export class EventJournal extends EventEmitter {
  private readonly ring: EventEnvelope[] = [];
  private nextSeq = 1;

  constructor(private readonly capacity = 512) {
    super();
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`EventJournal capacity must be a positive integer (got ${capacity})`);
    }
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  append(kind: string, payload: unknown): EventEnvelope {
    const envelope: EventEnvelope = Object.freeze({ seq: this.nextSeq++, kind, payload });
    this.ring.push(envelope);
    if (this.ring.length > this.capacity) this.ring.shift();
    this.emit("event", envelope);
    return envelope;
  }

  /**
   * Eventos com `seq > afterSeq` ainda na janela do ring. Se o cliente ficou
   * para trás além da janela, devolve o que existe — o chamador detecta o gap
   * comparando o primeiro seq retornado com `afterSeq + 1` e ressincroniza
   * via query de projeção completa.
   */
  since(afterSeq: number): readonly EventEnvelope[] {
    return this.ring.filter((e) => e.seq > afterSeq);
  }

  /** true se `afterSeq` ainda permite reentrega sem gap. */
  canResumeFrom(afterSeq: number): boolean {
    if (afterSeq >= this.lastSeq) return true;
    const first = this.ring[0];
    return first !== undefined && first.seq <= afterSeq + 1;
  }
}
