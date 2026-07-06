/**
 * Framing binário-seguro do plano de controle:
 * cada frame é `uint32 LE (tamanho do body)` + `body UTF-8 (JSON-RPC 2.0)`.
 *
 * O decoder é incremental: aceita chunks arbitrários do socket e emite
 * frames completos à medida que fecham, sem heurística de delimitadores.
 */

export const HEADER_BYTES = 4;

/** Frames de controle acima disso indicam uso indevido do canal (dados em massa vão via shared memory). */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameProtocolError";
  }
}

export function encodeFrame(body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new FrameProtocolError(
      `Frame of ${payload.length} bytes exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
    );
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  /**
   * Alimenta um chunk cru do transporte e retorna os bodies UTF-8 dos frames
   * que fecharam. Lança `FrameProtocolError` para frames acima do limite —
   * o chamador deve encerrar a conexão nesse caso.
   */
  push(chunk: Buffer): string[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frames: string[] = [];
    for (;;) {
      if (this.pending.length < HEADER_BYTES) break;
      const bodyLength = this.pending.readUInt32LE(0);
      if (bodyLength > MAX_FRAME_BYTES) {
        throw new FrameProtocolError(
          `Incoming frame declares ${bodyLength} bytes, above MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`,
        );
      }
      const frameEnd = HEADER_BYTES + bodyLength;
      if (this.pending.length < frameEnd) break;
      frames.push(this.pending.toString("utf8", HEADER_BYTES, frameEnd));
      this.pending = this.pending.subarray(frameEnd);
    }
    return frames;
  }

  /** Bytes ainda aguardando o fechamento de um frame (diagnóstico). */
  get bufferedBytes(): number {
    return this.pending.length;
  }
}
