/** Ciclo de vida defensivo de Unix Domain Sockets na borda IPC. */

import fs from "node:fs";
import net from "node:net";

interface LocalEndpoint {
  readonly family: "uds" | "tcp";
  readonly address: string;
  readonly port?: number;
  readonly grpcTarget: string;
}

function endpointCollisionError(endpoint: LocalEndpoint): Error {
  const target = endpoint.family === "tcp"
    ? `${endpoint.address}:${endpoint.port}`
    : endpoint.address;
  return Object.assign(new Error(`editor transport endpoint already in use at ${target}`), {
    name: "TransportEndpointCollisionError",
    code: "P7M_ENDPOINT_COLLISION",
  });
}

function assertOwnedSocket(endpoint: LocalEndpoint, stat: fs.Stats): void {
  if (!stat.isSocket()) {
    throw new Error(`refusing to replace non-socket transport path ${endpoint.address}`);
  }
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid()) {
    throw new Error("refusing to replace transport socket not owned by current user");
  }
}

function lstatIfPresent(socketPath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Um UDS existente só é removido quando é socket do usuário corrente e uma
 * conexão prova que ele está órfão (`ECONNREFUSED`). Tipo, dono e inode são
 * revalidados antes do unlink para reduzir a janela TOCTOU.
 */
export async function prepareTransportEndpoint(endpoint: LocalEndpoint): Promise<void> {
  if (endpoint.family === "tcp" && endpoint.address !== "127.0.0.1") {
    throw new Error(`TCP editor transport must bind to 127.0.0.1 (got ${endpoint.address})`);
  }
  if (endpoint.family !== "uds") return;
  await prepareUnixSocketPath(endpoint.address, () => endpointCollisionError(endpoint));
}

export async function prepareUnixSocketPath(
  socketPath: string,
  collision: () => Error = () => Object.assign(new Error(`endpoint already in use at ${socketPath}`), {
    code: "P7M_ENDPOINT_COLLISION",
  }),
): Promise<void> {
  const endpoint: LocalEndpoint = { family: "uds", address: socketPath, grpcTarget: `unix:${socketPath}` };

  const initial = lstatIfPresent(socketPath);
  if (!initial) return;
  assertOwnedSocket(endpoint, initial);

  const probeError = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(undefined);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error);
    });
  });
  if (!probeError) throw collision();
  if (probeError.code !== "ECONNREFUSED" && probeError.code !== "ENOENT") {
    throw probeError;
  }

  const current = lstatIfPresent(socketPath);
  if (!current) return;
  assertOwnedSocket(endpoint, current);
  if (current.dev !== initial.dev || current.ino !== initial.ino) {
    throw collision();
  }
  fs.unlinkSync(socketPath);
}

/** Remove somente o UDS criado pelo usuário corrente; nunca segue symlink. */
export function removeOwnedUnixSocket(endpoint: LocalEndpoint): void {
  if (endpoint.family !== "uds") return;
  removeOwnedUnixSocketPath(endpoint.address);
}

export function removeOwnedUnixSocketPath(socketPath: string): void {
  const stat = lstatIfPresent(socketPath);
  if (!stat) return;
  const endpoint: LocalEndpoint = { family: "uds", address: socketPath, grpcTarget: `unix:${socketPath}` };
  assertOwnedSocket(endpoint, stat);
  fs.unlinkSync(socketPath);
}

export function restrictUnixSocketPathPermissions(socketPath: string): void {
  const stat = fs.lstatSync(socketPath);
  const endpoint: LocalEndpoint = { family: "uds", address: socketPath, grpcTarget: `unix:${socketPath}` };
  assertOwnedSocket(endpoint, stat);
  fs.chmodSync(socketPath, 0o600);
  if ((fs.lstatSync(socketPath).mode & 0o777) !== 0o600) {
    throw new Error(`local socket permissions must be 0600 at ${socketPath}`);
  }
}
