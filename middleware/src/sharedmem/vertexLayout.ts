/**
 * Descritores de layout binário do plano de dados
 * (contracts/shared-memory-layout.md).
 *
 * A FONTE DE VERDADE dos offsets é a engine: o manifesto de `engine/describe`
 * publica os layouts derivados por reflexão das structs C#. A constante local
 * existe como fallback para testes e boot offline, e é verificada contra o
 * manifesto real no teste ponta-a-ponta da Fase 2.
 */

export type VertexFieldType = "float" | "float2" | "float3" | "float4" | "byte4" | "uint";

export interface VertexFieldLayout {
  readonly name: string;
  readonly offset: number;
  readonly type: VertexFieldType;
  readonly semantic?: string;
}

export interface VertexLayout {
  readonly name: string;
  readonly layoutVersion: number;
  readonly strideInBytes: number;
  readonly fields: readonly VertexFieldLayout[];
}

export const FIELD_TYPE_BYTES: Record<VertexFieldType, number> = {
  float: 4,
  float2: 8,
  float3: 12,
  float4: 16,
  byte4: 4,
  uint: 4,
};

/** Fallback local do layout v1 — espelho de SkinnedVertex2D (C#). */
export const SKINNED_VERTEX_2D: VertexLayout = {
  name: "SkinnedVertex2D",
  layoutVersion: 1,
  strideInBytes: 36,
  fields: [
    { name: "position", offset: 0, type: "float2", semantic: "Posição no espaço do modelo" },
    { name: "uv", offset: 8, type: "float2", semantic: "Coordenada de textura" },
    { name: "boneIndices", offset: 16, type: "byte4", semantic: "Índices dos 4 ossos de influência" },
    { name: "boneWeights", offset: 20, type: "float4", semantic: "Pesos de influência (soma ≈ 1.0)" },
  ],
};

/** Valor de um campo de vértice: escalar ou vetor conforme o tipo. */
export type VertexFieldValue = number | readonly number[];
export type VertexData = Readonly<Record<string, VertexFieldValue>>;

export function validateLayout(layout: VertexLayout): void {
  if (layout.fields.length === 0) {
    throw new Error(`Layout "${layout.name}" has no fields`);
  }
  for (const field of layout.fields) {
    const size = FIELD_TYPE_BYTES[field.type];
    if (size === undefined) {
      throw new Error(`Layout "${layout.name}": field "${field.name}" has unknown type "${field.type}"`);
    }
    if (field.offset < 0 || field.offset + size > layout.strideInBytes) {
      throw new Error(
        `Layout "${layout.name}": field "${field.name}" (${field.type}) at offset ${field.offset} ` +
          `overflows stride ${layout.strideInBytes}`,
      );
    }
  }
}

/** FNV-1a 32-bit — contrato de verificação e2e (mesma referência do leitor C#). */
export function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
