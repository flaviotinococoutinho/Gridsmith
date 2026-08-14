import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { HEADER_BYTES, MESH_MAGIC, MeshSharedMemoryWriter } from "../src/sharedmem/MeshSharedMemoryWriter.js";
import { SKINNED_VERTEX_2D, fnv1a, validateLayout, type VertexData } from "../src/sharedmem/vertexLayout.js";

function uniqueName(): string {
  return `gridsmith-test-writer-${randomUUID()}`;
}

function makeVertex(px: number, py: number): VertexData {
  return {
    position: [px, py],
    uv: [px / 100, py / 100],
    boneIndices: [0, 1, 0, 0],
    boneWeights: [0.75, 0.25, 0, 0],
  };
}

function withWriter(vertexCount: number, fn: (w: MeshSharedMemoryWriter) => void): void {
  const writer = MeshSharedMemoryWriter.create(uniqueName(), vertexCount, SKINNED_VERTEX_2D);
  try {
    fn(writer);
  } finally {
    writer.close(true);
  }
}

test("create grava o header conforme contracts/shared-memory-layout.md", () => {
  withWriter(3, (writer) => {
    const raw = fs.readFileSync(writer.path);
    assert.equal(raw.length, HEADER_BYTES + 3 * 36);
    assert.equal(raw.readUInt32LE(0), MESH_MAGIC);       // magic "GSMM"
    assert.equal(raw.readUInt32LE(4), 1);                // layoutVersion
    assert.equal(raw.readUInt32LE(8), 3);                // vertexCount
    assert.equal(raw.readUInt32LE(12), 36);              // strideInBytes
    assert.equal(raw.readUInt32LE(16), 0);               // sequence (par: estável)
    assert.equal(raw.readUInt32LE(20), 0);               // frameIndex
  });
});

test("publish escreve os campos nos offsets exatos do layout", () => {
  withWriter(2, (writer) => {
    writer.publish([makeVertex(10, 20), makeVertex(-3, 7.5)]);

    const raw = fs.readFileSync(writer.path);
    const v0 = HEADER_BYTES;
    assert.equal(raw.readFloatLE(v0 + 0), 10);           // position.x
    assert.equal(raw.readFloatLE(v0 + 4), 20);           // position.y
    assert.ok(Math.abs(raw.readFloatLE(v0 + 8) - 0.1) < 1e-6);  // uv.x
    assert.equal(raw.readUInt8(v0 + 16), 0);             // boneIndices[0]
    assert.equal(raw.readUInt8(v0 + 17), 1);             // boneIndices[1]
    assert.equal(raw.readFloatLE(v0 + 20), 0.75);        // boneWeights.x

    const v1 = HEADER_BYTES + 36;
    assert.equal(raw.readFloatLE(v1 + 0), -3);
    assert.equal(raw.readFloatLE(v1 + 4), 7.5);
  });
});

test("publish segue o protocolo seqlock: sequence par e frameIndex monotônico", () => {
  withWriter(1, (writer) => {
    writer.publish([makeVertex(1, 1)]);
    let raw = fs.readFileSync(writer.path);
    assert.equal(raw.readUInt32LE(16), 2);  // uma rajada completa: ímpar → par
    assert.equal(raw.readUInt32LE(20), 1);
    assert.equal(writer.frameIndex, 1);

    writer.publish([makeVertex(2, 2)]);
    raw = fs.readFileSync(writer.path);
    assert.equal(raw.readUInt32LE(16), 4);
    assert.equal(raw.readUInt32LE(20), 2);
    assert.equal(writer.frameIndex, 2);
  });
});

test("checksum casa com FNV-1a de referência sobre os bytes do arquivo", () => {
  withWriter(2, (writer) => {
    writer.publish([makeVertex(10, 20), makeVertex(30, 40)]);
    const dataBytes = fs.readFileSync(writer.path).subarray(HEADER_BYTES);
    assert.equal(writer.checksum(), fnv1a(dataBytes));
  });
});

test("publish rejeita contagem de vértices errada e campo ausente", () => {
  withWriter(2, (writer) => {
    assert.throws(() => writer.publish([makeVertex(1, 1)]), /Expected 2 vertices/);
    assert.throws(
      () => writer.publish([makeVertex(1, 1), { position: [0, 0] }]),
      /missing field "uv"/,
    );
  });
});

test("publish rejeita byte4 fora de [0, 255] e vetor com aridade errada", () => {
  withWriter(1, (writer) => {
    assert.throws(
      () => writer.publish([{ ...makeVertex(0, 0), boneIndices: [0, 999, 0, 0] }]),
      /\[0, 255\]/,
    );
    assert.throws(
      () => writer.publish([{ ...makeVertex(0, 0), position: [1, 2, 3] }]),
      /array of 2 numbers/,
    );
  });
});

test("validateLayout rejeita campo que estoura o stride", () => {
  assert.throws(
    () =>
      validateLayout({
        name: "broken",
        layoutVersion: 1,
        strideInBytes: 12,
        fields: [{ name: "weights", offset: 8, type: "float4" }],
      }),
    /overflows stride/,
  );
});

test("writer fechado recusa publish e close(true) remove o arquivo", () => {
  const writer = MeshSharedMemoryWriter.create(uniqueName(), 1, SKINNED_VERTEX_2D);
  const path = writer.path;
  writer.close(true);
  assert.equal(fs.existsSync(path), false);
  assert.throws(() => writer.publish([makeVertex(0, 0)]), /is closed/);
});
