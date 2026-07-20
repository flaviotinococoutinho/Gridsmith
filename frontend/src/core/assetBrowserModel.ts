import type {
  AssetCancelResult,
  AssetCatalogFilter,
  AssetCatalogResult,
  AssetDetails,
  AssetImportInput,
  AssetOperationResult,
  AssetRemoveResult,
  AssetRevealResult,
  AssetSummary,
  EditorApplicationEvent,
} from "./assetApi.js";

/** Porta mínima consumida pelo Asset Browser; não expõe Electron nem transporte. */
export interface AssetCatalogPort {
  assetCatalog(filter?: AssetCatalogFilter): Promise<AssetCatalogResult | readonly AssetSummary[]>;
  assetDetails(assetId: string): Promise<AssetDetails>;
  importAsset(input: AssetImportInput): Promise<AssetOperationResult>;
  reimportAsset(assetId: string, operationId?: string): Promise<AssetOperationResult>;
  removeAsset(assetId: string): Promise<AssetRemoveResult>;
  revealSource(reference: { readonly assetId: string } | { readonly operationId: string }): Promise<AssetRevealResult>;
  revealOutput(assetId: string): Promise<AssetRevealResult>;
  cancelAssetOperation(operationId: string): Promise<AssetCancelResult>;
}

export type AssetQueueOperation = "import" | "reimport";
export type AssetQueueStatus = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface AssetQueueEntry {
  readonly operationId: string;
  readonly operation: AssetQueueOperation;
  readonly label: string;
  readonly sourcePath?: string;
  readonly assetId?: string;
  readonly status: AssetQueueStatus;
  readonly progress: number;
  readonly phase?: string;
  readonly message?: string;
  readonly createdAt: number;
}

export interface AssetBrowserSnapshot {
  readonly assets: readonly AssetSummary[];
  readonly tags: readonly string[];
  readonly filter: AssetCatalogFilter;
  readonly loading: boolean;
  readonly loaded: boolean;
  readonly catalogVersion: number;
  readonly error?: string;
  readonly operations: readonly AssetQueueEntry[];
}

export interface AssetImportOptions {
  readonly targetDirectory?: string;
  readonly tags?: readonly string[];
}

export interface AssetBrowserControllerOptions {
  readonly createOperationId?: () => string;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Estado transport-neutral do catálogo e da fila. Import/reimport só delegam ao
 * pipeline da aplicação; progresso e conclusão chegam pelo stream operacional.
 */
export class AssetBrowserController {
  private assets: readonly AssetSummary[] = [];
  private tags: readonly string[] = [];
  private filter: AssetCatalogFilter = {};
  private loading = false;
  private loaded = false;
  private catalogVersion = 0;
  private error: string | undefined;
  private readonly operations = new Map<string, AssetQueueEntry>();
  private readonly detailsCache = new Map<string, AssetDetails>();
  private readonly listeners = new Set<() => void>();
  private readonly createOperationId: () => string;
  private readonly now: () => number;
  private refreshInFlight: Promise<void> | undefined;
  private refreshQueued = false;

  constructor(
    private readonly port: AssetCatalogPort,
    private readonly options: AssetBrowserControllerOptions = {},
  ) {
    this.createOperationId = options.createOperationId ?? (() => crypto.randomUUID());
    this.now = options.now ?? Date.now;
  }

  get snapshot(): AssetBrowserSnapshot {
    return {
      assets: this.assets,
      tags: this.tags,
      filter: this.filter,
      loading: this.loading,
      loaded: this.loaded,
      catalogVersion: this.catalogVersion,
      ...(this.error ? { error: this.error } : {}),
      operations: [...this.operations.values()].sort((left, right) => right.createdAt - left.createdAt),
    };
  }

  subscribe(listener: () => void, emitCurrent = false): () => void {
    this.listeners.add(listener);
    if (emitCurrent) listener();
    return () => this.listeners.delete(listener);
  }

  setFilter(filter: AssetCatalogFilter): void {
    this.filter = normalizeAssetFilter(filter);
    this.notify();
  }

  async refresh(filter: AssetCatalogFilter = this.filter): Promise<void> {
    this.filter = normalizeAssetFilter(filter);
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    this.loading = true;
    this.error = undefined;
    this.notify();
    this.refreshInFlight = (async () => {
      try {
        // A árvore é uma projeção completa. Busca/tags/diretório são aplicados
        // localmente para limpar o filtro sem perder itens após catalogChanged.
        const result = await this.port.assetCatalog();
        const normalized = normalizeCatalogResult(result);
        this.assets = normalized.assets;
        this.tags = normalized.tags;
        this.loaded = true;
        this.catalogVersion++;
        const validIds = new Set(this.assets.map(({ assetId }) => assetId));
        for (const assetId of this.detailsCache.keys()) {
          if (!validIds.has(assetId)) this.detailsCache.delete(assetId);
        }
      } catch (error) {
        this.error = errorMessage(error);
        this.options.onError?.(error);
      } finally {
        this.loading = false;
        this.refreshInFlight = undefined;
        this.notify();
        if (this.refreshQueued) {
          this.refreshQueued = false;
          void this.refresh();
        }
      }
    })();
    return this.refreshInFlight;
  }

  async details(assetId: string, force = false): Promise<AssetDetails> {
    if (!force) {
      const cached = this.detailsCache.get(assetId);
      if (cached) return cached;
    }
    const details = await this.port.assetDetails(assetId);
    this.detailsCache.set(assetId, details);
    return details;
  }

  importSources(sourcePaths: readonly string[], options: AssetImportOptions = {}): readonly string[] {
    const unique = uniqueSourcePaths(sourcePaths).filter((sourcePath) =>
      ![...this.operations.values()].some((entry) =>
        entry.operation === "import" && entry.sourcePath === sourcePath &&
        (entry.status === "queued" || entry.status === "running")));
    const operationIds: string[] = [];
    for (const sourcePath of unique) {
      const operationId = this.createOperationId();
      operationIds.push(operationId);
      this.operations.set(operationId, {
        operationId,
        operation: "import",
        label: `Importar ${fileName(sourcePath)}`,
        sourcePath,
        status: "queued",
        progress: 0,
        createdAt: this.now(),
      });
      void this.startImport(operationId, sourcePath, options);
    }
    if (operationIds.length > 0) this.notify();
    return operationIds;
  }

  reimport(assetId: string): string {
    const existing = [...this.operations.values()].find((entry) =>
      entry.operation === "reimport" && entry.assetId === assetId &&
      (entry.status === "queued" || entry.status === "running"));
    if (existing) return existing.operationId;
    const operationId = this.createOperationId();
    const asset = this.assets.find((candidate) => candidate.assetId === assetId);
    this.operations.set(operationId, {
      operationId,
      operation: "reimport",
      label: `Reimportar ${asset?.name ?? assetId}`,
      assetId,
      status: "queued",
      progress: 0,
      createdAt: this.now(),
    });
    this.notify();
    void this.startReimport(operationId, assetId);
    return operationId;
  }

  async cancel(operationId: string): Promise<boolean> {
    const entry = this.operations.get(operationId);
    if (!entry || isTerminal(entry.status)) return false;
    if (entry.status === "queued") {
      this.operations.set(operationId, { ...entry, status: "cancelled", message: "Cancelado antes do envio." });
      this.notify();
      return true;
    }
    try {
      const result = await this.port.cancelAssetOperation(operationId);
      if (result.cancelled) {
        this.operations.set(operationId, { ...entry, status: "cancelled", message: "Cancelamento solicitado." });
        this.notify();
      }
      return result.cancelled;
    } catch (error) {
      this.failOperation(operationId, error);
      return false;
    }
  }

  async remove(assetId: string): Promise<boolean> {
    const result = await this.port.removeAsset(assetId);
    if (result.removed) {
      this.detailsCache.delete(assetId);
      await this.refresh();
    }
    return result.removed;
  }

  revealSource(assetId: string): Promise<AssetRevealResult> {
    return this.port.revealSource({ assetId });
  }

  revealOperationSource(operationId: string): Promise<AssetRevealResult> {
    return this.port.revealSource({ operationId });
  }

  revealOutput(assetId: string): Promise<AssetRevealResult> {
    return this.port.revealOutput(assetId);
  }

  /** Aplica eventos operacionais sem confiar em payloads externos. */
  handleApplicationEvent(event: EditorApplicationEvent): boolean {
    if (!isAssetEvent(event)) return false;
    const payload = recordValue(event.payload);
    const operationId = nonEmptyString(event.operationId) ?? nonEmptyString(payload?.["operationId"]);
    const status = statusOf(event.kind, payload?.["status"]);
    const current = operationId ? this.operations.get(operationId) : undefined;
    if (operationId && current) {
      const progress = progressOf(event, payload) ?? current.progress;
      const phase = nonEmptyString(event.progress?.phase) ?? nonEmptyString(payload?.["phase"]);
      const message = nonEmptyString(event.progress?.message) ?? nonEmptyString(payload?.["message"]);
      this.operations.set(operationId, {
        ...current,
        status: status ?? current.status,
        progress,
        ...(phase ? { phase } : {}),
        ...(message ? { message } : {}),
      });
    }
    const catalogChanged = normalizeSearch(event.kind).includes("catalogchanged") || status === "completed";
    if (catalogChanged) {
      const assetId = nonEmptyString(payload?.["assetId"]) ?? current?.assetId;
      if (assetId) this.detailsCache.delete(assetId);
      else this.detailsCache.clear();
      void this.refresh();
    }
    this.notify();
    return true;
  }

  private async startImport(
    operationId: string,
    sourcePath: string,
    options: AssetImportOptions,
  ): Promise<void> {
    const entry = this.operations.get(operationId);
    if (!entry || entry.status !== "queued") return;
    this.operations.set(operationId, { ...entry, status: "running" });
    this.notify();
    try {
      const ack = await this.port.importAsset({
        sourcePath,
        operationId,
        ...(options.targetDirectory ? { targetDirectory: options.targetDirectory } : {}),
        ...(options.tags?.length ? { tags: [...options.tags] } : {}),
      });
      this.applyAcknowledgement(operationId, ack);
    } catch (error) {
      this.failOperation(operationId, error);
    }
  }

  private async startReimport(operationId: string, assetId: string): Promise<void> {
    const entry = this.operations.get(operationId);
    if (!entry || entry.status !== "queued") return;
    this.operations.set(operationId, { ...entry, status: "running" });
    this.notify();
    try {
      const ack = await this.port.reimportAsset(assetId, operationId);
      this.applyAcknowledgement(operationId, ack);
    } catch (error) {
      this.failOperation(operationId, error);
    }
  }

  private applyAcknowledgement(operationId: string, ack: AssetOperationResult): void {
    const current = this.operations.get(operationId);
    if (!current || isTerminal(current.status)) return;
    const ackRecord = ack as unknown as Record<string, unknown>;
    const ackStatus = statusOf("", ackRecord["status"]);
    const progress = finiteProgress(ackRecord["progress"]) ?? current.progress;
    const assetId = nonEmptyString(ackRecord["assetId"]);
    const message = nonEmptyString(ackRecord["message"]);
    this.operations.set(operationId, {
      ...current,
      status: ackStatus ?? "running",
      progress,
      ...(assetId ? { assetId } : {}),
      ...(message ? { message } : {}),
    });
    if (ackStatus === "completed") void this.refresh();
    this.notify();
  }

  private failOperation(operationId: string, error: unknown): void {
    const current = this.operations.get(operationId);
    if (!current) return;
    this.operations.set(operationId, {
      ...current,
      status: "failed",
      message: errorMessage(error),
    });
    this.options.onError?.(error);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export interface AssetDirectoryNode {
  readonly name: string;
  readonly path: string;
  readonly assetCount: number;
  readonly children: readonly AssetDirectoryNode[];
}

export function buildAssetDirectoryTree(assets: readonly AssetSummary[]): readonly AssetDirectoryNode[] {
  interface MutableNode {
    name: string;
    path: string;
    assetIds: Set<string>;
    children: Map<string, MutableNode>;
  }
  const roots = new Map<string, MutableNode>();
  for (const asset of assets) {
    const segments = directorySegments(asset.directory);
    let nodes = roots;
    let parentPath = "";
    for (const segment of segments) {
      const path = parentPath ? `${parentPath}/${segment}` : segment;
      let node = nodes.get(segment);
      if (!node) {
        node = { name: segment, path, assetIds: new Set(), children: new Map() };
        nodes.set(segment, node);
      }
      node.assetIds.add(asset.assetId);
      nodes = node.children;
      parentPath = path;
    }
  }
  const freeze = (node: MutableNode): AssetDirectoryNode => ({
    name: node.name,
    path: node.path,
    assetCount: node.assetIds.size,
    children: [...node.children.values()].sort(compareDirectoryNodes).map(freeze),
  });
  return [...roots.values()].sort(compareDirectoryNodes).map(freeze);
}

export function filterAssetSummaries(
  assets: readonly AssetSummary[],
  filter: AssetCatalogFilter,
): readonly AssetSummary[] {
  const search = normalizeSearch(filter.search);
  const selectedTags = new Set((filter.tags ?? []).map(normalizeSearch).filter(Boolean));
  const directory = normalizeDirectory(filter.directory);
  return assets.filter((asset) => {
    if (directory && !isWithinDirectory(asset.directory, directory)) return false;
    if (selectedTags.size > 0) {
      const tags = new Set(asset.tags.map(normalizeSearch));
      if ([...selectedTags].some((tag) => !tags.has(tag))) return false;
    }
    if (!search) return true;
    const haystack = normalizeSearch(`${asset.name} ${asset.assetId} ${asset.kind} ${asset.directory} ${asset.tags.join(" ")}`);
    return haystack.includes(search);
  });
}

export const P7M_ASSET_DRAG_TYPE = "application/x-p7m-asset";

export interface AssetDragDescriptor {
  readonly assetId: string;
  readonly kind: string;
  readonly name: string;
}

export function encodeAssetDrag(descriptor: AssetDragDescriptor): string {
  return JSON.stringify({ version: 1, ...descriptor });
}

export function decodeAssetDrag(value: string): AssetDragDescriptor | undefined {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed["version"] !== 1) return undefined;
    const assetId = nonEmptyString(parsed["assetId"]);
    const kind = nonEmptyString(parsed["kind"]);
    const name = nonEmptyString(parsed["name"]);
    return assetId && kind && name ? { assetId, kind, name } : undefined;
  } catch {
    return undefined;
  }
}

/** CSP-safe: nunca converte caminho local bruto em file://. */
export function safeAssetPreviewUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(candidate)) return candidate;
  if (/^blob:/iu.test(candidate)) return candidate;
  if (/^(?:\.\.?\/|\/assets\/|assets\/)/u.test(candidate) && !candidate.includes("\\")) return candidate;
  return undefined;
}

export function normalizeCatalogResult(
  result: AssetCatalogResult | readonly AssetSummary[],
): Pick<AssetCatalogResult, "assets" | "tags" | "directories"> {
  const arrayResult = isAssetSummaryArray(result);
  const assets = arrayResult ? result : result.assets;
  const sorted = [...assets].sort((left, right) =>
    left.directory.localeCompare(right.directory, "pt-BR") ||
    left.name.localeCompare(right.name, "pt-BR") ||
    left.assetId.localeCompare(right.assetId));
  const tags = arrayResult
    ? [...new Set(sorted.flatMap((asset) => asset.tags))]
    : [...result.tags];
  tags.sort((left, right) => left.localeCompare(right, "pt-BR"));
  const directories = arrayResult
    ? [...new Set(sorted.map((asset) => asset.directory).filter(Boolean))]
    : [...result.directories];
  directories.sort((left, right) => left.localeCompare(right, "pt-BR"));
  return { assets: sorted, tags, directories };
}

function normalizeAssetFilter(filter: AssetCatalogFilter): AssetCatalogFilter {
  const search = filter.search?.trim();
  const tags = [...new Set((filter.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  const directory = normalizeDirectory(filter.directory);
  return {
    ...(search ? { search } : {}),
    ...(tags.length ? { tags } : {}),
    ...(directory ? { directory } : {}),
  };
}

function uniqueSourcePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function fileName(path: string): string {
  return path.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1) ?? path;
}

function directorySegments(value: string): string[] {
  const normalized = normalizeDirectory(value);
  return normalized ? normalized.split("/").filter(Boolean) : ["Projeto"];
}

function normalizeDirectory(value: string | undefined): string {
  return (value ?? "").replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "").replace(/\/{2,}/gu, "/");
}

function isWithinDirectory(value: string, directory: string): boolean {
  const normalized = normalizeDirectory(value);
  return normalized === directory || normalized.startsWith(`${directory}/`);
}

function normalizeSearch(value: string | undefined): string {
  return (value ?? "").trim().normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
}

function compareDirectoryNodes(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, "pt-BR");
}

function isAssetEvent(event: EditorApplicationEvent): boolean {
  return normalizeSearch(event.domain).includes("asset");
}

function statusOf(kind: string, rawStatus: unknown): AssetQueueStatus | undefined {
  const value = normalizeSearch(`${kind} ${typeof rawStatus === "string" ? rawStatus : ""}`);
  if (value.includes("cancel")) return "cancelled";
  if (value.includes("fail") || value.includes("error")) return "failed";
  if (value.includes("complet") || value.includes("succeed") || value.includes("finished")) return "completed";
  if (value.includes("accept") || value.includes("progress") || value.includes("running") || value.includes("start")) return "running";
  if (value.includes("queue")) return "queued";
  return undefined;
}

function progressOf(
  event: EditorApplicationEvent,
  payload: Record<string, unknown> | undefined,
): number | undefined {
  const direct = finiteProgress(event.progress?.percent);
  if (direct !== undefined) return direct;
  const progress = recordValue(payload?.["progress"]);
  const percent = finiteProgress(progress?.["percent"] ?? payload?.["percent"]);
  if (percent !== undefined) return percent;
  const current = finiteNumber(progress?.["current"] ?? payload?.["current"]);
  const total = finiteNumber(progress?.["total"] ?? payload?.["total"]);
  return current !== undefined && total !== undefined && total > 0
    ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
    : undefined;
}

function isAssetSummaryArray(
  value: AssetCatalogResult | readonly AssetSummary[],
): value is readonly AssetSummary[] {
  return Array.isArray(value);
}

function finiteProgress(value: unknown): number | undefined {
  const number = finiteNumber(value);
  if (number === undefined) return undefined;
  return Math.max(0, Math.min(100, number <= 1 && number !== 0 ? number * 100 : number));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isTerminal(status: AssetQueueStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
