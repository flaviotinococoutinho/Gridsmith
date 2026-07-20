import { safeAssetPreviewUrl, type AssetBrowserController } from "../core/assetBrowserModel.js";
import type { AssetAnimationClip, AssetDetails, AssetSpriteSlice } from "../core/assetApi.js";
import type { PanelInstance } from "../core/panelRegistry.js";

export interface SpriteRendererTarget {
  readonly definitionId: string;
  readonly label: string;
  readonly hasSpriteRenderer: boolean;
}

export interface AsepriteInspectorPanelOptions {
  readonly host: HTMLElement;
  readonly controller: AssetBrowserController;
  readonly selectedAssetId: () => string | undefined;
  readonly spriteRendererTarget: () => SpriteRendererTarget | undefined;
  readonly onAssociate: (assetId: string, defaultClip: string | undefined) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export function mountAsepriteInspector(options: AsepriteInspectorPanelOptions): PanelInstance {
  let disposed = false;
  let renderVersion = 0;
  let observedCatalogKey = "";

  const render = async (force = false): Promise<void> => {
    const version = ++renderVersion;
    const assetId = options.selectedAssetId();
    if (!assetId) {
      options.host.replaceChildren(emptyState(options.host.ownerDocument, "Selecione um asset no catálogo."));
      return;
    }
    options.host.replaceChildren(emptyState(options.host.ownerDocument, "Carregando metadados do Aseprite…"));
    try {
      const details = await options.controller.details(assetId, force);
      if (disposed || version !== renderVersion || options.selectedAssetId() !== assetId) return;
      options.host.replaceChildren(inspectorContent(details, options));
    } catch (error) {
      if (disposed || version !== renderVersion) return;
      options.host.replaceChildren(errorState(options.host.ownerDocument, error, () => void render()));
      options.onError?.(error);
    }
  };

  const release = options.controller.subscribe(() => {
    const assetId = options.selectedAssetId();
    const key = assetInspectorCatalogKey(options.controller.snapshot.catalogVersion, assetId);
    if (!assetId || key === observedCatalogKey) return;
    observedCatalogKey = key;
    void render(true);
  });
  observedCatalogKey = assetInspectorCatalogKey(
    options.controller.snapshot.catalogVersion,
    options.selectedAssetId(),
  );
  void render();
  return {
    activate: () => void render(),
    focus: () => options.host.querySelector<HTMLElement>("button, select, [tabindex]")?.focus(),
    dispose: () => {
      disposed = true;
      renderVersion++;
      release();
      options.host.replaceChildren();
    },
  };
}

export function assetInspectorCatalogKey(catalogVersion: number, assetId: string | undefined): string {
  return assetId ? `${assetId}@${catalogVersion}` : "";
}

function inspectorContent(details: AssetDetails, options: AsepriteInspectorPanelOptions): HTMLElement {
  const document = options.host.ownerDocument;
  const root = document.createElement("div");
  root.className = "aseprite-inspector";
  const title = document.createElement("h2");
  title.textContent = details.asset.name;
  const source = document.createElement("p");
  source.className = "muted asset-source-path";
  source.textContent = details.asset.sourcePath;
  source.title = details.asset.sourcePath;
  root.append(title, source);

  const previewUrl = safeAssetPreviewUrl(details.asset.thumbnailDataUrl) ??
    safeAssetPreviewUrl(details.asset.thumbnailPath);
  if (previewUrl) {
    const image = document.createElement("img");
    image.className = "aseprite-preview";
    image.src = previewUrl;
    image.alt = `Spritesheet de ${details.asset.name}`;
    root.append(image);
  }

  const facts = document.createElement("dl");
  facts.className = "asset-facts";
  appendFact(facts, "Tipo", details.asset.kind);
  appendFact(facts, "Revisão", String(details.asset.revision));
  appendFact(facts, "Frames", String(details.frames.length));
  appendFact(facts, "Tags", details.asset.tags.join(", ") || "Sem tags");
  appendFact(facts, "Atualizado", formattedTimestamp(details.asset.updatedAt));
  root.append(facts);

  const clipSection = document.createElement("section");
  const clipHeading = document.createElement("h3");
  clipHeading.textContent = "Tags e clips";
  const defaultClip = document.createElement("select");
  defaultClip.setAttribute("aria-label", "Clip padrão do SpriteRenderer");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Sem clip padrão";
  defaultClip.append(none, ...details.clips.map((clip) => clipOption(document, clip)));
  const clips = document.createElement("div");
  clips.className = "asset-inspector-list";
  clips.replaceChildren(...details.clips.map((clip) => clipCard(document, clip)));
  if (details.clips.length === 0) clips.append(emptyState(document, "Nenhuma tag de animação."));
  clipSection.append(clipHeading, defaultClip, clips);
  root.append(clipSection);

  const frameSection = document.createElement("details");
  const frameSummary = document.createElement("summary");
  frameSummary.textContent = `Frames (${details.frames.length})`;
  const frames = document.createElement("div");
  frames.className = "asset-inspector-list";
  frames.append(...details.frames.map((frame) => {
    const row = document.createElement("code");
    row.textContent = `#${frame.index}  ${frame.x},${frame.y}  ${frame.w}×${frame.h}  ${frame.durationMs} ms`;
    return row;
  }));
  frameSection.append(frameSummary, frames);
  root.append(frameSection);

  const slicesSection = document.createElement("section");
  const slicesHeading = document.createElement("h3");
  slicesHeading.textContent = "Slices, pivôs e 9-slice";
  const slices = document.createElement("div");
  slices.className = "asset-inspector-list";
  slices.replaceChildren(...details.slices.map((slice) => sliceCard(document, slice)));
  if (details.slices.length === 0) slices.append(emptyState(document, "Nenhum slice definido."));
  slicesSection.append(slicesHeading, slices);
  root.append(slicesSection);

  const actions = document.createElement("div");
  actions.className = "asset-inspector-actions";
  const reimport = button(document, "Reimportar");
  const openSource = button(document, "Abrir fonte");
  const revealOutput = button(document, "Revelar artefato");
  reimport.addEventListener("click", () => options.controller.reimport(details.asset.assetId));
  openSource.addEventListener("click", () => void options.controller.revealSource(details.asset.assetId).catch(options.onError));
  revealOutput.addEventListener("click", () => void options.controller.revealOutput(details.asset.assetId).catch(options.onError));
  actions.append(reimport, openSource, revealOutput);

  const target = options.spriteRendererTarget();
  const associate = button(
    document,
    target?.hasSpriteRenderer ? "Associar ao SpriteRenderer" : "Criar SpriteRenderer",
  );
  associate.disabled = !target;
  associate.title = target
    ? `${target.hasSpriteRenderer ? "Atualizar" : "Criar"} componente em ${target.label}`
    : "Selecione antes uma entidade ou definição como alvo.";
  associate.addEventListener("click", () => {
    associate.disabled = true;
    void options.onAssociate(details.asset.assetId, defaultClip.value || undefined)
      .catch(options.onError)
      .finally(() => { associate.disabled = false; });
  });
  actions.append(associate);
  root.append(actions);
  return root;
}

function clipOption(document: Document, clip: AssetAnimationClip): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = clip.name;
  option.textContent = `${clip.name} (${clip.durationMs} ms)`;
  return option;
}

function clipCard(document: Document, clip: AssetAnimationClip): HTMLElement {
  const card = document.createElement("article");
  card.className = "asset-metadata-card";
  const title = document.createElement("strong");
  title.textContent = clip.name;
  const detail = document.createElement("span");
  detail.textContent = `frames ${clip.from}–${clip.to} · ${directionLabel(clip.direction)} · ${clip.durationMs} ms`;
  const playback = document.createElement("code");
  playback.textContent = clip.playback.join(" → ");
  card.append(title, detail, playback);
  return card;
}

function sliceCard(document: Document, slice: AssetSpriteSlice): HTMLElement {
  const card = document.createElement("article");
  card.className = "asset-metadata-card";
  const title = document.createElement("strong");
  title.textContent = slice.name;
  const bounds = document.createElement("span");
  bounds.textContent = `Bounds: ${rectLabel(slice.bounds)}`;
  card.append(title, bounds);
  if (slice.pivot) {
    const pivot = document.createElement("span");
    pivot.textContent = `Pivô: ${slice.pivot.x}, ${slice.pivot.y}`;
    card.append(pivot);
  }
  const nineSlice = document.createElement("span");
  nineSlice.textContent = slice.center ? `9-slice: centro ${rectLabel(slice.center)}` : "9-slice: não definido";
  card.append(nineSlice);
  return card;
}

function appendFact(list: HTMLDListElement, label: string, value: string): void {
  const term = list.ownerDocument.createElement("dt");
  term.textContent = label;
  const description = list.ownerDocument.createElement("dd");
  description.textContent = value;
  list.append(term, description);
}

function emptyState(document: Document, message: string): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = "muted panel-empty-state";
  paragraph.textContent = message;
  return paragraph;
}

function errorState(document: Document, error: unknown, retry: () => void): HTMLElement {
  const section = document.createElement("section");
  section.className = "panel-unavailable";
  section.setAttribute("role", "alert");
  const message = document.createElement("p");
  message.textContent = error instanceof Error ? error.message : String(error);
  const retryButton = button(document, "Tentar novamente");
  retryButton.addEventListener("click", retry);
  section.append(message, retryButton);
  return section;
}

function button(document: Document, label: string): HTMLButtonElement {
  const value = document.createElement("button");
  value.type = "button";
  value.textContent = label;
  return value;
}

function rectLabel(rect: { x: number; y: number; w: number; h: number }): string {
  return `${rect.x}, ${rect.y} · ${rect.w}×${rect.h}`;
}

function directionLabel(direction: string): string {
  if (direction === "reverse") return "reversa";
  if (direction === "pingpong") return "ping-pong";
  return "normal";
}

function formattedTimestamp(value: string): string {
  const timestamp = Number(value);
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("pt-BR");
}
