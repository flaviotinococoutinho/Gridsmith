import os from "node:os";
import path from "node:path";

export const DEFAULT_PIPE_NAME = "gridsmith-engine";

/**
 * Resolve o nome lógico do canal para o endpoint físico da plataforma:
 * - Windows: Named Pipe `\\.\pipe\<nome>`
 * - Linux/macOS: Unix Domain Socket em `$XDG_RUNTIME_DIR` (ou tmpdir)
 *
 * O mesmo nome lógico é passado à engine, que aplica a mesma regra —
 * os dois lados convergem para o mesmo endpoint sem configuração extra.
 */
export function resolvePipePath(pipeName: string = DEFAULT_PIPE_NAME): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${pipeName}`;
  }
  const runtimeDir = process.env["XDG_RUNTIME_DIR"] ?? os.tmpdir();
  return path.join(runtimeDir, `${pipeName}.sock`);
}
