/**
 * Camada de aplicacao do catalogo de assets.
 *
 * O pipeline continua responsavel por ferramentas/normalizacao; este servico
 * adiciona identidade de projeto, operacoes cancelaveis, progresso, facetas,
 * configuracao privada e revelacao de caminhos. Nenhuma operacao daqui cria
 * BlueprintEvent ou entrada no CommandHistory.
 */

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ArtifactEnvelope, ArtifactStore } from "../canonical/ArtifactStore.js";
import type {
  EditorApplicationEvent,
  EditorApplicationEventKind,
  EditorApplicationProgress,
  EditorApplicationSeverity,
} from "../canonical/EditorApplicationEvent.js";
import {
  ProjectNotOpenError,
  type ProjectSession,
  type ProjectSessionChangedEvent,
  type ProjectSessionManager,
} from "../canonical/ProjectSessionManager.js";
import type {
  AnimationClip,
  SpriteDocument,
  SpriteFrame,
  SpriteSlice,
} from "../assets/AsepriteImporter.js";
import {
  AssetPipelineCancelledError,
  AssetPipelineService,
  AssetToolError,
  type AssetIngestCandidate,
  type AssetIngestProgress,
  type AssetToolDetection,
  type AssetToolPaths,
} from "../assets/AssetPipelineService.js";

const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_FINISHED_OPERATIONS = 1_024;

export type AssetOperation =
  | "import"
  | "reimport"
  | "remove"
  | "configure-tools"
  | "reveal-source"
  | "reveal-output";

export interface ImportAssetRequest {
  readonly sourcePath: string;
  /** Diretorio relativo a assetsRoot. Caminhos absolutos/traversal sao recusados. */
  readonly targetDirectory?: string;
  readonly tags?: readonly string[];
  readonly operationId?: string;
}

export interface AssetCatalogFilter {
  readonly search?: string;
  readonly tags?: readonly string[];
  readonly directory?: string;
  /** Aliases temporarios para consumidores anteriores. */
  readonly query?: string;
  readonly tag?: string;
}

export interface AssetPaths {
  /** Alias compatível para a origem escolhida pelo usuario. */
  readonly source: string;
  readonly originSource: string;
  readonly managedSource: string;
  readonly spritesheet: string;
  readonly metadata: string;
  readonly compiled: string;
  readonly outputDirectory: string;
}

export interface AssetSummary {
  readonly assetId: string;
  readonly kind: "sprite-document";
  readonly name: string;
  readonly directory: string;
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly clipCount: number;
  readonly paths: AssetPaths;
  readonly sourcePath: string;
  readonly thumbnailPath: string;
  readonly spritesheetPng: string;
  readonly compiledXnb: string;
  readonly importedAt: number;
  readonly updatedAt: number;
  readonly thumbnailDataUrl?: string;
}

export interface AssetFrameTag {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly direction: AnimationClip["direction"];
}

export interface AssetDetails extends AssetSummary {
  readonly frames: readonly SpriteFrame[];
  readonly clips: readonly AnimationClip[];
  readonly slices: readonly SpriteSlice[];
  readonly frameTags: readonly AssetFrameTag[];
  readonly payload: SpriteDocument;
}

export interface AssetCatalogResult {
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly assets: readonly AssetSummary[];
  readonly tags: readonly string[];
  readonly directories: readonly string[];
}

export interface AssetOperationResult {
  readonly operationId: string;
  readonly operation: "import" | "reimport";
  readonly status: "running";
  readonly projectSessionId: string;
  readonly projectId: string;
  readonly assetId?: string;
}

export interface AssetRemoveResult {
  readonly operationId: string;
  readonly removed: true;
  readonly asset: AssetSummary;
  /** Remove e logico: fonte e saidas permanecem recuperaveis. */
  readonly filesPreserved: true;
}

export interface ConfigureAssetToolsRequest {
  readonly scope: "project" | "user";
  readonly asepritePath?: string;
  readonly mgcbPath?: string;
}

export interface AssetToolConfiguration {
  readonly scope: "project" | "user";
  readonly projectId: string;
  readonly asepritePath: string;
  readonly mgcbPath: string;
  readonly aseprite: AssetToolDetection & {
    readonly source: "project" | "user" | "default";
    readonly testedAt: number;
  };
  readonly mgcb: AssetToolDetection & {
    readonly source: "project" | "user" | "default";
    readonly testedAt: number;
  };
  readonly persisted: true;
}

export interface AssetRevealResult {
  readonly operationId: string;
  readonly assetId?: string;
  readonly sourceOperationId?: string;
  readonly target: "source" | "output";
  readonly path: string;
  readonly revealed: true;
}

export type AssetSourceReference =
  | { readonly assetId: string; readonly operationId?: never }
  | { readonly operationId: string; readonly assetId?: never };

export type AssetCancellationResult =
  | { readonly operationId: string; readonly status: "cancellation-requested"; readonly cancelled: true }
  | { readonly operationId: string; readonly status: "already-finished"; readonly cancelled: false }
  | { readonly operationId: string; readonly status: "not-found"; readonly cancelled: false };

export type AssetApplicationErrorCode =
  | "ASSET_INVALID_REQUEST"
  | "ASSET_NOT_FOUND"
  | "ASSET_ALREADY_EXISTS"
  | "ASSET_PATH_OUTSIDE_ROOT"
  | "ASSET_OPERATION_CONFLICT"
  | "ASSET_TOOL_FAILED"
  | "ASSET_REVEAL_FAILED";

export class AssetApplicationError extends Error {
  constructor(
    readonly code: AssetApplicationErrorCode,
    message: string,
    readonly details: {
      readonly stage?: string;
      readonly filePath?: string;
      readonly stderr?: string;
      readonly suggestedActions?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = "AssetApplicationError";
  }
}

export interface AssetPathRevealer {
  reveal(filePath: string): Promise<void>;
}

/** Implementacao sem shell; argumentos nunca sao reinterpretados. */
export class SystemAssetPathRevealer implements AssetPathRevealer {
  reveal(filePath: string): Promise<void> {
    const invocation = process.platform === "win32"
      ? { command: "explorer.exe", args: [`/select,${filePath}`] }
      : process.platform === "darwin"
        ? { command: "open", args: ["-R", filePath] }
        : { command: "xdg-open", args: [path.dirname(filePath)] };
    return new Promise((resolve, reject) => {
      execFile(invocation.command, invocation.args, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export interface AssetToolSettingsAdapter {
  read(scope: "project" | "user", projectId: string): Promise<AssetToolPaths>;
  write(scope: "project" | "user", projectId: string, value: AssetToolPaths): Promise<void>;
}

export interface AssetCatalogManifestRecord {
  readonly asset: Omit<StoredAsset, "thumbnailDataUrl">;
  readonly artifact: ArtifactEnvelope;
}

export interface AssetCatalogManifest {
  readonly version: 1;
  readonly projectId: string;
  readonly assets: readonly AssetCatalogManifestRecord[];
}

export interface AssetCatalogPersistence {
  load(projectId: string): unknown;
  save(projectId: string, manifest: AssetCatalogManifest): Promise<void>;
}

export class MemoryAssetCatalogPersistence implements AssetCatalogPersistence {
  private readonly manifests = new Map<string, AssetCatalogManifest>();

  load(projectId: string): unknown {
    return this.manifests.get(projectId);
  }

  async save(projectId: string, manifest: AssetCatalogManifest): Promise<void> {
    this.manifests.set(projectId, structuredClone(manifest));
  }
}

/** Manifesto por projectId estavel; nunca usa sessionId como chave duravel. */
export class FileAssetCatalogPersistence implements AssetCatalogPersistence {
  constructor(private readonly catalogRoot: string) {}

  load(projectId: string): unknown {
    const filePath = this.filePath(projectId);
    try {
      assertPrivateStateRootSync(this.catalogRoot);
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 16 * 1024 * 1024) {
        throw new AssetApplicationError(
          "ASSET_INVALID_REQUEST",
          `Asset catalog manifest is invalid or too large: ${filePath}`,
        );
      }
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async save(_projectId: string, manifest: AssetCatalogManifest): Promise<void> {
    await writePrivateJsonAtomic(this.catalogRoot, this.filePath(manifest.projectId), manifest);
  }

  private filePath(projectId: string): string {
    const key = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
    return path.join(this.catalogRoot, `project-${key}.json`);
  }
}

export class MemoryAssetToolSettingsAdapter implements AssetToolSettingsAdapter {
  private readonly values = new Map<string, AssetToolPaths>();

  async read(scope: "project" | "user", projectId: string): Promise<AssetToolPaths> {
    return { ...(this.values.get(settingsKey(scope, projectId)) ?? {}) };
  }

  async write(
    scope: "project" | "user",
    projectId: string,
    value: AssetToolPaths,
  ): Promise<void> {
    this.values.set(settingsKey(scope, projectId), Object.freeze({ ...value }));
  }
}

/** Arquivos atomicos privados (0700/0600), fora do documento Blueprint. */
export class FileAssetToolSettingsAdapter implements AssetToolSettingsAdapter {
  constructor(private readonly settingsRoot: string) {}

  async read(scope: "project" | "user", projectId: string): Promise<AssetToolPaths> {
    const filePath = this.filePath(scope, projectId);
    let raw: string;
    try {
      assertPrivateStateRootSync(this.settingsRoot);
      const stats = await fsp.lstat(filePath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 1024 * 1024) {
        throw new AssetApplicationError("ASSET_INVALID_REQUEST", `Invalid tool settings at ${filePath}`);
      }
      raw = await fsp.readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AssetApplicationError("ASSET_INVALID_REQUEST", `Invalid tool settings at ${filePath}`);
    }
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record["asepritePath"] === "string" ? { asepritePath: record["asepritePath"] } : {}),
      ...(typeof record["mgcbPath"] === "string" ? { mgcbPath: record["mgcbPath"] } : {}),
    };
  }

  async write(
    scope: "project" | "user",
    projectId: string,
    value: AssetToolPaths,
  ): Promise<void> {
    const filePath = this.filePath(scope, projectId);
    await writePrivateJsonAtomic(this.settingsRoot, filePath, value);
  }

  private filePath(scope: "project" | "user", projectId: string): string {
    if (scope === "user") return path.join(this.settingsRoot, "user.json");
    const key = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
    return path.join(this.settingsRoot, `project-${key}.json`);
  }
}

export interface AssetApplicationServiceOptions {
  readonly pipeline: AssetPipelineService;
  readonly artifacts: ArtifactStore;
  readonly sessions: ProjectSessionManager;
  readonly settings?: AssetToolSettingsAdapter;
  readonly catalogPersistence?: AssetCatalogPersistence;
  readonly revealer?: AssetPathRevealer;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly maxThumbnailBytes?: number;
}

export interface StoredAsset {
  readonly assetId: string;
  readonly artifactId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly clipCount: number;
  readonly paths: AssetPaths;
  readonly importedAt: number;
  readonly thumbnailDataUrl?: string;
}

interface ActiveOperation {
  readonly operationId: string;
  readonly operation: "import" | "reimport";
  readonly session: ProjectSession;
  readonly controller: AbortController;
  progress: EditorApplicationProgress;
}

interface OperationSource {
  readonly projectId: string;
  readonly sourcePath: string;
  readonly assetId: string;
}

interface ResolvedAssetTools extends Required<AssetToolPaths> {
  readonly asepriteSource: "project" | "user" | "default";
  readonly mgcbSource: "project" | "user" | "default";
}

/** Eventos: `event` (EditorApplicationEvent). */
export class AssetApplicationService extends EventEmitter {
  private readonly catalogs = new Map<string, Map<string, StoredAsset>>();
  private readonly operations = new Map<string, ActiveOperation>();
  private readonly busyAssets = new Set<string>();
  private readonly finishedOperations = new Set<string>();
  private readonly operationSources = new Map<string, OperationSource>();
  private readonly projectMutationTails = new Map<string, Promise<void>>();
  private readonly settings: AssetToolSettingsAdapter;
  private readonly catalogPersistence: AssetCatalogPersistence;
  private readonly loadedProjects = new Set<string>();
  private readonly revealer: AssetPathRevealer;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxThumbnailBytes: number;
  private readonly onSessionChanged = (event: ProjectSessionChangedEvent): void => {
    for (const operation of this.operations.values()) {
      if (event.action === "closed" || operation.session.sessionId !== event.projectSessionId) {
        operation.controller.abort();
      }
    }
  };

  constructor(private readonly options: AssetApplicationServiceOptions) {
    super();
    this.settings = options.settings ?? new MemoryAssetToolSettingsAdapter();
    this.catalogPersistence = options.catalogPersistence ?? new FileAssetCatalogPersistence(
      path.join(options.pipeline.outputRoot, ".p7m-state", "catalogs"),
    );
    this.revealer = options.revealer ?? new SystemAssetPathRevealer();
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.maxThumbnailBytes = options.maxThumbnailBytes ?? MAX_THUMBNAIL_BYTES;
    if (!Number.isInteger(this.maxThumbnailBytes) || this.maxThumbnailBytes < 0) {
      throw new RangeError("maxThumbnailBytes must be a non-negative integer");
    }
    options.sessions.on("sessionChanged", this.onSessionChanged);
  }

  assetCatalog(filter: AssetCatalogFilter = {}): AssetCatalogResult {
    const session = this.requireSession();
    const normalized = normalizeCatalogFilter(filter);
    const all = [...this.catalogOf(session.projectId).values()]
      .map((entry) => this.toSummary(entry, session))
      .sort((a, b) => a.assetId.localeCompare(b.assetId));
    const tags = sortedUnique(all.flatMap((entry) => entry.tags));
    const directories = sortedUnique(all.map((entry) => directoryOf(entry.assetId)));
    const assets = all.filter((entry) => matchesFilter(entry, normalized));
    return Object.freeze({
      projectSessionId: session.sessionId,
      projectId: session.projectId,
      assets: Object.freeze(assets),
      tags: Object.freeze(tags),
      directories: Object.freeze(directories),
    });
  }

  assetDetails(assetId: string): AssetDetails {
    const session = this.requireSession();
    const stored = this.requireAsset(session.projectId, validateAssetId(assetId));
    const envelope = this.options.artifacts.get(stored.artifactId, stored.revision);
    if (!envelope) {
      throw new AssetApplicationError(
        "ASSET_NOT_FOUND",
        `Artifact revision ${stored.revision} for "${stored.assetId}" is unavailable`,
      );
    }
    const document = requireSpriteDocument(envelope.payload, stored.assetId);
    return Object.freeze({
      ...this.toSummary(stored, session),
      frames: Object.freeze([...document.frames]),
      clips: Object.freeze([...document.clips]),
      slices: Object.freeze([...document.slices]),
      frameTags: Object.freeze(document.clips.map((clip) => Object.freeze({
        name: clip.name,
        from: clip.from,
        to: clip.to,
        direction: clip.direction,
      }))),
      payload: document,
    });
  }

  importAsset(request: ImportAssetRequest): AssetOperationResult {
    const session = this.requireSession();
    const normalized = normalizeImportRequest(request);
    const validatedOriginSource = validatedSourcePathSync(
      normalized.sourcePath,
      this.options.pipeline.assetsRoot,
    );
    const plannedAssetId = plannedLogicalAssetId(
      validatedOriginSource,
      normalized.targetDirectory,
      this.options.pipeline.assetsRoot,
    );
    const result = this.startOperation("import", session, normalized.operationId, plannedAssetId, async (operation) => {
      const sources = await this.prepareImportSource(normalized, operation);
      const assetId = sources.assetId;
      if (assetId !== plannedAssetId) {
        throw new AssetApplicationError(
          "ASSET_OPERATION_CONFLICT",
          `Asset source changed identity during import (expected ${plannedAssetId}, got ${assetId})`,
        );
      }
      if (this.catalogOf(session.projectId).has(assetId)) {
        throw new AssetApplicationError(
          "ASSET_ALREADY_EXISTS",
          `Asset "${assetId}" already exists; use reimport`,
          { filePath: sources.managedSource, suggestedActions: ["Use reimport for an existing catalog entry"] },
        );
      }
      await this.runPipeline(
        operation,
        sources.managedSource,
        sources.originSource,
        assetId,
        normalizeTags([
          ...directoryOf(assetId).split("/").filter(Boolean),
          ...normalized.tags,
        ]),
      );
    });
    this.rememberOperationSource(
      result.operationId,
      session.projectId,
      validatedOriginSource,
      plannedAssetId,
    );
    return result;
  }

  reimportAsset(assetId: string, operationId?: string): AssetOperationResult {
    const session = this.requireSession();
    const id = validateAssetId(assetId);
    const existing = this.requireAsset(session.projectId, id);
    const result = this.startOperation("reimport", session, operationId, id, async (operation) => {
      const managedSource = await this.refreshManagedSource(existing, operation);
      await this.runPipeline(
        operation,
        managedSource,
        existing.paths.originSource,
        id,
        existing.tags,
      );
    });
    this.rememberOperationSource(
      result.operationId,
      session.projectId,
      existing.paths.originSource,
      id,
    );
    return result;
  }

  async removeAsset(assetId: string): Promise<AssetRemoveResult> {
    const session = this.requireSession();
    const id = validateAssetId(assetId);
    const stored = this.requireAsset(session.projectId, id);
    const reservation = assetReservationKey(session.projectId, id);
    if (this.busyAssets.has(reservation)) {
      throw new AssetApplicationError(
        "ASSET_OPERATION_CONFLICT",
        `Asset "${id}" is being reimported`,
      );
    }
    const operationId = this.uniqueOperationId(undefined);
    this.busyAssets.add(reservation);
    const progress = makeProgress("removing", 0, 1, `Removing ${id} from the catalog`);
    this.emitEvent(session, "asset/operationStarted", operationId, progress, "info", {
      operation: "remove",
      assetId: id,
    });
    try {
      await this.withProjectMutation(session.projectId, async () => {
        const catalog = this.catalogOf(session.projectId);
        const current = this.requireAsset(session.projectId, id);
        const nextCatalog = new Map(catalog);
        nextCatalog.delete(id);
        try {
          await this.persistCatalog(session.projectId, new Map(), nextCatalog);
          if (this.options.sessions.current?.sessionId !== session.sessionId) {
            await this.persistCatalog(session.projectId, new Map(), catalog);
            throw new AssetPipelineCancelledError("completed", current.paths.managedSource);
          }
        } catch (error) {
          throw error;
        }
        this.catalogs.set(session.projectId, nextCatalog);
        this.options.artifacts.retire(current.artifactId);
      });
    } catch (error) {
      this.busyAssets.delete(reservation);
      this.emitFailure(session, operationId, "remove", progress, error, id);
      this.markFinished(operationId);
      throw error;
    }
    const asset = this.toSummary(stored, session);
    const completed = makeProgress("completed", 1, 1, "Asset removed; files were preserved");
    this.busyAssets.delete(reservation);
    this.emitEvent(session, "asset/catalogChanged", operationId, completed, "info", {
      operation: "remove",
      assetId: id,
      filesPreserved: true,
    });
    this.emitEvent(session, "asset/operationCompleted", operationId, completed, "info", {
      operation: "remove",
      assetId: id,
      filesPreserved: true,
    });
    this.markFinished(operationId);
    return Object.freeze({ operationId, removed: true, asset, filesPreserved: true });
  }

  async configureAssetTools(request: ConfigureAssetToolsRequest): Promise<AssetToolConfiguration> {
    const session = this.requireSession();
    const normalized = normalizeToolConfiguration(request);
    const operationId = this.uniqueOperationId(undefined);
    const validating = makeProgress("validating-tools", 0, 2, "Validating configured tools");
    this.emitEvent(session, "asset/operationStarted", operationId, validating, "info", {
      operation: "configure-tools",
      scope: normalized.scope,
    });
    try {
      const current = await this.settings.read(normalized.scope, session.projectId);
      this.assertSessionCurrent(session);
      const overrides: AssetToolPaths = {
        ...current,
        ...(normalized.asepritePath !== undefined ? { asepritePath: normalized.asepritePath } : {}),
        ...(normalized.mgcbPath !== undefined ? { mgcbPath: normalized.mgcbPath } : {}),
      };
      const resolved = await this.resolveTools(session.projectId, normalized.scope, overrides);
      const detection = await this.options.pipeline.validateTools(resolved);
      this.assertSessionCurrent(session);
      await this.settings.write(normalized.scope, session.projectId, overrides);
      this.assertSessionCurrent(session);
      const testedAt = this.now();
      const result = Object.freeze({
        scope: normalized.scope,
        projectId: session.projectId,
        asepritePath: resolved.asepritePath,
        mgcbPath: resolved.mgcbPath,
        aseprite: Object.freeze({
          ...detection.aseprite,
          source: resolved.asepriteSource,
          testedAt,
        }),
        mgcb: Object.freeze({
          ...detection.mgcb,
          source: resolved.mgcbSource,
          testedAt,
        }),
        persisted: true,
      } as const);
      const completed = makeProgress("completed", 2, 2, "Tool configuration validated and saved");
      this.emitEvent(session, "asset/operationCompleted", operationId, completed, "info", {
        operation: "configure-tools",
        configuration: result,
      });
      this.markFinished(operationId);
      return result;
    } catch (error) {
      this.emitFailure(session, operationId, "configure-tools", validating, error);
      this.markFinished(operationId);
      throw enrichApplicationError(error, "validating-tools");
    }
  }

  revealSource(reference: AssetSourceReference): Promise<AssetRevealResult> {
    const session = this.requireSession();
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      throw new AssetApplicationError(
        "ASSET_INVALID_REQUEST",
        "Source reference must contain exactly one of assetId or operationId",
      );
    }
    const hasAsset = typeof reference.assetId === "string";
    const hasOperation = typeof reference.operationId === "string";
    if (hasAsset === hasOperation) {
      throw new AssetApplicationError(
        "ASSET_INVALID_REQUEST",
        "Source reference must contain exactly one of assetId or operationId",
      );
    }
    if (hasAsset) {
      const assetId = validateAssetId(reference.assetId);
      const stored = this.requireAsset(session.projectId, assetId);
      return this.revealPath(stored.paths.originSource, "source", { assetId });
    }
    const sourceOperationId = validateOperationId(reference.operationId);
    const source = this.operationSources.get(sourceOperationId);
    if (!source || source.projectId !== session.projectId) {
      throw new AssetApplicationError(
        "ASSET_NOT_FOUND",
        `No validated source is retained for operation "${sourceOperationId}"`,
      );
    }
    return this.revealPath(source.sourcePath, "source", {
      assetId: source.assetId,
      sourceOperationId,
    });
  }

  revealOutput(assetId: string): Promise<AssetRevealResult> {
    const session = this.requireSession();
    const id = validateAssetId(assetId);
    const stored = this.requireAsset(session.projectId, id);
    return this.revealPath(stored.paths.compiled, "output", { assetId: id });
  }

  cancelAssetOperation(operationId: string): AssetCancellationResult {
    const id = validateOperationId(operationId);
    const operation = this.operations.get(id);
    if (operation) {
      operation.controller.abort();
      return Object.freeze({ operationId: id, status: "cancellation-requested", cancelled: true });
    }
    if (this.finishedOperations.has(id)) {
      return Object.freeze({ operationId: id, status: "already-finished", cancelled: false });
    }
    return Object.freeze({ operationId: id, status: "not-found", cancelled: false });
  }

  /** Watcher tambem entra pela camada de aplicacao; nao ha ingest paralelo. */
  watch(onError?: (error: Error) => void): void {
    this.options.pipeline.watch(onError, async (filePath) => {
      const session = this.options.sessions.current;
      if (!isAsepriteSource(filePath) || !session) return;
      const observedSessionId = session.sessionId;
      const observedProjectId = session.projectId;
      const root = await fsp.realpath(this.options.pipeline.assetsRoot);
      const source = await fsp.realpath(filePath);
      const relative = normalizeDirectory(path.relative(root, source));
      if (relative.startsWith(".p7m-managed/") || relative.startsWith(".p7m-build/")) return;
      const directory = normalizeDirectory(path.posix.dirname(relative));
      const logicalDirectory = directory === "." ? "" : directory;
      const assetId = logicalAssetId(logicalDirectory, source);
      const current = this.options.sessions.current;
      if (
        !current ||
        current.sessionId !== observedSessionId ||
        current.projectId !== observedProjectId
      ) return;
      if (this.catalogOf(observedProjectId).has(assetId)) this.reimportAsset(assetId);
      else this.importAsset({ sourcePath: source });
    });
  }

  close(): void {
    this.options.sessions.off("sessionChanged", this.onSessionChanged);
    for (const operation of this.operations.values()) operation.controller.abort();
    this.options.pipeline.close();
  }

  private startOperation(
    operationKind: "import" | "reimport",
    session: ProjectSession,
    requestedId: string | undefined,
    assetId: string,
    execute: (operation: ActiveOperation) => Promise<void>,
  ): AssetOperationResult {
    const reservation = assetReservationKey(session.projectId, assetId);
    if (this.busyAssets.has(reservation)) {
      throw new AssetApplicationError(
        "ASSET_OPERATION_CONFLICT",
        `Asset "${assetId}" already has an operation in progress`,
      );
    }
    const operationId = this.uniqueOperationId(requestedId);
    const operation: ActiveOperation = {
      operationId,
      operation: operationKind,
      session,
      controller: new AbortController(),
      progress: makeProgress("queued", 0, 100, `${operationKind} queued`),
    };
    this.busyAssets.add(reservation);
    this.operations.set(operationId, operation);
    this.emitEvent(session, "asset/operationStarted", operationId, operation.progress, "info", {
      operation: operationKind,
      assetId,
    });
    void Promise.resolve().then(async () => {
      try {
        await execute(operation);
      } catch (error) {
        this.rollbackArtifactHead(session.projectId, assetId);
        this.finishActiveOperation(operationId, reservation);
        if (operation.controller.signal.aborted || error instanceof AssetPipelineCancelledError) {
          const cancelled = makeProgress(
            "cancelled",
            operation.progress.current,
            operation.progress.total,
            `${operationKind} cancelled`,
          );
          this.emitEvent(session, "asset/operationCancelled", operationId, cancelled, "warning", {
            operation: operationKind,
            assetId,
          });
        } else {
          this.emitFailure(session, operationId, operationKind, operation.progress, error, assetId);
        }
      } finally {
        this.finishActiveOperation(operationId, reservation);
      }
    });
    return Object.freeze({
      operationId,
      operation: operationKind,
      status: "running",
      projectSessionId: session.sessionId,
      projectId: session.projectId,
      assetId,
    });
  }

  private async runPipeline(
    operation: ActiveOperation,
    managedSource: string,
    originSource: string,
    assetId: string,
    tags: readonly string[],
  ): Promise<void> {
    this.assertStillCurrent(operation);
    const tools = await this.resolveTools(operation.session.projectId);
    let stored: StoredAsset | undefined;
    await this.withProjectMutation(operation.session.projectId, async () => {
      let nextCatalog: Map<string, StoredAsset> | undefined;
      let manifestPersisted = false;
      try {
        const result = await this.options.pipeline.ingest(managedSource, {
          signal: operation.controller.signal,
          tags,
          tools,
          deriveTags: false,
          artifactId: artifactIdForProject(operation.session.projectId, assetId),
          originSource,
          onProgress: (progress) => this.reportPipelineProgress(operation, progress, assetId),
          beforePublish: async (candidate) => {
            this.assertStillCurrent(operation);
            const candidateStored = await this.storedAssetFromCandidate(
              operation.session.projectId,
              assetId,
              managedSource,
              originSource,
              candidate,
            );
            nextCatalog = new Map(this.catalogOf(operation.session.projectId));
            nextCatalog.set(assetId, candidateStored);
            await this.persistCatalog(
              operation.session.projectId,
              new Map([[candidate.artifact.artifactId, candidate.artifact]]),
              nextCatalog,
            );
            manifestPersisted = true;
            stored = candidateStored;
          },
        });
        if (result.status === "ignored") {
          throw new AssetApplicationError("ASSET_INVALID_REQUEST", result.reason, {
            filePath: originSource,
            suggestedActions: ["Choose an .ase or .aseprite source"],
          });
        }
        this.assertStillCurrent(operation);
        if (!stored || !nextCatalog) throw new Error(`Pipeline did not stage catalog entry ${assetId}`);
        const committed = this.options.artifacts.get(stored.artifactId, stored.revision);
        if (!committed || committed.contentHash !== stored.contentHash) {
          throw new Error(`Pipeline did not commit artifact revision for ${assetId}`);
        }
        // Leitores observam o catalogo antigo durante todo I/O; a troca e sincrona.
        this.catalogs.set(operation.session.projectId, nextCatalog);
      } catch (error) {
        if (manifestPersisted) {
          try {
            await this.persistCatalog(operation.session.projectId);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              `Asset "${assetId}" failed and its staged catalog manifest could not be rolled back`,
            );
          }
        }
        throw error;
      }
    });
    if (!stored) throw new Error(`Pipeline did not stage catalog entry ${assetId}`);
    const summary = this.toSummary(stored, operation.session);
    const completed = makeProgress("completed", 100, 100, `${operation.operation} completed`);
    operation.progress = completed;
    this.finishActiveOperation(
      operation.operationId,
      assetReservationKey(operation.session.projectId, assetId),
    );
    this.emitEvent(operation.session, "asset/catalogChanged", operation.operationId, completed, "info", {
      operation: operation.operation,
      assetId: summary.assetId,
      revision: summary.revision,
      clipCount: summary.clipCount,
      tags: summary.tags,
    });
    this.emitEvent(operation.session, "asset/operationCompleted", operation.operationId, completed, "info", {
      operation: operation.operation,
      assetId: summary.assetId,
      revision: summary.revision,
      clipCount: summary.clipCount,
      tags: summary.tags,
    });
  }

  private async prepareImportSource(
    request: Required<Pick<ImportAssetRequest, "sourcePath" | "tags">> &
      Pick<ImportAssetRequest, "targetDirectory" | "operationId">,
    operation: ActiveOperation,
  ): Promise<{
    readonly originSource: string;
    readonly managedSource: string;
    readonly assetId: string;
  }> {
    const source = await realFile(request.sourcePath);
    if (!isAsepriteSource(source)) {
      throw new AssetApplicationError(
        "ASSET_INVALID_REQUEST",
        `Unsupported asset extension "${path.extname(source)}"`,
        { filePath: source, suggestedActions: ["Choose an .ase or .aseprite source"] },
      );
    }
    const root = await fsp.realpath(this.options.pipeline.assetsRoot);
    const sourceAlreadyInRoot = isInside(root, source);
    const inferredDirectory = sourceAlreadyInRoot
      ? normalizeDirectory(path.dirname(path.relative(root, source)))
      : "";
    const logicalDirectory = normalizeDirectory(request.targetDirectory ?? inferredDirectory);
    const managedRoot = await safeTargetDirectory(
      root,
      path.posix.join(".p7m-managed", projectStorageKey(operation.session.projectId)),
    );
    const importRoot = await safeTargetDirectory(
      managedRoot,
      path.posix.join("imports", projectStorageKey(operation.operationId)),
    );
    const targetDirectory = await safeTargetDirectory(importRoot, logicalDirectory);
    const destination = path.join(targetDirectory, path.basename(source));
    if (!isInside(root, destination)) {
      throw new AssetApplicationError(
        "ASSET_PATH_OUTSIDE_ROOT",
        "Asset destination escapes assetsRoot",
        { filePath: destination },
      );
    }
    if (source === await realPathOrSelf(destination)) {
      return Object.freeze({
        originSource: source,
        managedSource: source,
        assetId: logicalAssetId(logicalDirectory, source),
      });
    }
    if (await exists(destination)) {
      throw new AssetApplicationError(
        "ASSET_ALREADY_EXISTS",
        `Destination already exists: ${destination}`,
        { filePath: destination, suggestedActions: ["Choose another target directory", "Use reimport"] },
      );
    }

    operation.progress = makeProgress("copying", 5, 100, "Copying source into the project catalog");
    this.emitEvent(
      operation.session,
      "asset/operationProgress",
      operation.operationId,
      operation.progress,
      "info",
      { operation: operation.operation, sourcePath: source, destination },
    );
    const temporary = path.join(targetDirectory, `.${path.basename(source)}.${operation.operationId}.tmp`);
    try {
      await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
      await syncFile(temporary);
      this.assertStillCurrent(operation);
      const verifiedParent = await fsp.realpath(path.dirname(destination));
      if (!isInside(root, verifiedParent)) {
        throw new AssetApplicationError(
          "ASSET_PATH_OUTSIDE_ROOT",
          "Asset destination parent changed outside assetsRoot",
          { filePath: verifiedParent },
        );
      }
      try {
        await fsp.link(temporary, destination);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new AssetApplicationError(
            "ASSET_ALREADY_EXISTS",
            `Managed destination appeared concurrently: ${destination}`,
            { filePath: destination },
          );
        }
        throw error;
      }
      return Object.freeze({
        originSource: source,
        managedSource: await fsp.realpath(destination),
        assetId: logicalAssetId(logicalDirectory, source),
      });
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /** Atualiza a copia gerenciada sem truncar a ultima fonte valida. */
  private async refreshManagedSource(
    asset: StoredAsset,
    operation: ActiveOperation,
  ): Promise<string> {
    const origin = await realFile(asset.paths.originSource);
    const root = await fsp.realpath(this.options.pipeline.assetsRoot);
    const managedRoot = await safeTargetDirectory(
      root,
      path.posix.join(".p7m-managed", projectStorageKey(operation.session.projectId)),
    );
    const importRoot = await safeTargetDirectory(
      managedRoot,
      path.posix.join("imports", projectStorageKey(operation.operationId)),
    );
    const parent = await safeTargetDirectory(importRoot, directoryOf(asset.assetId));
    const managed = path.join(parent, path.basename(origin));
    operation.progress = makeProgress("copying", 5, 100, "Refreshing managed source from origin");
    this.emitEvent(
      operation.session,
      "asset/operationProgress",
      operation.operationId,
      operation.progress,
      "info",
      { operation: operation.operation, assetId: asset.assetId, originSource: origin, managedSource: managed },
    );
    const temporary = path.join(parent, `.${path.basename(managed)}.${operation.operationId}.tmp`);
    try {
      await fsp.copyFile(origin, temporary, fs.constants.COPYFILE_EXCL);
      await syncFile(temporary);
      this.assertStillCurrent(operation);
      const verifiedParent = await fsp.realpath(parent);
      if (!isInside(root, verifiedParent)) {
        throw new AssetApplicationError(
          "ASSET_PATH_OUTSIDE_ROOT",
          "Managed asset parent changed outside assetsRoot",
          { filePath: verifiedParent },
        );
      }
      try {
        await fsp.link(temporary, managed);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new AssetApplicationError(
            "ASSET_OPERATION_CONFLICT",
            `Reimport staging destination already exists: ${managed}`,
            { filePath: managed },
          );
        }
        throw error;
      }
      return await fsp.realpath(managed);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private reportPipelineProgress(
    operation: ActiveOperation,
    progress: AssetIngestProgress,
    assetId: string,
  ): void {
    const current = Math.min(95, 10 + progress.current * 20);
    operation.progress = makeProgress(progress.stage, current, 100, progress.message);
    this.emitEvent(
      operation.session,
      "asset/operationProgress",
      operation.operationId,
      operation.progress,
      "info",
      { operation: operation.operation, assetId },
    );
  }

  private async revealPath(
    targetPath: string,
    target: "source" | "output",
    reference: { readonly assetId?: string; readonly sourceOperationId?: string },
  ): Promise<AssetRevealResult> {
    const session = this.requireSession();
    const operationId = this.uniqueOperationId(undefined);
    const started = makeProgress("revealing", 0, 1, `Revealing ${target}`);
    this.emitEvent(session, "asset/operationStarted", operationId, started, "info", {
      operation: target === "source" ? "reveal-source" : "reveal-output",
      ...reference,
    });
    try {
      await realFile(targetPath);
      this.assertSessionCurrent(session);
      await this.revealer.reveal(targetPath);
      this.assertSessionCurrent(session);
      const completed = makeProgress("completed", 1, 1, `${target} revealed`);
      this.emitEvent(session, "asset/operationCompleted", operationId, completed, "info", {
        operation: target === "source" ? "reveal-source" : "reveal-output",
        ...reference,
        path: targetPath,
      });
      this.markFinished(operationId);
      return Object.freeze({
        operationId,
        ...reference,
        target,
        path: targetPath,
        revealed: true,
      });
    } catch (error) {
      this.emitFailure(
        session,
        operationId,
        target === "source" ? "reveal-source" : "reveal-output",
        started,
        error,
        reference.assetId,
      );
      this.markFinished(operationId);
      throw new AssetApplicationError(
        "ASSET_REVEAL_FAILED",
        `Could not reveal ${target}: ${errorMessage(error)}`,
        { filePath: targetPath, suggestedActions: ["Verify that the generated file still exists"] },
      );
    }
  }

  private async resolveTools(
    projectId: string,
    replacingScope?: "project" | "user",
    replacement?: AssetToolPaths,
  ): Promise<ResolvedAssetTools> {
    const defaults = this.options.pipeline.defaultTools;
    const user = replacingScope === "user" && replacement
      ? replacement
      : await this.settings.read("user", projectId);
    const project = replacingScope === "project" && replacement
      ? replacement
      : await this.settings.read("project", projectId);
    return Object.freeze({
      asepritePath: project.asepritePath ?? user.asepritePath ?? defaults.asepritePath,
      mgcbPath: project.mgcbPath ?? user.mgcbPath ?? defaults.mgcbPath,
      asepriteSource: project.asepritePath !== undefined
        ? "project"
        : user.asepritePath !== undefined ? "user" : "default",
      mgcbSource: project.mgcbPath !== undefined
        ? "project"
        : user.mgcbPath !== undefined ? "user" : "default",
    });
  }

  private assertStillCurrent(operation: ActiveOperation): void {
    if (operation.controller.signal.aborted) {
      throw new AssetPipelineCancelledError("validating", operation.session.projectId);
    }
    const active = this.options.sessions.current;
    if (!active || active.sessionId !== operation.session.sessionId) {
      operation.controller.abort();
      throw new AssetPipelineCancelledError("validating", operation.session.projectId);
    }
  }

  private emitFailure(
    session: ProjectSession,
    operationId: string,
    operation: AssetOperation,
    progress: EditorApplicationProgress,
    error: unknown,
    assetId?: string,
  ): void {
    const enriched = enrichApplicationError(error, progress.phase);
    this.emitEvent(
      session,
      "asset/operationFailed",
      operationId,
      makeProgress("failed", progress.current, progress.total, enriched.message),
      "error",
      {
        operation,
        ...(assetId !== undefined ? { assetId } : {}),
        error: {
          code: enriched.code,
          message: enriched.message,
          ...enriched.details,
        },
      },
    );
  }

  private emitEvent(
    session: ProjectSession,
    kind: EditorApplicationEventKind,
    operationId: string,
    progress: EditorApplicationProgress,
    severity: EditorApplicationSeverity,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const event: EditorApplicationEvent = Object.freeze({
      domain: "asset",
      kind,
      operationId,
      projectSessionId: session.sessionId,
      projectId: session.projectId,
      commandSequence: session.history.lastSequence.toString(),
      progress,
      severity,
      payload: Object.freeze({ ...payload }),
      timestamp: this.now(),
    });
    for (const listener of this.rawListeners("event")) {
      try {
        Reflect.apply(listener, this, [event]);
      } catch {
        // Observadores (journal/UI) nao alteram a operacao.
      }
    }
  }

  private catalogOf(projectId: string): Map<string, StoredAsset> {
    let catalog = this.catalogs.get(projectId);
    if (!catalog) {
      catalog = new Map();
      this.catalogs.set(projectId, catalog);
    }
    if (!this.loadedProjects.has(projectId)) {
      this.loadedProjects.add(projectId);
      try {
        const manifest = parseCatalogManifest(
          this.catalogPersistence.load(projectId),
          projectId,
          this.options.pipeline.assetsRoot,
          this.options.pipeline.outputRoot,
        );
        for (const record of manifest.assets) {
          this.options.artifacts.restore(record.artifact);
          const thumbnailDataUrl = readPngDataUrlSync(
            record.asset.paths.spritesheet,
            this.maxThumbnailBytes,
          );
          catalog.set(record.asset.assetId, Object.freeze({
            ...record.asset,
            ...(thumbnailDataUrl !== undefined ? { thumbnailDataUrl } : {}),
          }));
        }
      } catch (error) {
        this.loadedProjects.delete(projectId);
        throw enrichApplicationError(error, "loading-catalog");
      }
    }
    return catalog;
  }

  private async storedAssetFromCandidate(
    projectId: string,
    assetId: string,
    managedSource: string,
    originSource: string,
    candidate: AssetIngestCandidate,
  ): Promise<StoredAsset> {
    const expectedArtifactId = artifactIdForProject(projectId, assetId);
    if (candidate.artifactId !== expectedArtifactId || candidate.artifact.artifactId !== expectedArtifactId) {
      throw new AssetApplicationError(
        "ASSET_INVALID_REQUEST",
        `Pipeline returned an unexpected artifact id for "${assetId}"`,
      );
    }
    const paths: AssetPaths = Object.freeze({
      source: originSource,
      originSource,
      managedSource,
      spritesheet: candidate.spritesheetPng,
      metadata: candidate.metadataJson,
      compiled: candidate.compiledXnb,
      outputDirectory: path.dirname(candidate.spritesheetPng),
    });
    const thumbnailDataUrl = await readPngDataUrl(candidate.spritesheetPng, this.maxThumbnailBytes);
    return Object.freeze({
      assetId,
      artifactId: candidate.artifactId,
      revision: candidate.revision,
      contentHash: candidate.artifact.contentHash,
      tags: Object.freeze([...candidate.tags]),
      clipCount: candidate.clipCount,
      paths,
      importedAt: this.now(),
      ...(thumbnailDataUrl !== undefined ? { thumbnailDataUrl } : {}),
    });
  }

  private async persistCatalog(
    projectId: string,
    artifactOverrides: ReadonlyMap<string, ArtifactEnvelope> = new Map(),
    catalog: ReadonlyMap<string, StoredAsset> = this.catalogs.get(projectId) ?? new Map(),
  ): Promise<void> {
    const assets: AssetCatalogManifestRecord[] = [];
    for (const asset of catalog.values()) {
      const artifact = artifactOverrides.get(asset.artifactId)
        ?? this.options.artifacts.get(asset.artifactId, asset.revision);
      if (!artifact) {
        throw new AssetApplicationError(
          "ASSET_NOT_FOUND",
          `Cannot persist asset "${asset.assetId}": artifact revision is unavailable`,
        );
      }
      const { thumbnailDataUrl: _thumbnail, ...persisted } = asset;
      assets.push(Object.freeze({ asset: Object.freeze(persisted), artifact }));
    }
    await this.catalogPersistence.save(projectId, Object.freeze({
      version: 1,
      projectId,
      assets: Object.freeze(assets),
    }));
  }

  private requireAsset(projectId: string, assetId: string): StoredAsset {
    const asset = this.catalogOf(projectId).get(assetId);
    if (!asset) throw new AssetApplicationError("ASSET_NOT_FOUND", `Unknown asset "${assetId}"`);
    return asset;
  }

  private toSummary(stored: StoredAsset, session: ProjectSession): AssetSummary {
    const directory = directoryOf(stored.assetId);
    const name = path.posix.basename(stored.assetId);
    return Object.freeze({
      assetId: stored.assetId,
      kind: "sprite-document",
      name,
      directory,
      projectSessionId: session.sessionId,
      projectId: session.projectId,
      revision: stored.revision,
      contentHash: stored.contentHash,
      tags: stored.tags,
      clipCount: stored.clipCount,
      paths: stored.paths,
      sourcePath: stored.paths.originSource,
      thumbnailPath: stored.paths.spritesheet,
      spritesheetPng: stored.paths.spritesheet,
      compiledXnb: stored.paths.compiled,
      importedAt: stored.importedAt,
      updatedAt: stored.importedAt,
      ...(stored.thumbnailDataUrl !== undefined ? { thumbnailDataUrl: stored.thumbnailDataUrl } : {}),
    });
  }

  private requireSession(): ProjectSession {
    const session = this.options.sessions.readCurrent();
    if (!session) throw new ProjectNotOpenError();
    return session;
  }

  private assertSessionCurrent(session: ProjectSession): void {
    const current = this.options.sessions.current;
    if (
      !current ||
      current.sessionId !== session.sessionId ||
      current.projectId !== session.projectId
    ) {
      throw new AssetApplicationError(
        "ASSET_OPERATION_CONFLICT",
        "Project session changed while the asset operation was running",
      );
    }
  }

  private uniqueOperationId(requested: string | undefined): string {
    const id = requested === undefined ? this.createId() : validateOperationId(requested);
    if (this.operations.has(id) || this.finishedOperations.has(id)) {
      throw new AssetApplicationError(
        "ASSET_OPERATION_CONFLICT",
        `Operation id "${id}" was already used`,
      );
    }
    return id;
  }

  private markFinished(operationId: string): void {
    this.finishedOperations.add(operationId);
    while (this.finishedOperations.size > MAX_FINISHED_OPERATIONS) {
      const oldest = this.finishedOperations.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.finishedOperations.delete(oldest);
    }
  }

  private finishActiveOperation(operationId: string, reservation: string): void {
    this.operations.delete(operationId);
    this.busyAssets.delete(reservation);
    this.markFinished(operationId);
  }

  private rememberOperationSource(
    operationId: string,
    projectId: string,
    sourcePath: string,
    assetId: string,
  ): void {
    this.operationSources.set(operationId, Object.freeze({ projectId, sourcePath, assetId }));
    while (this.operationSources.size > MAX_FINISHED_OPERATIONS) {
      const oldest = this.operationSources.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.operationSources.delete(oldest);
    }
  }

  private rollbackArtifactHead(projectId: string, assetId: string): void {
    const artifactId = artifactIdForProject(projectId, assetId);
    const committed = this.catalogs.get(projectId)?.get(assetId);
    if (committed) this.options.artifacts.activate(artifactId, committed.revision);
    else this.options.artifacts.retire(artifactId);
  }

  private withProjectMutation<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectMutationTails.get(projectId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.projectMutationTails.set(projectId, tail);
    void tail.finally(() => {
      if (this.projectMutationTails.get(projectId) === tail) {
        this.projectMutationTails.delete(projectId);
      }
    });
    return result;
  }
}

function normalizeImportRequest(
  request: ImportAssetRequest,
): Required<Pick<ImportAssetRequest, "sourcePath" | "tags">> &
  Pick<ImportAssetRequest, "targetDirectory" | "operationId"> {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", "Import request must be an object");
  }
  if (typeof request.sourcePath !== "string" || request.sourcePath.trim().length === 0) {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", "sourcePath must be non-empty");
  }
  if (request.targetDirectory !== undefined) validateRelativeDirectory(request.targetDirectory);
  const tags = normalizeTags(request.tags ?? []);
  return {
    sourcePath: path.resolve(request.sourcePath),
    tags,
    ...(request.targetDirectory !== undefined ? { targetDirectory: request.targetDirectory } : {}),
    ...(request.operationId !== undefined ? { operationId: validateOperationId(request.operationId) } : {}),
  };
}

function normalizeCatalogFilter(filter: AssetCatalogFilter): {
  search?: string;
  tags: readonly string[];
  directory?: string;
} {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", "Asset catalog filter must be an object");
  }
  const search = filter.search ?? filter.query;
  if (search !== undefined && typeof search !== "string") {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", "search must be a string");
  }
  const tags = normalizeTags([...(filter.tags ?? []), ...(filter.tag ? [filter.tag] : [])]);
  if (filter.directory !== undefined) validateRelativeDirectory(filter.directory);
  return {
    ...(search?.trim() ? { search: search.trim().toLocaleLowerCase() } : {}),
    tags,
    ...(filter.directory !== undefined ? { directory: normalizeDirectory(filter.directory) } : {}),
  };
}

function normalizeToolConfiguration(request: ConfigureAssetToolsRequest): ConfigureAssetToolsRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", "Tool configuration must be an object");
  }
  if (request.scope !== "project" && request.scope !== "user") {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", 'scope must be "project" or "user"');
  }
  return {
    scope: request.scope,
    ...(request.asepritePath !== undefined
      ? { asepritePath: validateToolPath(request.asepritePath, "asepritePath") }
      : {}),
    ...(request.mgcbPath !== undefined
      ? { mgcbPath: validateToolPath(request.mgcbPath, "mgcbPath") }
      : {}),
  };
}

function matchesFilter(
  asset: AssetSummary,
  filter: { search?: string; tags: readonly string[]; directory?: string },
): boolean {
  if (filter.tags.some((tag) => !asset.tags.includes(tag))) return false;
  if (filter.directory !== undefined && directoryOf(asset.assetId) !== filter.directory) return false;
  if (filter.search !== undefined) {
    const haystack = `${asset.assetId}\n${asset.paths.source}\n${asset.tags.join("\n")}`.toLocaleLowerCase();
    if (!haystack.includes(filter.search)) return false;
  }
  return true;
}

function makeProgress(
  phase: string,
  current: number,
  total: number,
  message: string,
): EditorApplicationProgress {
  const percent = total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  return Object.freeze({ phase, current, total, percent, message });
}

function validateOperationId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new AssetApplicationError(
      "ASSET_INVALID_REQUEST",
      "operationId must be non-empty and at most 128 characters",
    );
  }
  return value;
}

function validateAssetId(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", "assetId must be non-empty");
  }
  return value;
}

function validateToolPath(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4_096) {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", `${name} must be non-empty`);
  }
  return value.trim();
}

function validateRelativeDirectory(value: string): void {
  if (typeof value !== "string" || value.length > 1_024 || path.isAbsolute(value)) {
    throw new AssetApplicationError(
      "ASSET_PATH_OUTSIDE_ROOT",
      "target directory must be relative to assetsRoot",
    );
  }
  const normalized = normalizeDirectory(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new AssetApplicationError("ASSET_PATH_OUTSIDE_ROOT", "target directory contains traversal");
  }
}

function normalizeDirectory(value: string): string {
  return value.split(/[\\/]+/u).filter((part) => part && part !== ".").join("/");
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  if (!Array.isArray(tags) || tags.length > 64 || tags.some((tag) => typeof tag !== "string")) {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", "tags must be an array of strings");
  }
  return Object.freeze(sortedUnique(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function directoryOf(assetId: string): string {
  const relative = assetId.startsWith("assets/") ? assetId.slice("assets/".length) : assetId;
  const directory = path.posix.dirname(relative);
  return directory === "." ? "" : directory;
}

function artifactIdForProject(projectId: string, assetId: string): string {
  return `projects/${encodeURIComponent(projectId)}/${assetId}`;
}

function projectStorageKey(projectId: string): string {
  return createHash("sha256").update(projectId).digest("hex").slice(0, 24);
}

function logicalAssetId(directory: string, sourcePath: string): string {
  const extension = path.extname(sourcePath);
  const name = path.basename(sourcePath, extension);
  return `assets/${directory ? `${directory}/` : ""}${name}`;
}

function plannedLogicalAssetId(
  sourcePath: string,
  targetDirectory: string | undefined,
  assetsRoot: string,
): string {
  let logicalDirectory = normalizeDirectory(targetDirectory ?? "");
  if (targetDirectory === undefined) {
    const realRoot = fs.realpathSync(path.resolve(assetsRoot));
    const realSource = sourcePath;
    if (isInside(realRoot, realSource)) {
      logicalDirectory = normalizeDirectory(path.dirname(path.relative(realRoot, realSource)));
    }
  }
  return logicalAssetId(logicalDirectory, sourcePath);
}

function validatedSourcePathSync(sourcePath: string, assetsRoot: string): string {
  try {
    const lexicalRoot = path.resolve(assetsRoot);
    const lexicalSource = path.resolve(sourcePath);
    const realRoot = fs.realpathSync(lexicalRoot);
    const realSource = fs.realpathSync(lexicalSource);
    if (isInside(lexicalRoot, lexicalSource) && !isInside(realRoot, realSource)) {
      throw new AssetApplicationError(
        "ASSET_PATH_OUTSIDE_ROOT",
        "Asset source symlink escapes assetsRoot",
        { filePath: sourcePath },
      );
    }
    if (!fs.statSync(realSource).isFile()) throw new Error("not a regular file");
    return realSource;
  } catch (error) {
    if (error instanceof AssetApplicationError) throw error;
    throw new AssetApplicationError(
      "ASSET_NOT_FOUND",
      `Asset source is unavailable: ${sourcePath} (${errorMessage(error)})`,
      { filePath: sourcePath, suggestedActions: ["Choose an existing Aseprite source"] },
    );
  }
}

function assetReservationKey(projectId: string, assetId: string): string {
  return `${projectId}\u0000${assetId}`;
}

function settingsKey(scope: "project" | "user", projectId: string): string {
  return scope === "user" ? "user" : `project:${projectId}`;
}

function requireSpriteDocument(value: unknown, assetId: string): SpriteDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssetApplicationError("ASSET_NOT_FOUND", `Asset "${assetId}" has invalid metadata`);
  }
  const document = value as Partial<SpriteDocument>;
  if (!Array.isArray(document.frames) || !Array.isArray(document.clips) || !Array.isArray(document.slices)) {
    throw new AssetApplicationError("ASSET_NOT_FOUND", `Asset "${assetId}" has invalid sprite metadata`);
  }
  return document as SpriteDocument;
}

async function readPngDataUrl(filePath: string, limit: number): Promise<string | undefined> {
  if (limit === 0) return undefined;
  let stats: fs.Stats;
  try {
    stats = await fsp.lstat(filePath);
  } catch {
    return undefined;
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size < PNG_SIGNATURE.length || stats.size > limit) {
    return undefined;
  }
  const bytes = await fsp.readFile(filePath);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function safeTargetDirectory(root: string, relative: string): Promise<string> {
  validateRelativeDirectory(relative);
  const realRoot = await fsp.realpath(path.resolve(root));
  const rootStats = await fsp.lstat(realRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new AssetApplicationError("ASSET_PATH_OUTSIDE_ROOT", "Asset root is not a real directory");
  }
  const target = path.resolve(realRoot, relative);
  if (!isInside(realRoot, target)) {
    throw new AssetApplicationError("ASSET_PATH_OUTSIDE_ROOT", "Asset destination escapes assetsRoot");
  }
  let current = realRoot;
  for (const segment of path.relative(realRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fsp.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const stats = await fsp.lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new AssetApplicationError(
        "ASSET_PATH_OUTSIDE_ROOT",
        "Asset destination contains a symlink or non-directory segment",
        { filePath: current },
      );
    }
  }
  const realTarget = await fsp.realpath(target);
  if (!isInside(realRoot, realTarget)) {
    throw new AssetApplicationError(
      "ASSET_PATH_OUTSIDE_ROOT",
      "Asset destination resolves outside assetsRoot",
      { filePath: realTarget },
    );
  }
  return realTarget;
}

async function realFile(filePath: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fsp.realpath(path.resolve(filePath));
    const stats = await fsp.stat(resolved);
    if (!stats.isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new AssetApplicationError(
      "ASSET_NOT_FOUND",
      `Asset file is unavailable: ${filePath} (${errorMessage(error)})`,
      { filePath, suggestedActions: ["Locate the source again", "Remove the stale catalog entry"] },
    );
  }
  return resolved;
}

async function realPathOrSelf(filePath: string): Promise<string> {
  try {
    return await fsp.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isAsepriteSource(filePath: string): boolean {
  const extension = path.extname(filePath).toLocaleLowerCase();
  return extension === ".ase" || extension === ".aseprite";
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function enrichApplicationError(error: unknown, stage: string): AssetApplicationError {
  if (error instanceof AssetApplicationError) return error;
  if (error instanceof AssetToolError) {
    return new AssetApplicationError("ASSET_TOOL_FAILED", error.message, {
      stage: error.stage ?? stage,
      ...(error.filePath !== undefined ? { filePath: error.filePath } : {}),
      stderr: error.stderr,
      suggestedActions: error.suggestedActions,
    });
  }
  return new AssetApplicationError("ASSET_TOOL_FAILED", errorMessage(error), {
    stage,
    suggestedActions: ["Review the middleware logs and retry the operation"],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(directory, "r");
    await handle.sync();
  } catch {
    // O rename e o fsync do arquivo continuam validos em filesystems sem fsync de diretorio.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fsp.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseCatalogManifest(
  raw: unknown,
  projectId: string,
  assetsRoot: string,
  outputRoot: string,
): AssetCatalogManifest {
  if (raw === undefined) return Object.freeze({ version: 1, projectId, assets: Object.freeze([]) });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AssetApplicationError("ASSET_INVALID_REQUEST", "Asset catalog manifest must be an object");
  }
  const manifest = raw as Record<string, unknown>;
  if (manifest["version"] !== 1 || manifest["projectId"] !== projectId || !Array.isArray(manifest["assets"])) {
    throw new AssetApplicationError(
      "ASSET_INVALID_REQUEST",
      `Asset catalog manifest does not belong to project "${projectId}"`,
    );
  }
  const records = manifest["assets"].map((value, index) =>
    parseCatalogRecord(value, projectId, assetsRoot, outputRoot, index));
  return Object.freeze({ version: 1, projectId, assets: Object.freeze(records) });
}

function parseCatalogRecord(
  value: unknown,
  projectId: string,
  assetsRoot: string,
  outputRoot: string,
  index: number,
): AssetCatalogManifestRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidManifestRecord(index);
  }
  const record = value as Record<string, unknown>;
  if (!record["asset"] || typeof record["asset"] !== "object" || Array.isArray(record["asset"])) {
    throw invalidManifestRecord(index);
  }
  const asset = record["asset"] as Record<string, unknown>;
  const paths = asset["paths"];
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) throw invalidManifestRecord(index);
  const pathRecord = paths as Record<string, unknown>;
  const requiredPaths = [
    "source",
    "originSource",
    "managedSource",
    "spritesheet",
    "metadata",
    "compiled",
    "outputDirectory",
  ] as const;
  if (requiredPaths.some((key) => typeof pathRecord[key] !== "string")) throw invalidManifestRecord(index);
  const normalizedPaths: AssetPaths = Object.freeze({
    source: pathRecord["originSource"] as string,
    originSource: pathRecord["originSource"] as string,
    managedSource: pathRecord["managedSource"] as string,
    spritesheet: pathRecord["spritesheet"] as string,
    metadata: pathRecord["metadata"] as string,
    compiled: pathRecord["compiled"] as string,
    outputDirectory: pathRecord["outputDirectory"] as string,
  });
  assertManifestPathConfined(
    assetsRoot,
    normalizedPaths.managedSource,
    "Managed source in asset manifest escapes assetsRoot",
  );
  for (const output of [
    normalizedPaths.spritesheet,
    normalizedPaths.metadata,
    normalizedPaths.compiled,
    normalizedPaths.outputDirectory,
  ]) {
    assertManifestPathConfined(
      outputRoot,
      output,
      "Generated path in asset manifest escapes outputRoot",
    );
  }
  const assetId = validateAssetId(asset["assetId"] as string);
  const expectedArtifactId = artifactIdForProject(projectId, assetId);
  const artifact = record["artifact"] as ArtifactEnvelope;
  if (
    !artifact ||
    typeof artifact !== "object" ||
    artifact.artifactId !== expectedArtifactId ||
    asset["artifactId"] !== expectedArtifactId ||
    !Number.isInteger(asset["revision"]) ||
    (asset["revision"] as number) < 1 ||
    artifact.revision !== asset["revision"] ||
    typeof asset["contentHash"] !== "string" ||
    artifact.contentHash !== asset["contentHash"] ||
    !Array.isArray(asset["tags"]) ||
    (asset["tags"] as unknown[]).some((tag) => typeof tag !== "string") ||
    !Number.isInteger(asset["clipCount"]) ||
    typeof asset["importedAt"] !== "number"
  ) {
    throw invalidManifestRecord(index);
  }
  const stored: Omit<StoredAsset, "thumbnailDataUrl"> = Object.freeze({
    assetId,
    artifactId: expectedArtifactId,
    revision: asset["revision"] as number,
    contentHash: asset["contentHash"] as string,
    tags: Object.freeze([...(asset["tags"] as string[])]),
    clipCount: asset["clipCount"] as number,
    paths: normalizedPaths,
    importedAt: asset["importedAt"] as number,
  });
  return Object.freeze({ asset: stored, artifact });
}

function invalidManifestRecord(index: number): AssetApplicationError {
  return new AssetApplicationError(
    "ASSET_INVALID_REQUEST",
    `Asset catalog manifest record ${index} is invalid`,
  );
}

/**
 * Valida o caminho lexical e cada segmento existente sem seguir symlinks.
 * Outputs ausentes continuam reparáveis, mas um manifesto nunca pode usar um
 * parent symlink para fazer thumbnail/reveal ler fora do catálogo.
 */
function assertManifestPathConfined(rootInput: string, candidateInput: string, message: string): void {
  const root = fs.realpathSync(path.resolve(rootInput));
  const candidate = path.resolve(candidateInput);
  if (!isInside(root, candidate)) {
    throw new AssetApplicationError(
      "ASSET_PATH_OUTSIDE_ROOT",
      message,
      { filePath: candidateInput },
    );
  }
  let current = root;
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new AssetApplicationError(
        "ASSET_PATH_OUTSIDE_ROOT",
        message,
        { filePath: current },
      );
    }
  }
}

function readPngDataUrlSync(filePath: string, limit: number): string | undefined {
  if (limit === 0) return undefined;
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size < PNG_SIGNATURE.length || stats.size > limit) {
      return undefined;
    }
    const bytes = fs.readFileSync(filePath);
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return undefined;
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function writePrivateJsonAtomic(
  directory: string,
  filePath: string,
  value: unknown,
): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024) {
    throw new AssetApplicationError(
      "ASSET_INVALID_REQUEST",
      `Private JSON file exceeds the 16 MiB safety limit: ${filePath}`,
      { filePath },
    );
  }
  const realDirectory = await ensurePrivateDirectory(directory);
  if (path.dirname(path.resolve(filePath)) !== path.resolve(directory)) {
    throw new AssetApplicationError(
      "ASSET_PATH_OUTSIDE_ROOT",
      `Private JSON path escapes its directory: ${filePath}`,
      { filePath },
    );
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const verifiedDirectory = await fsp.realpath(path.dirname(filePath));
    if (verifiedDirectory !== realDirectory) {
      throw new AssetApplicationError(
        "ASSET_PATH_OUTSIDE_ROOT",
        `Private JSON directory changed during write: ${filePath}`,
        { filePath },
      );
    }
    await fsp.rename(temporary, filePath);
    await fsp.chmod(filePath, 0o600).catch(() => undefined);
    await syncDirectory(realDirectory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  try {
    const parentStats = await fsp.lstat(parent);
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new AssetApplicationError(
        "ASSET_PATH_OUTSIDE_ROOT",
        `Private state parent must not be a symlink: ${parent}`,
        { filePath: parent },
      );
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  try {
    await fsp.mkdir(absolute, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  const stats = await fsp.lstat(absolute);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AssetApplicationError(
      "ASSET_PATH_OUTSIDE_ROOT",
      `Private state directory must not be a symlink: ${absolute}`,
      { filePath: absolute },
    );
  }
  await fsp.chmod(absolute, 0o700).catch(() => undefined);
  return await fsp.realpath(absolute);
}

function assertPrivateStateRootSync(directory: string): void {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  try {
    const parentStats = fs.lstatSync(parent);
    if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
      throw new AssetApplicationError(
        "ASSET_PATH_OUTSIDE_ROOT",
        `Private state parent must not be a symlink: ${parent}`,
        { filePath: parent },
      );
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AssetApplicationError(
      "ASSET_PATH_OUTSIDE_ROOT",
      `Private state directory must not be a symlink: ${absolute}`,
      { filePath: absolute },
    );
  }
}
