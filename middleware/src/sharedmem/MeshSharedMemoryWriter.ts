import fs from "node:fs";
import { resolveSharedMemoryPath } from "./SharedMemoryPath.js";
import {
  FIELD_TYPE_BYTES,
  fnv1a,
  validateLayout,
  type VertexData,
  type VertexLayout,
} from "./vertexLayout.js";

export const HEADER_BYTES = 64;
export const MESH_MAGIC = 0x4d4d3750; // "P7MM" em little-endian

const OFF_MAGIC = 0;
const OFF_LAYOUT_VERSION = 4;
const OFF_VERTEX_COUNT = 8;
const OFF_STRIDE = 12;
const OFF_SEQUENCE = 16;
const OFF_FRAME_INDEX = 20;

/**
 * Escritor do plano de dados: publica vértices no memory-mapped file que a
 * engine mapeia em somente-leitura (contracts/shared-memory-layout.md).
 *
 * A escrita segue o protocolo seqlock: `sequence` fica ímpar durante a rajada
 * e volta a par no publish, permitindo à engine tirar snapshots estáveis sem
 * nenhum lock compartilhado.
 *
 * O layout dos campos vem de fora (idealmente do manifesto `engine/describe`),
 * de modo que o escritor nunca depende de offsets hardcoded que possam
 * divergir da struct C#.
 */
export class MeshSharedMemoryWriter {
  readonly mapName: string;
  readonly path: string;
  readonly vertexCount: number;
  readonly layout: VertexLayout;

  private readonly fd: number;
  private readonly dataBuffer: Buffer;
  private readonly headerScratch = Buffer.alloc(4);
  private sequence = 0;
  private frameIndexValue = 0;
  private closed = false;

  private constructor(mapName: string, vertexCount: number, layout: VertexLayout, fd: number) {
    this.mapName = mapName;
    this.path = resolveSharedMemoryPath(mapName);
    this.vertexCount = vertexCount;
    this.layout = layout;
    this.fd = fd;
    this.dataBuffer = Buffer.alloc(vertexCount * layout.strideInBytes);
  }

  /** Geração do último publish (0 = nada publicado ainda). */
  get frameIndex(): number {
    return this.frameIndexValue;
  }

  get strideInBytes(): number {
    return this.layout.strideInBytes;
  }

  /**
   * Cria o arquivo com o tamanho final e o header inicializado (sequence par,
   * frameIndex 0, dados zerados). Deve acontecer ANTES do
   * `mesh/bind_shared_memory` — a engine valida o header no bind.
   */
  static create(mapName: string, vertexCount: number, layout: VertexLayout): MeshSharedMemoryWriter {
    if (!Number.isInteger(vertexCount) || vertexCount < 1) {
      throw new Error(`vertexCount must be a positive integer (got ${vertexCount})`);
    }
    validateLayout(layout);

    const path = resolveSharedMemoryPath(mapName);
    const fd = fs.openSync(path, "w+");
    try {
      const header = Buffer.alloc(HEADER_BYTES);
      header.writeUInt32LE(MESH_MAGIC, OFF_MAGIC);
      header.writeUInt32LE(layout.layoutVersion, OFF_LAYOUT_VERSION);
      header.writeUInt32LE(vertexCount, OFF_VERTEX_COUNT);
      header.writeUInt32LE(layout.strideInBytes, OFF_STRIDE);
      fs.writeSync(fd, header, 0, HEADER_BYTES, 0);
      fs.ftruncateSync(fd, HEADER_BYTES + vertexCount * layout.strideInBytes);
      return new MeshSharedMemoryWriter(mapName, vertexCount, layout, fd);
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  /**
   * Publica um conjunto completo de vértices. Cada vértice é um objeto cujas
   * chaves correspondem aos campos do layout (`position: [x, y]`,
   * `boneIndices: [a, b, c, d]`, ...).
   */
  publish(vertices: readonly VertexData[]): void {
    this.ensureOpen();
    if (vertices.length !== this.vertexCount) {
      throw new Error(`Expected ${this.vertexCount} vertices, got ${vertices.length}`);
    }

    for (let i = 0; i < vertices.length; i++) {
      this.encodeVertex(vertices[i]!, i * this.layout.strideInBytes);
    }

    this.writeHeaderU32(OFF_SEQUENCE, ++this.sequence); // ímpar: escrita em progresso
    fs.writeSync(this.fd, this.dataBuffer, 0, this.dataBuffer.length, HEADER_BYTES);
    this.writeHeaderU32(OFF_FRAME_INDEX, ++this.frameIndexValue);
    this.writeHeaderU32(OFF_SEQUENCE, ++this.sequence); // par: publish concluído
  }

  /** FNV-1a 32-bit dos bytes publicados — casa com `mesh/inspect` da engine. */
  checksum(): number {
    return fnv1a(this.dataBuffer);
  }

  close(deleteFile = false): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
    if (deleteFile) {
      fs.rmSync(this.path, { force: true });
    }
  }

  private encodeVertex(vertex: VertexData, base: number): void {
    for (const field of this.layout.fields) {
      const value = vertex[field.name];
      if (value === undefined) {
        throw new Error(`Vertex is missing field "${field.name}" required by layout "${this.layout.name}"`);
      }
      const offset = base + field.offset;
      switch (field.type) {
        case "float":
          this.dataBuffer.writeFloatLE(asScalar(field.name, value), offset);
          break;
        case "float2":
        case "float3":
        case "float4": {
          const arity = FIELD_TYPE_BYTES[field.type] / 4;
          const components = asVector(field.name, value, arity);
          for (let c = 0; c < arity; c++) {
            this.dataBuffer.writeFloatLE(components[c]!, offset + c * 4);
          }
          break;
        }
        case "byte4": {
          const components = asVector(field.name, value, 4);
          for (let c = 0; c < 4; c++) {
            const b = components[c]!;
            if (!Number.isInteger(b) || b < 0 || b > 255) {
              throw new Error(`Field "${field.name}"[${c}] must be an integer in [0, 255] (got ${b})`);
            }
            this.dataBuffer.writeUInt8(b, offset + c);
          }
          break;
        }
        case "uint":
          this.dataBuffer.writeUInt32LE(asScalar(field.name, value) >>> 0, offset);
          break;
      }
    }
  }

  private writeHeaderU32(offset: number, value: number): void {
    this.headerScratch.writeUInt32LE(value >>> 0, 0);
    fs.writeSync(this.fd, this.headerScratch, 0, 4, offset);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error(`Writer for "${this.mapName}" is closed`);
    }
  }
}

function asScalar(name: string, value: number | readonly number[]): number {
  if (typeof value !== "number") {
    throw new Error(`Field "${name}" expects a scalar number`);
  }
  return value;
}

function asVector(name: string, value: number | readonly number[], arity: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== arity) {
    throw new Error(`Field "${name}" expects an array of ${arity} numbers`);
  }
  return value;
}
