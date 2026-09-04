#!/usr/bin/env node
/**
 * Gera o atlas do projeto de exemplo (`examples/plataforma-2d/assets/atlas.png`).
 *
 * A arte do exemplo é DESENHADA AQUI, não copiada de lugar nenhum: o Gridsmith
 * versiona um exemplo para o avaliador abrir no primeiro minuto, e um exemplo
 * que dependesse de arte de terceiros não poderia ser versionado junto. O
 * gerador fica no repositório com o PNG para que a imagem seja reproduzível —
 * um binário sem origem é exatamente a "arte inventada" que o plano proíbe.
 *
 * Saída determinística: mesma entrada, mesmo arquivo byte a byte. Sem RNG —
 * as manchas vêm de um hash das coordenadas.
 *
 * Uso: node scripts/make-example-atlas.mjs [--check]
 *   --check  não escreve; falha se o PNG do repositório divergir do gerado.
 */

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "examples/plataforma-2d/assets/atlas.png");

/** Grade do atlas — os MESMOS números que o `TilesetSpec` do documento declara. */
const TILE_SIZE = 16;
const COLUMNS = 4;
const ROWS = 4;
const WIDTH = TILE_SIZE * COLUMNS;
const HEIGHT = TILE_SIZE * ROWS;

/** Ruído determinístico em [0,1) por pixel — o mesmo hash de Knuth do fallback. */
function noise(x, y) {
  const hash = (Math.imul(x * 73_856_093 ^ y * 19_349_663, 2654435761) >>> 0) >>> 0;
  return (hash & 0xffff) / 0x10000;
}

/**
 * Cor RGBA de um pixel DENTRO de um tile (`u`,`v` em 0..15).
 * Tile 0 é vazio de propósito: um atlas sem célula transparente obrigaria todo
 * nível a ter chão em toda parte.
 */
function pixelOf(tileId, u, v) {
  const T = (r, g, b, a = 255) => [r, g, b, a];
  const shade = (base, amount) => base.map((c, i) => (i === 3 ? c : Math.max(0, Math.min(255, c + amount))));
  switch (tileId) {
    case 0: // vazio
      return T(0, 0, 0, 0);
    case 1: // terra
      return shade(T(122, 84, 54), noise(u, v) > 0.82 ? -22 : 0);
    case 2: // terra com topo de grama
      if (v < 4) return shade(T(86, 158, 74), noise(u, v) > 0.7 ? 16 : 0);
      if (v === 4) return T(70, 128, 60);
      return shade(T(122, 84, 54), noise(u, v) > 0.82 ? -22 : 0);
    case 3: // pedra
      return shade(T(126, 130, 140), (u % 8 < 4) === (v % 8 < 4) ? 10 : -10);
    case 4: // borda esquerda de plataforma
      return u < 3 ? T(70, 128, 60) : pixelOf(2, u, v);
    case 5: // borda direita de plataforma
      return u > TILE_SIZE - 4 ? T(70, 128, 60) : pixelOf(2, u, v);
    case 6: // caixa
      if (u === 0 || v === 0 || u === TILE_SIZE - 1 || v === TILE_SIZE - 1) return T(96, 66, 38);
      if (Math.abs(u - v) < 2 || Math.abs(u + v - (TILE_SIZE - 1)) < 2) return T(150, 108, 64);
      return T(176, 130, 80);
    case 7: // moeda
      return (u - 7.5) ** 2 + (v - 7.5) ** 2 < 30 ? T(238, 196, 66) : T(0, 0, 0, 0);
    case 8: {
      // jogador: cabeça, corpo e pernas — o sprite que a definição aponta
      if (v < 3 || v > 14 || u < 4 || u > 11) return T(0, 0, 0, 0);
      if (v < 7) return u > 4 && u < 11 ? T(232, 196, 160) : T(0, 0, 0, 0); // cabeça
      if (v < 12) return T(58, 122, 200); // tronco
      return u < 8 ? T(44, 62, 96) : T(38, 54, 84); // pernas
    }
    default:
      return T(0, 0, 0, 0);
  }
}

function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA — o tile vazio precisa de alfa
  // 10..12 = compressão/filtro/entrelaçamento padrão (0)

  // uma linha por scanline, cada uma prefixada pelo filtro 0 (None): o ganho
  // de um filtro melhor não paga a variação entre versões do encoder, e este
  // arquivo é comparado byte a byte no CI
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function render() {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const tileId = Math.floor(y / TILE_SIZE) * COLUMNS + Math.floor(x / TILE_SIZE);
      const [r, g, b, a] = pixelOf(tileId, x % TILE_SIZE, y % TILE_SIZE);
      const offset = (y * WIDTH + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = a;
    }
  }
  return encodePng(WIDTH, HEIGHT, rgba);
}

const png = render();
if (process.argv.includes("--check")) {
  let current;
  try {
    current = readFileSync(OUTPUT);
  } catch {
    console.error(`[atlas] ${OUTPUT} não existe — rode: node scripts/make-example-atlas.mjs`);
    process.exit(1);
  }
  if (!current.equals(png)) {
    console.error("[atlas] o PNG versionado difere do gerado — regenere e commite.");
    process.exit(1);
  }
  console.log(`[atlas] OK — ${WIDTH}x${HEIGHT}, ${COLUMNS}x${ROWS} tiles de ${TILE_SIZE}px.`);
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, png);
  console.log(`[atlas] escrito ${OUTPUT} (${png.length} bytes).`);
}
