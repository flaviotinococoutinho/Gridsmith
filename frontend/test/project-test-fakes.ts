/**
 * Fakes de sistema de arquivos para os testes de escrita durável (etapa E1).
 *
 * A porta injetável é o que permite provar durabilidade sem tocar disco real:
 * o fake registra a ORDEM das operações (write → flush → close → rename) e
 * sabe falhar em pontos escolhidos, que é como se testa que uma interrupção
 * jamais deixa o projeto do usuário truncado.
 */

import path from "node:path";
import type {
  DurableWriteHandle,
  ProjectFileStat,
  ProjectFileSystemPort,
} from "../src/main/project/ProjectFileService.js";

export class MemoryProjectFileSystem implements ProjectFileSystemPort {
  readonly files = new Map<string, { content: string; modifiedAtMs: number }>();
  readonly operations: string[] = [];
  failReplaceDestination: string | undefined;
  failRemovePath: string | undefined;
  private clock = 1;

  seed(filePath: string, content: string, modifiedAtMs = this.clock++): void {
    this.files.set(this.normalize(filePath), { content, modifiedAtMs });
  }

  content(filePath: string): string | undefined {
    return this.files.get(this.normalize(filePath))?.content;
  }

  async readText(filePath: string): Promise<string> {
    const entry = this.files.get(this.normalize(filePath));
    if (!entry) throw enoent(filePath);
    this.operations.push(`read:${this.normalize(filePath)}`);
    return entry.content;
  }

  async exists(filePath: string): Promise<boolean> {
    return this.files.has(this.normalize(filePath));
  }

  async stat(filePath: string): Promise<ProjectFileStat> {
    const entry = this.files.get(this.normalize(filePath));
    if (!entry) throw enoent(filePath);
    return { modifiedAtMs: entry.modifiedAtMs, size: Buffer.byteLength(entry.content) };
  }

  async ensureDirectory(directoryPath: string): Promise<void> {
    this.operations.push(`mkdir:${this.normalize(directoryPath)}`);
  }

  async openDurableWrite(filePath: string): Promise<DurableWriteHandle> {
    const normalized = this.normalize(filePath);
    if (this.files.has(normalized)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    this.operations.push(`open:${normalized}`);
    let content = "";
    let closed = false;
    return {
      writeText: async (value) => {
        this.operations.push(`write:${normalized}`);
        content = value;
      },
      flush: async () => {
        this.operations.push(`flush:${normalized}`);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.operations.push(`close:${normalized}`);
        this.files.set(normalized, { content, modifiedAtMs: this.clock++ });
      },
    };
  }

  async replaceFile(tempPath: string, destinationPath: string): Promise<void> {
    const source = this.normalize(tempPath);
    const destination = this.normalize(destinationPath);
    this.operations.push(`replace:${source}->${destination}`);
    if (this.failReplaceDestination === destination) throw new Error("fault injected at replace");
    const entry = this.files.get(source);
    if (!entry) throw enoent(source);
    this.files.set(destination, { ...entry, modifiedAtMs: this.clock++ });
    this.files.delete(source);
  }

  async publishNewFile(tempPath: string, destinationPath: string): Promise<void> {
    const source = this.normalize(tempPath);
    const destination = this.normalize(destinationPath);
    this.operations.push(`publish-new:${source}->${destination}`);
    if (this.files.has(destination)) {
      throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
    }
    const entry = this.files.get(source);
    if (!entry) throw enoent(source);
    this.files.set(destination, { ...entry, modifiedAtMs: this.clock++ });
    this.files.delete(source);
  }

  async removeFile(filePath: string): Promise<void> {
    const normalized = this.normalize(filePath);
    this.operations.push(`remove:${normalized}`);
    if (this.failRemovePath === normalized) throw new Error("fault injected at remove");
    this.files.delete(normalized);
  }

  async canonicalPath(filePath: string): Promise<string> {
    return this.normalize(filePath);
  }

  async flushDirectory(directoryPath: string): Promise<void> {
    this.operations.push(`flushdir:${this.normalize(directoryPath)}`);
  }

  private normalize(filePath: string): string {
    return path.resolve("/", filePath);
  }
}
