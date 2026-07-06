import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FrameDecoder,
  FrameProtocolError,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
} from "../src/protocol/framing.js";

test("encodeFrame produz header uint32 LE + payload UTF-8", () => {
  const frame = encodeFrame('{"a":1}');
  assert.equal(frame.readUInt32LE(0), 7);
  assert.equal(frame.toString("utf8", HEADER_BYTES), '{"a":1}');
});

test("roundtrip de um único frame", () => {
  const decoder = new FrameDecoder();
  const bodies = decoder.push(encodeFrame('{"jsonrpc":"2.0"}'));
  assert.deepEqual(bodies, ['{"jsonrpc":"2.0"}']);
  assert.equal(decoder.bufferedBytes, 0);
});

test("decoder reagrupa frames fatiados byte a byte", () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame('{"method":"engine/ping"}');
  const collected: string[] = [];
  for (const byte of frame) {
    collected.push(...decoder.push(Buffer.from([byte])));
  }
  assert.deepEqual(collected, ['{"method":"engine/ping"}']);
});

test("decoder separa múltiplos frames colados em um único chunk", () => {
  const decoder = new FrameDecoder();
  const chunk = Buffer.concat([encodeFrame("um"), encodeFrame("dois"), encodeFrame("três")]);
  assert.deepEqual(decoder.push(chunk), ["um", "dois", "três"]);
});

test("payload UTF-8 multibyte preserva acentuação", () => {
  const decoder = new FrameDecoder();
  const body = '{"message":"animação esquelética: coração ❤️"}';
  assert.deepEqual(decoder.push(encodeFrame(body)), [body]);
});

test("frame declarando tamanho acima do limite lança FrameProtocolError", () => {
  const decoder = new FrameDecoder();
  const evil = Buffer.alloc(HEADER_BYTES);
  evil.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
  assert.throws(() => decoder.push(evil), FrameProtocolError);
});

test("encodeFrame recusa payloads acima do limite", () => {
  assert.throws(() => encodeFrame("x".repeat(MAX_FRAME_BYTES + 1)), FrameProtocolError);
});
