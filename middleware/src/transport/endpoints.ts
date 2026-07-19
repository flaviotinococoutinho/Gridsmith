/**
 * Resolução dos endpoints físicos dos transports do editor (GraphQL e gRPC),
 * espelhando a convenção do plano de controle (PipeEndpoint):
 *
 *   POSIX   → Unix Domain Socket em `$XDG_RUNTIME_DIR/<pipe>-<transport>.sock`
 *   Windows → `127.0.0.1:<porta determinística derivada do nome>` (o grpc-js
 *             não suporta named pipes; a porta deriva de um hash FNV-1a do
 *             nome, na faixa dinâmica 49152–65535 — determinística e
 *             documentada em contracts/grpc/p7m_editor.proto)
 *
 * Puro: só monta strings a partir de env/os — sem abrir sockets aqui.
 */

import os from "node:os";
import path from "node:path";

export type EditorTransportKind = "graphql" | "grpc";

function fnv1aString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Porta determinística na faixa dinâmica (49152–65535) para Windows. */
export function derivedPort(pipeName: string, transport: EditorTransportKind): number {
  const span = 65535 - 49152;
  return 49152 + (fnv1aString(`${pipeName}-${transport}`) % span);
}

export interface TransportEndpoint {
  /** "uds" (POSIX) ou "tcp" (Windows). */
  readonly family: "uds" | "tcp";
  /** Caminho do socket (uds) ou host (tcp). */
  readonly address: string;
  /** Porta (apenas tcp). */
  readonly port?: number;
  /** Alvo no formato aceito pelo grpc-js (`unix:<path>` ou `host:port`). */
  readonly grpcTarget: string;
}

export function resolveTransportEndpoint(
  pipeName: string,
  transport: EditorTransportKind,
  platform: NodeJS.Platform = process.platform,
): TransportEndpoint {
  if (platform === "win32") {
    const port = derivedPort(pipeName, transport);
    return { family: "tcp", address: "127.0.0.1", port, grpcTarget: `127.0.0.1:${port}` };
  }
  const dir = process.env["XDG_RUNTIME_DIR"] ?? os.tmpdir();
  const socketPath = path.join(dir, `${pipeName}-${transport}.sock`);
  return { family: "uds", address: socketPath, grpcTarget: `unix:${socketPath}` };
}
