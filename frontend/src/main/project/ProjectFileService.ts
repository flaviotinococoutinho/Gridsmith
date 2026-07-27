import path from "node:path";

export interface DurableWriteHandle {
  writeText(content: string): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface ProjectFileStat {
  readonly modifiedAtMs: number;
  readonly size: number;
}

/** Porta mínima; o adapter Node e os fakes de falha implementam a mesma API. */
export interface ProjectFileSystemPort {
  readText(filePath: string): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  stat(filePath: string): Promise<ProjectFileStat>;
  ensureDirectory(directoryPath: string): Promise<void>;
  openDurableWrite(filePath: string): Promise<DurableWriteHandle>;
  publishNewFile(tempPath: string, destinationPath: string): Promise<void>;
  replaceFile(tempPath: string, destinationPath: string): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  canonicalPath(filePath: string): Promise<string>;
  flushDirectory(directoryPath: string): Promise<void>;
}

export interface RecoveryCandidate {
  readonly filePath: string;
  readonly autosavePath: string;
  readonly autosaveModifiedAtMs: number;
  readonly originalModifiedAtMs?: number;
}

export class ProjectFileService {
  constructor(
    private readonly fileSystem: ProjectFileSystemPort,
    private readonly createId: () => string,
  ) {}

  async readDocument(filePath: string): Promise<unknown> {
    const content = await this.fileSystem.readText(filePath);
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(
        `Projeto inválido em "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async writeProject(filePath: string, document: unknown): Promise<void> {
    await this.atomicWrite(filePath, serializeProjectDocument(document), "replace-with-backup");
  }

  /** Persistência auxiliar durável (ex.: lista de recentes), fora do Blueprint. */
  async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await this.atomicWrite(filePath, serializeJson(value), "replace-with-backup");
  }

  /** Publicação exclusiva para New: falha se o destino apareceu após o diálogo. */
  async createProject(filePath: string, document: unknown): Promise<void> {
    await this.atomicWrite(filePath, serializeProjectDocument(document), "create-exclusive");
  }

  async writeAutosave(filePath: string, document: unknown): Promise<void> {
    await this.atomicWrite(
      this.autosavePath(filePath),
      serializeProjectDocument(document),
      "replace",
    );
  }

  async detectRecovery(filePath: string): Promise<RecoveryCandidate | undefined> {
    const autosavePath = this.autosavePath(filePath);
    if (!(await this.fileSystem.exists(autosavePath))) return undefined;
    const autosave = await this.fileSystem.stat(autosavePath);
    let original: ProjectFileStat | undefined;
    if (await this.fileSystem.exists(filePath)) original = await this.fileSystem.stat(filePath);
    if (original && autosave.modifiedAtMs <= original.modifiedAtMs) return undefined;
    return Object.freeze({
      filePath,
      autosavePath,
      autosaveModifiedAtMs: autosave.modifiedAtMs,
      ...(original ? { originalModifiedAtMs: original.modifiedAtMs } : {}),
    });
  }

  readAutosave(filePath: string): Promise<unknown> {
    return this.readDocument(this.autosavePath(filePath));
  }

  async discardAutosave(filePath: string): Promise<void> {
    const autosavePath = this.autosavePath(filePath);
    if (await this.fileSystem.exists(autosavePath)) {
      await this.fileSystem.removeFile(autosavePath);
    }
  }

  autosavePath(filePath: string): string {
    return `${filePath}.autosave`;
  }

  backupPath(filePath: string): string {
    return `${filePath}.bak`;
  }

  canonicalPath(filePath: string): Promise<string> {
    return this.fileSystem.canonicalPath(filePath);
  }

  exists(filePath: string): Promise<boolean> {
    return this.fileSystem.exists(filePath);
  }

  removeFile(filePath: string): Promise<void> {
    return this.fileSystem.removeFile(filePath);
  }

  private async atomicWrite(
    destinationPath: string,
    content: string,
    mode: "create-exclusive" | "replace" | "replace-with-backup",
  ): Promise<void> {
    const directory = path.dirname(destinationPath);
    await this.fileSystem.ensureDirectory(directory);
    const tempPath = path.join(
      directory,
      `.${path.basename(destinationPath)}.${this.createId()}.tmp`,
    );
    let tempExists = false;
    try {
      await this.writeDurably(tempPath, content);
      tempExists = true;

      if (mode === "replace-with-backup" && await this.fileSystem.exists(destinationPath)) {
        const previous = await this.fileSystem.readText(destinationPath);
        const backupPath = this.backupPath(destinationPath);
        const backupTemp = path.join(
          directory,
          `.${path.basename(backupPath)}.${this.createId()}.tmp`,
        );
        let backupTempExists = false;
        try {
          await this.writeDurably(backupTemp, previous);
          backupTempExists = true;
          await this.fileSystem.replaceFile(backupTemp, backupPath);
          backupTempExists = false;
        } finally {
          if (backupTempExists) await this.removeBestEffort(backupTemp);
        }
      }

      // O único ponto que publica o documento: New usa criação no-clobber;
      // Save usa replace no mesmo diretório, nunca truncamento do destino.
      if (mode === "create-exclusive") {
        await this.fileSystem.publishNewFile(tempPath, destinationPath);
      } else {
        await this.fileSystem.replaceFile(tempPath, destinationPath);
      }
      tempExists = false;
      await this.fileSystem.flushDirectory(directory);
    } finally {
      if (tempExists) await this.removeBestEffort(tempPath);
    }
  }

  private async writeDurably(filePath: string, content: string): Promise<void> {
    const handle = await this.fileSystem.openDurableWrite(filePath);
    let closed = false;
    try {
      await handle.writeText(content);
      await handle.flush();
      await handle.close();
      closed = true;
    } finally {
      if (!closed) await handle.close().catch(() => undefined);
    }
  }

  private async removeBestEffort(filePath: string): Promise<void> {
    await this.fileSystem.removeFile(filePath).catch(() => undefined);
  }
}

function serializeProjectDocument(document: unknown): string {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("O documento de projeto precisa ser um objeto Blueprint completo");
  }
  const record = document as Record<string, unknown>;
  // Guarda mínima contra gravar lixo por cima do projeto do usuário: identidade,
  // versão e câmera. NÃO exige `metadata` — é campo do documento v3, que chega
  // com a etapa do bump; exigi-lo aqui recusaria salvar todo documento válido
  // de hoje.
  if (
    !Number.isInteger(record["schemaVersion"]) ||
    typeof record["projectId"] !== "string" ||
    !record["projectId"].trim() ||
    !record["camera"] ||
    typeof record["camera"] !== "object" ||
    Array.isArray(record["camera"])
  ) {
    throw new Error("O documento de projeto não contém identidade, versão ou câmera válidas");
  }
  for (const field of [
    "skeletons",
    "meshes",
    "lights",
    "entityDefs",
    "entities",
    "levels",
    "placements",
  ]) {
    if (!Array.isArray(record[field])) {
      throw new Error(`O documento de projeto não contém o domínio "${field}"`);
    }
  }
  return serializeJson(document);
}

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") throw new Error("O valor não pode ser serializado como JSON");
  return `${serialized}\n`;
}
