import os from "node:os";
import path from "node:path";

/**
 * Resolve o nome lógico do mapa (`sharedMemoryMapName`) para o arquivo físico,
 * com a mesma regra do leitor C# (engine/src/P7m.Engine.Core/SharedMemory/SharedMemoryPath.cs).
 */
export function resolveSharedMemoryPath(mapName: string): string {
  const runtimeDir = process.platform !== "win32" ? process.env["XDG_RUNTIME_DIR"] : undefined;
  const baseDir = runtimeDir && runtimeDir.length > 0 ? runtimeDir : os.tmpdir();
  return path.join(baseDir, `${mapName}.mmap`);
}
