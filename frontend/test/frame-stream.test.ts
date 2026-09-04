import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FRAME_BYTES_PER_PIXEL,
  FRAME_HEADER_BYTES,
  FRAME_PIXEL_FORMAT_RGBA8,
  FRAME_STREAM_LAYOUT_VERSION,
  FRAME_STREAM_MAGIC,
  isNewerFrame,
  isStableFrame,
  parseFrameHeader,
} from "../src/core/frameStream.js";

/**
 * ESTES CASOS SÃO ESPELHADOS na engine (`FrameStreamTests.cs`). O escritor e o
 * leitor do plano de frames vivem em processos e linguagens diferentes; o que
 * os mantém falando a mesma língua é os dois lados fixarem os MESMOS números
 * nos MESMOS offsets.
 *
 * Aqui o teste monta bytes à mão de propósito: é o único jeito de exercitar o
 * que um escritor correto nunca produz — header rasgado, magic errado, versão
 * futura, dimensão que não cabe no arquivo.
 */
function frameBytes(options: {
  magic?: number;
  version?: number;
  width?: number;
  height?: number;
  sequence?: number;
  frameIndex?: number;
  format?: number;
  payload?: number;
}): Uint8Array {
  const width = options.width ?? 2;
  const height = options.height ?? 2;
  const payload = options.payload ?? width * height * FRAME_BYTES_PER_PIXEL;
  const bytes = new Uint8Array(FRAME_HEADER_BYTES + payload);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, options.magic ?? FRAME_STREAM_MAGIC, true);
  view.setUint32(4, options.version ?? FRAME_STREAM_LAYOUT_VERSION, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, options.sequence ?? 2, true);
  view.setUint32(20, options.frameIndex ?? 1, true);
  view.setUint32(24, options.format ?? FRAME_PIXEL_FORMAT_RGBA8, true);
  return bytes;
}

const parse = (bytes: Uint8Array, fileSize = bytes.length) => parseFrameHeader(bytes, fileSize);

test("um header publicado devolve dimensões, sequência e o total prometido", () => {
  const bytes = frameBytes({ width: 4, height: 3, sequence: 8, frameIndex: 4 });
  const result = parse(bytes);

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.header, {
    width: 4,
    height: 3,
    sequence: 8,
    frameIndex: 4,
    totalBytes: FRAME_HEADER_BYTES + 4 * 3 * 4,
  });
});

test("sequência ÍMPAR não é erro: é rajada em andamento", () => {
  // é o seqlock funcionando. O chamador tenta de novo e, no limite, mantém o
  // frame anterior — perder frame num sinal contínuo não custa nada
  const result = parse(frameBytes({ sequence: 7 }));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "writing");
});

test("magic errado é recusado no PRIMEIRO campo", () => {
  // o plano de dados usa os mesmos offsets para magic e versão: abrir o
  // arquivo errado tem de falhar aqui, não interpretando vértices como pixels
  const result = parse(frameBytes({ magic: 0x4d4d5347 }));
  assert.equal(!result.ok && result.reason, "magic");
});

test("versão futura e formato desconhecido são recusados, não adivinhados", () => {
  assert.equal(!parse(frameBytes({ version: 2 })).ok, true);
  assert.equal(
    (() => {
      const r = parse(frameBytes({ version: 2 }));
      return !r.ok && r.reason;
    })(),
    "version",
  );
  const format = parse(frameBytes({ format: 99 }));
  assert.equal(!format.ok && format.reason, "format");
});

test("header que promete mais pixels do que o arquivo tem é RECUSADO, não truncado", () => {
  // truncar para caber desenharia lixo com a cara de um frame
  const bytes = frameBytes({ width: 64, height: 64, payload: 16 });
  const result = parse(bytes, bytes.length);
  assert.equal(!result.ok && result.reason, "truncated");
});

test("dimensão gigantesca não estoura a conta antes da comparação", () => {
  const bytes = frameBytes({ width: 0xffffffff, height: 0xffffffff, payload: 0 });
  const result = parse(bytes, Number.MAX_SAFE_INTEGER);
  assert.equal(!result.ok && result.reason, "truncated");
});

test("dimensão zero e buffer curto demais são recusados", () => {
  const zero = parse(frameBytes({ width: 0, payload: 0 }));
  assert.equal(!zero.ok && zero.reason, "dimensions");
  const short = parse(new Uint8Array(16), 16);
  assert.equal(!short.ok && short.reason, "short");
});

test("frame rasgado é descartado: a sequência relida na FONTE tem de bater", () => {
  const result = parse(frameBytes({ sequence: 10 }));
  assert.ok(result.ok);
  const header = result.header;

  assert.equal(isStableFrame(header, 10), true);
  // outra rajada começou durante a cópia
  assert.equal(isStableFrame(header, 11), false);
  // ou começou E terminou: os pixels copiados são uma mistura de dois frames
  assert.equal(isStableFrame(header, 12), false);
});

test("frame repetido não é redesenhado; frameIndex parado é host parado", () => {
  const result = parse(frameBytes({ frameIndex: 5 }));
  assert.ok(result.ok);

  assert.equal(isNewerFrame(result.header, undefined), true);
  assert.equal(isNewerFrame(result.header, 4), true);
  assert.equal(isNewerFrame(result.header, 5), false);
});

test("a volta do contador de 32 bits NÃO congela o painel", () => {
  // o frameIndex é uint32 do outro lado do fio; tratar a volta como "mais
  // velho" pararia o preview para sempre depois de ~4,3 bilhões de frames
  const result = parse(frameBytes({ frameIndex: 0 }));
  assert.ok(result.ok);
  assert.equal(isNewerFrame(result.header, 0xffffffff), true);
});
