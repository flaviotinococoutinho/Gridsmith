/**
 * Resolução dos endpoints físicos dos transports do editor (GraphQL e gRPC),
 * espelhando a convenção do plano de controle (PipeEndpoint):
 *
 *   POSIX   → Unix Domain Socket em `$XDG_RUNTIME_DIR/<pipe>-<transport>.sock`
 *   Windows → `127.0.0.1:<porta determinística derivada do nome>` (o grpc-js
 *             não suporta named pipes; a porta deriva de um hash FNV-1a do
 *             nome, na faixa dinâmica 49152–65535 — determinística e
 *             documentada em contracts/grpc/gridsmith_editor.proto)
 *
 * A resolução é determinística. Helpers adjacentes impõem as invariantes de
 * bind: nome lógico seguro, TCP somente em loopback, colisão explícita e UDS
 * acessível apenas pelo usuário corrente.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Gateways dependem apenas desta fachada de policy. A implementação que toca
// `node:net` permanece na borda ipc/ para preservar R6/R12.
export {
  prepareTransportEndpoint,
  removeOwnedUnixSocket,
} from "../ipc/UnixSocketLifecycle.js";

export type EditorTransportKind = "graphql" | "grpc";

const MIN_DYNAMIC_PORT = 49152;
const MAX_DYNAMIC_PORT = 65535;
const MAX_PIPE_NAME_CHARS = 80;
const SAFE_PIPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function validatePipeName(pipeName: string): string {
  if (
    pipeName.length === 0 ||
    pipeName.length > MAX_PIPE_NAME_CHARS ||
    !SAFE_PIPE_NAME.test(pipeName)
  ) {
    throw new TypeError(
      `pipeName must be 1-${MAX_PIPE_NAME_CHARS} characters using only letters, digits, dot, underscore or dash`,
    );
  }
  return pipeName;
}

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
  validatePipeName(pipeName);
  // Faixas disjuntas eliminam colisão GraphQL↔gRPC da MESMA instância por
  // construção. Colisões entre pipeNames continuam detectadas pelo bind.
  const fullSpan = MAX_DYNAMIC_PORT - MIN_DYNAMIC_PORT + 1;
  const transportSpan = fullSpan / 2;
  const transportBase =
    transport === "graphql" ? MIN_DYNAMIC_PORT : MIN_DYNAMIC_PORT + transportSpan;
  return transportBase + (fnv1aString(pipeName) % transportSpan);
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
  validatePipeName(pipeName);
  if (platform === "win32") {
    const port = derivedPort(pipeName, transport);
    return { family: "tcp", address: "127.0.0.1", port, grpcTarget: `127.0.0.1:${port}` };
  }
  const dir = process.env["XDG_RUNTIME_DIR"] ?? os.tmpdir();
  const socketPath = path.join(dir, `${pipeName}-${transport}.sock`);
  return { family: "uds", address: socketPath, grpcTarget: `unix:${socketPath}` };
}

export class TransportEndpointCollisionError extends Error {
  readonly code = "GRIDSMITH_ENDPOINT_COLLISION";

  constructor(
    readonly endpoint: TransportEndpoint,
    options?: ErrorOptions,
  ) {
    super(
      endpoint.family === "tcp"
        ? `editor transport endpoint already in use at ${endpoint.address}:${endpoint.port}`
        : `editor transport endpoint already in use at ${endpoint.address}`,
      options,
    );
    this.name = "TransportEndpointCollisionError";
  }
}

/** Reconhece EADDRINUSE mesmo quando grpc-js o encapsula apenas na mensagem. */
export function isAddressInUseError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  if (candidate?.code === "EADDRINUSE") return true;
  if (
    typeof candidate?.message === "string" &&
    /EADDRINUSE|address already in use|endpoint already in use/iu.test(candidate.message)
  ) {
    return true;
  }
  return candidate?.cause !== undefined && isAddressInUseError(candidate.cause);
}

/** Preserva erros normais e torna colisão uma condição operacional tipada. */
export function normalizeEndpointListenError(
  endpoint: TransportEndpoint,
  error: unknown,
): Error {
  if (isAddressInUseError(error)) {
    return new TransportEndpointCollisionError(endpoint, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Defesa em profundidade: nenhum endpoint TCP pode escapar do loopback. */
export function assertLoopbackEndpoint(endpoint: TransportEndpoint): void {
  if (endpoint.family === "tcp" && endpoint.address !== "127.0.0.1") {
    throw new Error(`TCP editor transport must bind to 127.0.0.1 (got ${endpoint.address})`);
  }
}

/**
 * Aplica e verifica 0600 depois do bind de um UDS. Gateways devem chamar este
 * helper ainda dentro de listen(), antes de anunciar prontidão.
 */
export interface UnixSocketFileSystem {
  lstatSync(path: string): { isSocket(): boolean; uid: number; mode: number };
  chmodSync(path: string, mode: number): void;
}

export function restrictUnixSocketPermissions(
  endpoint: TransportEndpoint,
  fileSystem: UnixSocketFileSystem = fs,
): void {
  if (endpoint.family !== "uds") return;
  const before = fileSystem.lstatSync(endpoint.address);
  if (!before.isSocket()) {
    throw new Error(`refusing to chmod non-socket transport path ${endpoint.address}`);
  }
  const getuid = process.getuid;
  if (typeof getuid === "function" && before.uid !== getuid()) {
    throw new Error(`refusing to chmod transport socket not owned by current user`);
  }
  fileSystem.chmodSync(endpoint.address, 0o600);
  const mode = fileSystem.lstatSync(endpoint.address).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`editor transport socket permissions must be 0600`);
  }
}
