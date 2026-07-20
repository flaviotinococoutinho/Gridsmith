import {
  P7M_ASSET_DRAG_TYPE,
  buildAssetDirectoryTree,
  encodeAssetDrag,
  filterAssetSummaries,
  safeAssetPreviewUrl,
  type AssetBrowserController,
  type AssetDirectoryNode,
} from "../core/assetBrowserModel.js";
import type { AssetSummary } from "../core/assetApi.js";
import type { PanelInstance } from "../core/panelRegistry.js";
import {
  asepriteSourcePaths,
  type DroppedFilePathAdapter,
} from "./assetFileDropAdapter.js";

export interface AssetBrowserPanelOptions {
  readonly host: HTMLElement;
  readonly controller: AssetBrowserController;
  readonly onSelect: (asset: AssetSummary) => void;
  readonly selectSources: () => Promise<readonly string[]>;
  readonly confirmRemove?: (asset: AssetSummary) => boolean | Promise<boolean>;
  readonly detectAssetTools: () => Promise<unknown>;
  readonly configureAssetTool: (tool: "aseprite" | "mgcb") => Promise<unknown | undefined>;
  readonly onError?: (error: unknown) => void;
  readonly filePathAdapter?: DroppedFilePathAdapter;
}

export function mountAssetBrowser(options: AssetBrowserPanelOptions): PanelInstance {
  const document = options.host.ownerDocument;
  const root = document.createElement("section");
  root.className = "asset-browser";

  const toolbar = document.createElement("div");
  toolbar.className = "asset-browser-toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Buscar assets…";
  search.setAttribute("aria-label", "Buscar assets");
  const importButton = actionButton(document, "Importar…", "Importar arquivos Aseprite");
  toolbar.append(search, importButton);

  const toolConfiguration = document.createElement("details");
  toolConfiguration.className = "asset-tool-configuration";
  const toolSummary = document.createElement("summary");
  toolSummary.textContent = "Ferramentas de importação";
  const toolActions = document.createElement("div");
  toolActions.className = "asset-card-actions";
  const detectTools = actionButton(document, "Detectar e testar", "Detectar e testar Aseprite e MGCB");
  const selectAseprite = actionButton(document, "Selecionar Aseprite…", "Selecionar executável do Aseprite");
  const selectMgcb = actionButton(document, "Selecionar MGCB…", "Selecionar executável do MGCB");
  const toolStatus = document.createElement("output");
  toolStatus.className = "muted asset-tool-status";
  toolStatus.setAttribute("aria-live", "polite");
  toolActions.append(detectTools, selectAseprite, selectMgcb);
  toolConfiguration.append(toolSummary, toolActions, toolStatus);

  const runToolConfiguration = (
    button: HTMLButtonElement,
    operation: () => Promise<unknown | undefined>,
  ): void => {
    button.disabled = true;
    toolStatus.textContent = "Validando ferramentas…";
    void operation().then((result) => {
      toolStatus.textContent = result === undefined
        ? "Seleção cancelada; configuração anterior preservada."
        : assetToolConfigurationSummary(result);
    }).catch((error) => {
      toolStatus.textContent = `Falha: ${error instanceof Error ? error.message : String(error)}`;
      options.onError?.(error);
    }).finally(() => { button.disabled = false; });
  };
  detectTools.addEventListener("click", () => runToolConfiguration(detectTools, options.detectAssetTools));
  selectAseprite.addEventListener("click", () => runToolConfiguration(
    selectAseprite,
    () => options.configureAssetTool("aseprite"),
  ));
  selectMgcb.addEventListener("click", () => runToolConfiguration(
    selectMgcb,
    () => options.configureAssetTool("mgcb"),
  ));

  const body = document.createElement("div");
  body.className = "asset-browser-body";
  const navigation = document.createElement("nav");
  navigation.className = "asset-browser-navigation";
  navigation.setAttribute("aria-label", "Diretórios e tags de assets");
  const treeHost = document.createElement("div");
  treeHost.className = "asset-directory-tree";
  const tagsHost = document.createElement("div");
  tagsHost.className = "asset-tag-list";
  navigation.append(treeHost, tagsHost);

  const catalog = document.createElement("div");
  catalog.className = "asset-catalog";
  catalog.tabIndex = 0;
  const summary = document.createElement("div");
  summary.className = "asset-catalog-summary muted";
  const cards = document.createElement("div");
  cards.className = "asset-card-grid";
  cards.setAttribute("role", "listbox");
  catalog.append(summary, cards);
  body.append(navigation, catalog);

  const queue = document.createElement("section");
  queue.className = "asset-operation-queue";
  const queueHeading = document.createElement("strong");
  queueHeading.textContent = "Importações";
  const queueHost = document.createElement("div");
  queue.append(queueHeading, queueHost);
  root.append(toolbar, toolConfiguration, body, queue);
  options.host.replaceChildren(root);

  const importFiles = (files: Iterable<File> | ArrayLike<File>): void => {
    const paths = asepriteSourcePaths(
      files,
      options.filePathAdapter ?? { pathOf: () => undefined },
    );
    if (paths.length === 0) {
      options.onError?.(new Error(
        "Nenhum arquivo .ase/.aseprite com caminho local foi recebido. Use o seletor do aplicativo.",
      ));
      return;
    }
    options.controller.importSources(paths, {
      ...(options.controller.snapshot.filter.directory
        ? { targetDirectory: options.controller.snapshot.filter.directory }
        : {}),
    });
  };

  importButton.addEventListener("click", () => {
    importButton.disabled = true;
    void options.selectSources()
      .then((paths) => {
        if (paths.length > 0) options.controller.importSources(paths, {
          ...(options.controller.snapshot.filter.directory
            ? { targetDirectory: options.controller.snapshot.filter.directory }
            : {}),
        });
      })
      .catch(options.onError)
      .finally(() => { importButton.disabled = false; });
  });
  search.addEventListener("input", () => {
    const { search: _search, ...filter } = options.controller.snapshot.filter;
    options.controller.setFilter({ ...filter, ...(search.value.trim() ? { search: search.value } : {}) });
  });
  catalog.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    catalog.classList.add("drop-target");
  });
  catalog.addEventListener("dragleave", () => catalog.classList.remove("drop-target"));
  catalog.addEventListener("drop", (event) => {
    catalog.classList.remove("drop-target");
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    importFiles(event.dataTransfer.files);
  });

  const render = (): void => {
    const snapshot = options.controller.snapshot;
    if (document.activeElement !== search && search.value !== (snapshot.filter.search ?? "")) {
      search.value = snapshot.filter.search ?? "";
    }
    renderTree(treeHost, snapshot.assets, snapshot.filter.directory, (directory) => {
      const { directory: _directory, ...filter } = options.controller.snapshot.filter;
      options.controller.setFilter({
        ...filter,
        ...(directory ? { directory } : {}),
      });
    });
    renderTags(tagsHost, snapshot.tags, snapshot.filter.tags ?? [], (tag) => {
      const selected = new Set(options.controller.snapshot.filter.tags ?? []);
      if (selected.has(tag)) selected.delete(tag);
      else selected.add(tag);
      options.controller.setFilter({
        ...options.controller.snapshot.filter,
        tags: [...selected],
      });
    });
    const visible = filterAssetSummaries(snapshot.assets, snapshot.filter);
    summary.textContent = snapshot.loading
      ? "Atualizando catálogo…"
      : `${visible.length} de ${snapshot.assets.length} asset${snapshot.assets.length === 1 ? "" : "s"}`;
    renderCards(cards, visible, options);
    renderQueue(queueHost, options);
    queue.hidden = snapshot.operations.length === 0;
    if (snapshot.error) summary.textContent = `Falha ao atualizar: ${snapshot.error}`;
  };

  const release = options.controller.subscribe(render);
  render();
  void options.controller.refresh();
  return {
    activate: render,
    focus: () => search.focus(),
    dispose: () => {
      release();
      options.host.replaceChildren();
    },
  };
}

function renderTree(
  host: HTMLElement,
  assets: readonly AssetSummary[],
  selectedDirectory: string | undefined,
  select: (directory: string | undefined) => void,
): void {
  const document = host.ownerDocument;
  const heading = document.createElement("strong");
  heading.textContent = "Pastas";
  const all = treeButton(document, "Todos", assets.length, !selectedDirectory, () => select(undefined));
  const list = document.createElement("ul");
  for (const node of buildAssetDirectoryTree(assets)) list.append(directoryItem(document, node, selectedDirectory, select));
  host.replaceChildren(heading, all, list);
}

function directoryItem(
  document: Document,
  node: AssetDirectoryNode,
  selectedDirectory: string | undefined,
  select: (directory: string | undefined) => void,
): HTMLLIElement {
  const item = document.createElement("li");
  item.append(treeButton(
    document,
    node.name,
    node.assetCount,
    selectedDirectory === node.path,
    () => select(node.path),
  ));
  if (node.children.length > 0) {
    const children = document.createElement("ul");
    for (const child of node.children) children.append(directoryItem(document, child, selectedDirectory, select));
    item.append(children);
  }
  return item;
}

function treeButton(
  document: Document,
  label: string,
  count: number,
  active: boolean,
  action: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "asset-tree-button";
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
  button.textContent = `${label} (${count})`;
  button.addEventListener("click", action);
  return button;
}

function renderTags(
  host: HTMLElement,
  tags: readonly string[],
  selectedTags: readonly string[],
  toggle: (tag: string) => void,
): void {
  const document = host.ownerDocument;
  const heading = document.createElement("strong");
  heading.textContent = "Tags";
  const chips = tags.map((tag) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "asset-tag";
    const active = selectedTags.includes(tag);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.textContent = tag;
    button.addEventListener("click", () => toggle(tag));
    return button;
  });
  const empty = document.createElement("span");
  empty.className = "muted";
  empty.textContent = "Sem tags";
  host.replaceChildren(heading, ...(chips.length ? chips : [empty]));
}

function renderCards(
  host: HTMLElement,
  assets: readonly AssetSummary[],
  options: AssetBrowserPanelOptions,
): void {
  const document = host.ownerDocument;
  if (assets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "panel-empty-state muted";
    empty.textContent = "Arraste um .ase/.aseprite ou use Importar para alimentar o pipeline do projeto.";
    host.replaceChildren(empty);
    return;
  }
  const cards = assets.map((asset) => assetCard(document, asset, options));
  host.replaceChildren(...cards);
}

function assetCard(
  document: Document,
  asset: AssetSummary,
  options: AssetBrowserPanelOptions,
): HTMLElement {
  const card = document.createElement("article");
  card.className = "asset-card";
  card.tabIndex = 0;
  card.draggable = true;
  card.setAttribute("role", "option");
  card.setAttribute("aria-label", `${asset.name}, ${asset.kind}`);
  const preview = assetPreview(document, asset);
  const title = document.createElement("strong");
  title.textContent = asset.name;
  const metadata = document.createElement("span");
  metadata.className = "muted";
  metadata.textContent = `${asset.kind} · r${asset.revision}${asset.clipCount ? ` · ${asset.clipCount} clips` : ""}`;
  const actions = document.createElement("div");
  actions.className = "asset-card-actions";
  const reimport = actionButton(document, "Reimportar", `Reimportar ${asset.name}`);
  const source = actionButton(document, "Fonte", `Abrir fonte de ${asset.name}`);
  const output = actionButton(document, "Artefato", `Revelar artefato de ${asset.name}`);
  const remove = actionButton(document, "Remover", `Remover ${asset.name} do catálogo`);
  reimport.addEventListener("click", (event) => {
    event.stopPropagation();
    options.controller.reimport(asset.assetId);
  });
  source.addEventListener("click", (event) => {
    event.stopPropagation();
    void options.controller.revealSource(asset.assetId).catch(options.onError);
  });
  output.addEventListener("click", (event) => {
    event.stopPropagation();
    void options.controller.revealOutput(asset.assetId).catch(options.onError);
  });
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    void Promise.resolve(options.confirmRemove?.(asset) ?? true)
      .then((confirmed) => confirmed ? options.controller.remove(asset.assetId) : false)
      .catch(options.onError);
  });
  actions.append(reimport, source, output, remove);
  card.append(preview, title, metadata, actions);
  const choose = (): void => options.onSelect(asset);
  card.addEventListener("click", choose);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose();
    }
  });
  card.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData(P7M_ASSET_DRAG_TYPE, encodeAssetDrag({
      assetId: asset.assetId,
      kind: asset.kind,
      name: asset.name,
    }));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyLink";
  });
  return card;
}

function assetPreview(document: Document, asset: AssetSummary): HTMLElement {
  const previewUrl = safeAssetPreviewUrl(asset.thumbnailDataUrl) ?? safeAssetPreviewUrl(asset.thumbnailPath);
  if (previewUrl) {
    const image = document.createElement("img");
    image.className = "asset-thumbnail";
    image.src = previewUrl;
    image.alt = `Miniatura de ${asset.name}`;
    image.loading = "lazy";
    return image;
  }
  const fallback = document.createElement("div");
  fallback.className = "asset-thumbnail asset-thumbnail-fallback";
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = asset.name.slice(0, 2).toLocaleUpperCase("pt-BR") || "AS";
  return fallback;
}

function renderQueue(host: HTMLElement, options: AssetBrowserPanelOptions): void {
  const document = host.ownerDocument;
  const rows = options.controller.snapshot.operations.map((entry) => {
    const row = document.createElement("div");
    row.className = `asset-operation asset-operation-${entry.status}`;
    const label = document.createElement("span");
    label.textContent = entry.label;
    const progress = document.createElement("progress");
    progress.max = 100;
    progress.value = entry.progress;
    progress.setAttribute("aria-label", `${entry.label}: ${Math.round(entry.progress)}%`);
    const status = document.createElement("span");
    status.className = "muted";
    status.textContent = entry.message ?? entry.phase ?? queueStatusLabel(entry.status);
    row.append(label, progress, status);
    if (entry.status === "queued" || entry.status === "running") {
      const cancel = actionButton(document, "Cancelar", `Cancelar ${entry.label}`);
      cancel.addEventListener("click", () => void options.controller.cancel(entry.operationId).catch(options.onError));
      row.append(cancel);
    }
    return row;
  });
  host.replaceChildren(...rows);
}

function actionButton(document: Document, text: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  return button;
}

function queueStatusLabel(status: string): string {
  if (status === "queued") return "Na fila";
  if (status === "running") return "Processando";
  if (status === "completed") return "Concluído";
  if (status === "cancelled") return "Cancelado";
  return "Falhou";
}

export function assetToolConfigurationSummary(value: unknown): string {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!record) return "Ferramentas detectadas e testadas com sucesso.";
  const scope = typeof record["scope"] === "string" ? record["scope"] : "projeto";
  const aseprite = toolLabel(record, "aseprite", "asepritePath");
  const mgcb = toolLabel(record, "mgcb", "mgcbPath");
  const details = [aseprite, mgcb].filter((item): item is string => Boolean(item));
  return `Configuração validada (${scope})${details.length ? ` · ${details.join(" · ")}` : ""}.`;
}

function toolLabel(record: Record<string, unknown>, name: string, pathKey: string): string | undefined {
  const nested = record[name];
  const nestedRecord = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
  const path = nestedRecord?.["path"] ?? record[pathKey];
  const version = nestedRecord?.["version"];
  if (typeof path !== "string" && typeof version !== "string") return undefined;
  return `${name === "aseprite" ? "Aseprite" : "MGCB"}${typeof version === "string" ? ` ${version}` : ""}${typeof path === "string" ? ` — ${path}` : ""}`;
}
