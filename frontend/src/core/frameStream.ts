/**
 * Leitor do plano de frames (`contracts/frame-stream-layout.md`) — o preview
 * embutido da ADR-024.
 *
 * O ESPELHO deste módulo é o `FrameStreamWriter` da engine, em C#. Os dois
 * lados vivem em processos e linguagens diferentes, e a única coisa que os
 * mantém falando a mesma língua é fixarem os MESMOS números nos MESMOS offsets
 * — por isso os casos de teste daqui têm gêmeo em `FrameStreamTests.cs`.
 *
 * A leitura é dividida em duas peças por causa do seqlock: validar o header é
 * puro, mas confirmar que o frame não rasgou exige reler a sequência NA FONTE,
 * depois de copiar os pixels. Quem toca a fonte é o processo principal; o que
 * mora aqui é a decisão, e ela não conhece arquivo nem IPC.
 *
 * Módulo puro (regra F1).
 */

/** Bytes ASCII `GSFB` lidos em little-endian. */
export const FRAME_STREAM_MAGIC = 0x42465347;
export const FRAME_STREAM_LAYOUT_VERSION = 1;
/** RGBA8 não pré-multiplicado — o único formato do layout v1. */
export const FRAME_PIXEL_FORMAT_RGBA8 = 1;
export const FRAME_HEADER_BYTES = 64;
export const FRAME_BYTES_PER_PIXEL = 4;

const MAGIC_OFFSET = 0;
const LAYOUT_VERSION_OFFSET = 4;
const WIDTH_OFFSET = 8;
const HEIGHT_OFFSET = 12;
const SEQUENCE_OFFSET = 16;
const FRAME_INDEX_OFFSET = 20;
const PIXEL_FORMAT_OFFSET = 24;

export interface FrameHeader {
  readonly width: number;
  readonly height: number;
  /** Par significa publicado; ímpar, rajada em andamento. */
  readonly sequence: number;
  readonly frameIndex: number;
  /** Bytes que o header promete: `64 + width * height * 4`. */
  readonly totalBytes: number;
}

/** Por que um header foi recusado — some quando o header é aceito. */
export type FrameHeaderRejection =
  | "short"
  | "magic"
  | "version"
  | "format"
  | "dimensions"
  | "truncated"
  | "writing";

export type FrameHeaderResult =
  | { readonly ok: true; readonly header: FrameHeader }
  | { readonly ok: false; readonly reason: FrameHeaderRejection };

/**
 * Valida o header contra o TAMANHO REAL do arquivo.
 *
 * Um header que promete mais pixels do que o arquivo tem é recusado, não
 * truncado para caber: truncar desenharia lixo com a cara de um frame. É a
 * mesma disciplina do resto do repositório — dado inconsistente é recusa com
 * razão, nunca conserto por adivinhação.
 *
 * `writing` não é erro: é o seqlock funcionando. O chamador tenta de novo e,
 * no limite, mantém o frame anterior — perder frame é normal num sinal
 * contínuo; exibir metade de um e metade de outro não é.
 */
export function parseFrameHeader(bytes: Uint8Array, fileSize: number): FrameHeaderResult {
  if (bytes.length < FRAME_HEADER_BYTES) return { ok: false, reason: "short" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number): number => view.getUint32(offset, true);

  if (u32(MAGIC_OFFSET) !== FRAME_STREAM_MAGIC) return { ok: false, reason: "magic" };
  if (u32(LAYOUT_VERSION_OFFSET) !== FRAME_STREAM_LAYOUT_VERSION) {
    return { ok: false, reason: "version" };
  }
  if (u32(PIXEL_FORMAT_OFFSET) !== FRAME_PIXEL_FORMAT_RGBA8) return { ok: false, reason: "format" };

  const sequence = u32(SEQUENCE_OFFSET);
  if (sequence % 2 !== 0) return { ok: false, reason: "writing" };

  const width = u32(WIDTH_OFFSET);
  const height = u32(HEIGHT_OFFSET);
  if (width <= 0 || height <= 0) return { ok: false, reason: "dimensions" };

  const totalBytes = FRAME_HEADER_BYTES + width * height * FRAME_BYTES_PER_PIXEL;
  // `Number.isSafeInteger` cobre o header hostil que descreve um frame
  // gigantesco só para fazer a conta estourar antes da comparação
  if (!Number.isSafeInteger(totalBytes) || totalBytes > fileSize) {
    return { ok: false, reason: "truncated" };
  }

  return {
    ok: true,
    header: { width, height, sequence, frameIndex: u32(FRAME_INDEX_OFFSET), totalBytes },
  };
}

/**
 * O frame copiado é o mesmo que o header descrevia?
 *
 * A sequência relida vem da FONTE, depois da cópia dos pixels. Igual significa
 * que nenhuma rajada começou no meio; qualquer outra coisa — inclusive um valor
 * ímpar — significa frame rasgado, e rasgado se descarta.
 */
export function isStableFrame(header: FrameHeader, sequenceAfterCopy: number): boolean {
  return sequenceAfterCopy === header.sequence;
}

/**
 * O frame vale ser desenhado, ou é o mesmo que o painel já mostra?
 *
 * Sem esta comparação, um host parado faria o painel redesenhar o mesmo frame
 * indefinidamente — e um `frameIndex` que não avança com o plano ligado é
 * exatamente o sinal de que o host parou.
 */
export function isNewerFrame(header: FrameHeader, lastDrawnFrameIndex: number | undefined): boolean {
  if (lastDrawnFrameIndex === undefined) return true;
  // o contador é `uint32` do outro lado do fio: depois de ~4,3 bilhões de
  // frames ele volta a zero, e tratar isso como "mais velho" congelaria o
  // painel para sempre
  return header.frameIndex !== lastDrawnFrameIndex;
}
