/**
 * FNV-1a 32-bit — contrato de verificação do ecossistema (mesma referência
 * do leitor C#; ver contracts/shared-memory-layout.md). Módulo utilitário
 * PURO: pode ser importado por qualquer camada sem violar a governança.
 */
export function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
