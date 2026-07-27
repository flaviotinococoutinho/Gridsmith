import fs from "node:fs/promises";
import path from "node:path";
import type {
  DurableWriteHandle,
  ProjectFileStat,
  ProjectFileSystemPort,
} from "./ProjectFileService.js";

export class NodeProjectFileSystem implements ProjectFileSystemPort {
  async readText(filePath: string): Promise<string> {
    await this.recoverInterruptedReplace(filePath);
    return fs.readFile(filePath, "utf8");
  }

  async exists(filePath: string): Promise<boolean> {
    await this.recoverInterruptedReplace(filePath);
    return this.rawExists(filePath);
  }

  private async rawExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async stat(filePath: string): Promise<ProjectFileStat> {
    await this.recoverInterruptedReplace(filePath);
    const result = await fs.stat(filePath);
    return { modifiedAtMs: result.mtimeMs, size: result.size };
  }

  async ensureDirectory(directoryPath: string): Promise<void> {
    await fs.mkdir(directoryPath, { recursive: true });
  }

  async openDurableWrite(filePath: string): Promise<DurableWriteHandle> {
    const handle = await fs.open(filePath, "wx", 0o600);
    return {
      writeText: async (content) => {
        await handle.writeFile(content, "utf8");
      },
      flush: async () => {
        await handle.sync();
      },
      close: async () => {
        await handle.close();
      },
    };
  }

  async replaceFile(tempPath: string, destinationPath: string): Promise<void> {
    await this.recoverInterruptedReplace(destinationPath);
    try {
      await fs.rename(tempPath, destinationPath);
      return;
    } catch (error) {
      if (!(await this.rawExists(destinationPath)) || !isReplaceCollision(error)) throw error;
    }

    // Windows pode recusar rename sobre um destino existente. Mantemos os
    // bytes válidos num swap no mesmo diretório até o novo rename concluir.
    const swapPath = `${destinationPath}.replace-swap`;
    if (await this.rawExists(swapPath)) await fs.unlink(swapPath);
    await fs.rename(destinationPath, swapPath);
    try {
      await fs.rename(tempPath, destinationPath);
      await fs.unlink(swapPath);
    } catch (error) {
      if (!(await this.rawExists(destinationPath)) && await this.rawExists(swapPath)) {
        await fs.rename(swapPath, destinationPath);
      }
      throw error;
    }
  }

  async publishNewFile(tempPath: string, destinationPath: string): Promise<void> {
    // hard-link publica todos os bytes de uma vez e falha com EEXIST; ao
    // contrário de rename/copy, nunca sobrescreve nem expõe conteúdo parcial.
    await fs.link(tempPath, destinationPath);
    await fs.unlink(tempPath);
  }

  async removeFile(filePath: string): Promise<void> {
    await this.recoverInterruptedReplace(filePath);
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async canonicalPath(filePath: string): Promise<string> {
    const absolute = path.resolve(filePath);
    await this.recoverInterruptedReplace(absolute);
    try {
      return await fs.realpath(absolute);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const directory = await fs.realpath(path.dirname(absolute)).catch(() => path.dirname(absolute));
      return path.join(directory, path.basename(absolute));
    }
  }

  async flushDirectory(directoryPath: string): Promise<void> {
    // fsync de diretório dá durabilidade ao rename em POSIX; Windows não
    // oferece a mesma operação e pode retornar EINVAL/EPERM.
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(directoryPath, "r");
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" && code !== "EINVAL" && code !== "EPERM") throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async recoverInterruptedReplace(destinationPath: string): Promise<void> {
    if (destinationPath.endsWith(".replace-swap")) return;
    const swapPath = `${destinationPath}.replace-swap`;
    if (!(await this.rawExists(swapPath))) return;
    if (await this.rawExists(destinationPath)) {
      // Crash após publicar o novo destino e antes de apagar o swap.
      await fs.unlink(swapPath);
      return;
    }
    // Crash entre destino→swap e temp→dest: restaura a última versão válida.
    await fs.rename(swapPath, destinationPath);
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isReplaceCollision(error: unknown): boolean {
  return ["EEXIST", "EPERM", "EACCES", "ENOTEMPTY"].includes(
    (error as NodeJS.ErrnoException)?.code ?? "",
  );
}
