/** Project/Levels/Entities/Assets tree backed by the canonical projection store. */

import type { LevelEditorStore, LevelEditorStoreSnapshot } from "../core/levelEditorStore.js";
import type { PanelInstance } from "../core/panelRegistry.js";
import type { ProjectStatusPayload } from "../core/projectApi.js";
import type { Selection, SelectionService } from "../core/selectionService.js";

export interface ProjectExplorerPanelOptions {
  readonly host: HTMLElement;
  readonly store: LevelEditorStore;
  readonly selection: SelectionService;
  readonly projectStatus: () => ProjectStatusPayload | undefined;
}

export function mountProjectExplorer(options: ProjectExplorerPanelOptions): PanelInstance {
  const render = (): void => renderTree(options);
  const releaseStore = options.store.onChange(render);
  const releaseSelection = options.selection.subscribe(render);
  render();
  return {
    activate: render,
    focus: () => options.host.querySelector<HTMLElement>("[role='treeitem']")?.focus(),
    dispose: () => {
      releaseStore();
      releaseSelection();
      options.host.replaceChildren();
    },
  };
}

function renderTree(options: ProjectExplorerPanelOptions): void {
  const focusedKey = options.host.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset["treeSelectionKey"]
    : undefined;
  const status = options.projectStatus();
  const project = status?.project;
  const sessionId = project?.projectSessionId;
  const snapshot = options.store.snapshot;
  const projectId = project?.projectId ?? snapshot.projectId;
  if (!project || !sessionId || !projectId) {
    const empty = document.createElement("p");
    empty.className = "muted project-tree-empty";
    empty.textContent = "Abra ou crie um projeto para ver sua estrutura.";
    options.host.replaceChildren(empty);
    return;
  }
  if (options.store.cursor?.projectSessionId !== sessionId) {
    const loading = document.createElement("p");
    loading.className = "muted project-tree-empty";
    loading.textContent = "Preparando a projeção da sessão…";
    options.host.replaceChildren(loading);
    return;
  }

  const tree = document.createElement("div");
  tree.className = "project-tree";
  tree.role = "tree";
  tree.setAttribute("aria-label", "Estrutura do projeto");
  const scope = { projectSessionId: sessionId, projectId } as const;
  tree.append(treeItem({
    label: project.name,
    icon: "▣",
    depth: 1,
    selection: { kind: "project", ...scope },
    service: options.selection,
    source: "project-tree",
  }));
  tree.append(group("Níveis", "▦", 1, snapshot.levels.map((level) => treeItem({
    label: level.levelId,
    detail: `${level.width}×${level.height} · ${level.tileSize} px`,
    icon: "◇",
    depth: 2,
    selection: { kind: "level", ...scope, levelId: level.levelId },
    service: options.selection,
    source: "project-tree",
    onSelect: () => options.store.select(level.levelId),
  }))));
  tree.append(group("Entidades", "♙", 1, entityItems(snapshot, scope, options.selection)));
  tree.append(group("Assets", "▧", 1, assetItems(snapshot, scope, options.selection)));
  tree.append(group("Câmera", "◉", 1, [treeItem({
    label: "Câmera do projeto",
    icon: "◉",
    depth: 2,
    selection: { kind: "camera", ...scope, cameraId: projectId },
    service: options.selection,
    source: "project-tree",
  })]));
  tree.append(group("Luzes", "✦", 1, snapshot.lights.map((light) => treeItem({
    label: light.lightId,
    detail: light.type,
    icon: "✦",
    depth: 2,
    selection: { kind: "light", ...scope, lightId: light.lightId },
    service: options.selection,
    source: "project-tree",
  }))));
  options.host.replaceChildren(tree);
  wireTreeKeyboard(tree);
  if (focusedKey) {
    const focused = [...tree.querySelectorAll<HTMLButtonElement>("[data-tree-selection-key]")]
      .find((candidate) => candidate.dataset["treeSelectionKey"] === focusedKey);
    if (focused) {
      tree.querySelectorAll<HTMLButtonElement>("[role='treeitem']")
        .forEach((candidate) => { candidate.tabIndex = candidate === focused ? 0 : -1; });
      focused.focus();
    }
  }
}

function entityItems(
  snapshot: LevelEditorStoreSnapshot,
  scope: { readonly projectSessionId: string; readonly projectId: string },
  selection: SelectionService,
): HTMLElement[] {
  const definitions = snapshot.entityDefinitions.map((definition) => treeItem({
    label: definition.entityDefId,
    detail: "Definição",
    icon: definition.editor?.icon ?? "◆",
    depth: 2,
    selection: {
      kind: "entity-definition",
      ...scope,
      definitionId: definition.entityDefId,
    },
    service: selection,
    source: "project-tree",
  }));
  const instances = snapshot.entities.map((entity) => treeItem({
    label: entity.entityId,
    detail: entity.entityDefId,
    icon: "●",
    depth: 2,
    selection: { kind: "entity-instance", ...scope, entityId: entity.entityId },
    service: selection,
    source: "project-tree",
  }));
  return [...definitions, ...instances];
}

function assetItems(
  snapshot: LevelEditorStoreSnapshot,
  scope: { readonly projectSessionId: string; readonly projectId: string },
  selection: SelectionService,
): HTMLElement[] {
  return [
    ...snapshot.skeletons.map((asset) => treeItem({
      label: asset.skeletonId,
      detail: "Esqueleto",
      icon: "⌘",
      depth: 2,
      selection: { kind: "asset", ...scope, assetId: asset.skeletonId, assetType: "skeleton" },
      service: selection,
      source: "project-tree",
    })),
    ...snapshot.meshes.map((asset) => treeItem({
      label: asset.meshId,
      detail: "Malha",
      icon: "△",
      depth: 2,
      selection: { kind: "asset", ...scope, assetId: asset.meshId, assetType: "mesh" },
      service: selection,
      source: "project-tree",
    })),
  ];
}

function group(label: string, icon: string, depth: number, children: readonly HTMLElement[]): HTMLElement {
  const container = document.createElement("section");
  container.className = "project-tree-group";
  container.role = "group";
  const heading = document.createElement("div");
  heading.className = "project-tree-heading";
  heading.dataset["treeDepth"] = String(depth);
  heading.textContent = `${icon} ${label}`;
  const count = document.createElement("span");
  count.textContent = String(children.length);
  count.setAttribute("aria-label", `${children.length} itens`);
  heading.append(count);
  container.append(heading);
  if (children.length > 0) container.append(...children);
  else {
    const empty = document.createElement("p");
    empty.className = "project-tree-group-empty";
    empty.textContent = "Nenhum item";
    container.append(empty);
  }
  return container;
}

interface TreeItemOptions {
  readonly label: string;
  readonly detail?: string;
  readonly icon: string;
  readonly depth: number;
  readonly selection: Selection;
  readonly service: SelectionService;
  readonly source: string;
  readonly onSelect?: () => void;
}

function treeItem(options: TreeItemOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "project-tree-item";
  button.role = "treeitem";
  button.dataset["treeDepth"] = String(options.depth);
  button.dataset["treeSelectionKey"] = selectionIdentityKey(options.selection);
  const selected = treeItemReflectsSelection(options.service.current, options.selection);
  button.setAttribute("aria-selected", String(selected));
  button.tabIndex = selected ? 0 : -1;
  const icon = document.createElement("span");
  icon.className = "tree-item-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = options.icon;
  const label = document.createElement("span");
  label.textContent = options.label;
  button.append(icon, label);
  if (options.detail) {
    const detail = document.createElement("small");
    detail.textContent = options.detail;
    button.append(detail);
  }
  button.addEventListener("click", () => {
    options.onSelect?.();
    options.service.select(options.selection, options.source);
  });
  return button;
}

function selectionIdentityKey(selection: Selection): string {
  if (selection.kind === "level" || selection.kind === "cell") return `level:${selection.levelId}`;
  if (selection.kind === "entity-definition") return `entity-definition:${selection.definitionId}`;
  if (selection.kind === "entity-instance") return `entity-instance:${selection.entityId}`;
  if (selection.kind === "asset") return `asset:${selection.assetId}`;
  if (selection.kind === "camera") return `camera:${selection.cameraId}`;
  if (selection.kind === "light") return `light:${selection.lightId}`;
  if (selection.kind === "problem") return `problem:${selection.problemId}`;
  return `project:${selection.projectId}`;
}

/**
 * Projeta a seleção transversal na árvore, que não materializa células como
 * nós próprios. Uma célula mantém seu nível ancestral selecionado; os demais
 * itens continuam usando identidade semântica exata.
 */
export function treeItemReflectsSelection(
  left: Selection | undefined,
  right: Selection,
): boolean {
  if (!left || left.projectSessionId !== right.projectSessionId || left.projectId !== right.projectId) {
    return false;
  }
  if (left.kind === "cell" && right.kind === "level") return left.levelId === right.levelId;
  if (left.kind !== right.kind) return false;
  const identityKey: Partial<Record<Selection["kind"], string>> = {
    project: "projectId",
    level: "levelId",
    "entity-definition": "definitionId",
    "entity-instance": "entityId",
    asset: "assetId",
    camera: "cameraId",
    light: "lightId",
    problem: "problemId",
  };
  const key = identityKey[right.kind];
  return key ? (left as unknown as Record<string, unknown>)[key] ===
    (right as unknown as Record<string, unknown>)[key] : false;
}

function wireTreeKeyboard(tree: HTMLElement): void {
  const items = [...tree.querySelectorAll<HTMLButtonElement>("[role='treeitem']")];
  if (!items.some((item) => item.tabIndex === 0) && items[0]) items[0].tabIndex = 0;
  items.forEach((item, index) => item.addEventListener("keydown", (event) => {
    let target: HTMLButtonElement | undefined;
    if (event.key === "Home") target = items[0];
    else if (event.key === "End") target = items.at(-1);
    else if (event.key === "ArrowUp") target = items[(index - 1 + items.length) % items.length];
    else if (event.key === "ArrowDown") target = items[(index + 1) % items.length];
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      item.click();
      return;
    } else return;
    event.preventDefault();
    items.forEach((candidate) => { candidate.tabIndex = candidate === target ? 0 : -1; });
    target?.focus();
  }));
}
