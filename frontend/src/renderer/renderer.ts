/**
 * Renderer do workbench (ALPHA-0.1 P0.3 + fundação P0.4).
 *
 * Casca fina sobre os núcleos testados: WorkbenchModel (navegação governada),
 * EventLog (saída/problemas/histórico), ProjectLifecycle via preload
 * (toolbar de projeto) e, no editor de níveis, IntGridDocument +
 * CanvasViewport. Nenhum ID interno aparece: tudo passa pelo vocabulário.
 */

import { CanvasViewport } from "../core/canvasViewport.js";
import { EventLog } from "../core/eventLog.js";
import { IntGridDocument } from "../core/intGridDocument.js";
import { LEVEL_PALETTE, TILE_COLORS, defaultLevelRules } from "../core/levelPresets.js";
import { WorkbenchModel, type BottomTab } from "../core/workbenchModel.js";
import { panelLabel, projectStateLabel } from "../core/vocabulary.js";
import type { ResolvedExperienceLike } from "../core/experienceGate.js";
import type { P7mEditorApi, ProjectStatusPayload } from "../main/preload.js";
// type-only (apagado na compilação): o módulo real é vendorizado pelo build
import type { resolveAutoTiles as ResolveAutoTilesFn } from "@p7m/middleware/dist/leveldesign/AutoTiler.js";

/** AutoTiler vendorizado (zero dependências — regra R5): mesmo resolvedor da projeção. */
let resolveAutoTiles: typeof ResolveAutoTilesFn | undefined;
async function loadAutoTiler(): Promise<typeof ResolveAutoTilesFn> {
  if (!resolveAutoTiles) {
    const url = new URL("./vendor/AutoTiler.js", import.meta.url).toString();
    const module_ = (await import(url)) as { resolveAutoTiles: typeof ResolveAutoTilesFn };
    resolveAutoTiles = module_.resolveAutoTiles;
  }
  return resolveAutoTiles;
}

/** Ações do editor ativo (menu Editar e atalhos globais roteiam para cá). */
const activeEditor: { undo?: () => void; redo?: () => void } = {};

declare global {
  interface Window {
    p7m: P7mEditorApi;
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const model = new WorkbenchModel();
const log = new EventLog(500);

// ---------------------------------------------------------------- toolbar

function wireProjectToolbar(): void {
  const run = (command: Parameters<P7mEditorApi["projectCommand"]>[0]) => (): void => {
    void window.p7m.projectCommand(command).then(applyProjectStatus);
  };
  $("btn-new").addEventListener("click", run("new"));
  $("btn-open").addEventListener("click", run("open"));
  $("btn-save").addEventListener("click", run("save"));
  $("btn-close").addEventListener("click", run("close"));
}

function applyProjectStatus(status: ProjectStatusPayload): void {
  $("project-title").textContent = status.project
    ? `${status.isDirty ? "● " : ""}${status.project.name}`
    : "Nenhum projeto aberto";
  $("status-project").textContent = projectStateLabel(status.state);
  const hasProject = status.state !== "no-project";
  ($("btn-save") as HTMLButtonElement).disabled = !hasProject;
  ($("btn-close") as HTMLButtonElement).disabled = !hasProject;
}

// ------------------------------------------------------------------ rail

function renderRail(): void {
  const rail = $("panel-rail");
  rail.replaceChildren();
  for (const item of model.navigation()) {
    const button = document.createElement("button");
    button.className = "rail-item";
    button.textContent = item.label;
    button.setAttribute("aria-pressed", String(item.active));
    button.disabled = !item.enabled;
    if (item.reason) button.title = item.reason; // razão da governança no tooltip
    button.addEventListener("click", () => model.activatePanel(item.panelId));
    rail.append(button);
  }
}

// ----------------------------------------------------------------- views

/** Limpeza da vista corrente (listeners de teclado etc.) ao trocar de painel. */
let cleanupActiveView: (() => void) | undefined;

function renderView(): void {
  const host = $("view-host");
  cleanupActiveView?.();
  cleanupActiveView = undefined;
  host.replaceChildren();
  const panel = model.currentPanel;
  if (!panel) {
    host.append(placeholder("Bem-vindo ao P7M", "Crie ou abra um projeto para começar."));
    return;
  }
  if (panel === "level-editor") {
    mountLevelEditor(host);
    return;
  }
  host.append(
    placeholder(
      panelLabel(panel),
      "Este painel chega nas próximas iterações da milestone Alpha 0.1.",
    ),
  );
}

function placeholder(title: string, message: string): HTMLElement {
  const view = document.createElement("div");
  view.className = "placeholder-view";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  const p = document.createElement("p");
  p.textContent = message;
  view.append(h2, p);
  return view;
}

// ---------------------------------------------------- editor de níveis (P0.4)

function mountLevelEditor(host: HTMLElement): void {
  const doc = new IntGridDocument(48, 27);
  const tileSize = 16;
  let activeValue = 1;
  let tool: "pencil" | "eraser" | "flood" = "pencil";

  const view = document.createElement("div");
  view.id = "level-view";

  // toolbar do editor
  const toolbar = document.createElement("div");
  toolbar.id = "level-toolbar";
  const addButton = (label: string, onClick: () => void, title?: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    toolbar.append(b);
    return b;
  };

  const toolButtons = new Map<string, HTMLButtonElement>();
  const selectTool = (name: typeof tool): void => {
    tool = name;
    for (const [id, b] of toolButtons) b.setAttribute("aria-pressed", String(id === name));
  };
  toolButtons.set("pencil", addButton("Pincel", () => selectTool("pencil"), "Pintar célula (arraste)"));
  toolButtons.set("eraser", addButton("Borracha", () => selectTool("eraser")));
  toolButtons.set("flood", addButton("Balde", () => selectTool("flood"), "Preencher região conectada"));
  selectTool("pencil");

  toolbar.append(Object.assign(document.createElement("span"), { className: "sep" }));

  const swatches = new Map<number, HTMLButtonElement>();
  for (const entry of LEVEL_PALETTE) {
    const swatch = document.createElement("button");
    swatch.className = "palette-swatch";
    swatch.style.background = entry.color;
    swatch.title = `${entry.name} (tecla ${entry.shortcut})`;
    swatch.setAttribute("aria-label", entry.name);
    swatch.addEventListener("click", () => selectValue(entry.value));
    swatches.set(entry.value, swatch);
    toolbar.append(swatch);
  }
  const selectValue = (value: number): void => {
    activeValue = value;
    for (const [v, s] of swatches) s.setAttribute("aria-pressed", String(v === value));
  };
  selectValue(1);

  toolbar.append(Object.assign(document.createElement("span"), { className: "sep" }));
  const doUndo = (): void => { doc.undo(); onEdited(); };
  const doRedo = (): void => { doc.redo(); onEdited(); };
  const undoBtn = addButton("Desfazer", doUndo, "Ctrl+Z");
  const redoBtn = addButton("Refazer", doRedo, "Ctrl+Shift+Z");
  activeEditor.undo = doUndo;
  activeEditor.redo = doRedo;
  addButton("Enquadrar", () => { viewport.fit(doc.width, doc.height, tileSize); repaint(); });

  // "Pinte significado, derive arte": preview usa o MESMO resolvedor da projeção
  let artPreview = false;
  let previewTiles: Int32Array | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const previewBtn = addButton("Ver arte", () => {
    artPreview = !artPreview;
    previewBtn.setAttribute("aria-pressed", String(artPreview));
    schedulePreview(0);
  }, "Alterna entre significado (IntGrid) e arte derivada pelas regras");

  function schedulePreview(delayMs = 80): void {
    if (!artPreview) { repaint(); return; }
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      void loadAutoTiler().then((resolve) => {
        previewTiles = resolve(
          { width: doc.width, height: doc.height, values: doc.snapshot() },
          defaultLevelRules() as never,
          1,
        ).tiles;
        repaint();
      });
    }, delayMs);
  }

  function onEdited(): void {
    repaint();
    schedulePreview();
  }

  addButton("Publicar nível", () => void publish(), "Envia level/define pelo caminho canônico");

  // canvas
  const canvas = document.createElement("canvas");
  canvas.id = "level-canvas";
  const status = document.createElement("div");
  status.id = "level-status";
  status.textContent = "Pincel: pinte com o botão esquerdo · roda = zoom · botão do meio = pan";

  view.append(toolbar, canvas, status);
  host.append(view);

  const viewport = new CanvasViewport(800, 600);
  const context = canvas.getContext("2d")!;

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width));
    canvas.height = Math.max(1, Math.floor(rect.height));
    viewport.resize(canvas.width, canvas.height);
    repaint();
  };
  new ResizeObserver(resize).observe(canvas);

  const meaningColors = new Map(LEVEL_PALETTE.map((p) => [p.value, p.color]));

  function repaint(): void {
    context.fillStyle = "#101216";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const range = viewport.visibleCells(tileSize, doc.width, doc.height);
    const zoom = viewport.current.zoom;
    const gap = zoom > 4 ? 1 : 0;

    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        const screen = viewport.worldToScreen(x * tileSize, y * tileSize);
        const size = tileSize * zoom;
        let fill = "#1b1e24";
        if (artPreview && previewTiles) {
          const tileId = previewTiles[y * doc.width + x]!;
          if (tileId >= 0) fill = TILE_COLORS[tileId] ?? "#888";
        } else {
          const value = doc.valueAt(x, y);
          if (value !== 0) fill = meaningColors.get(value) ?? "#888";
        }
        context.fillStyle = fill;
        context.fillRect(screen.x, screen.y, size - gap, size - gap);
      }
    }
    undoBtn.disabled = !doc.canUndo;
    redoBtn.disabled = !doc.canRedo;
  }

  const applyAt = (offsetX: number, offsetY: number): void => {
    const cell = viewport.screenToCell(offsetX, offsetY, tileSize, doc.width, doc.height);
    if (!cell.inside) return;
    if (tool === "pencil") doc.paint(cell.x, cell.y, activeValue);
    else if (tool === "eraser") doc.paint(cell.x, cell.y, 0);
    else doc.floodFill(cell.x, cell.y, activeValue);
    onEdited();
  };

  // Atalhos do editor: dígitos selecionam o significado, Ctrl+Z/Shift+Z desfazem
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    const paletteEntry = LEVEL_PALETTE.find((p) => p.shortcut === e.key);
    if (paletteEntry) { selectValue(paletteEntry.value); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      doRedo();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  cleanupActiveView = (): void => {
    window.removeEventListener("keydown", onKeyDown);
    delete activeEditor.undo;
    delete activeEditor.redo;
  };

  let painting = false;
  let panning = false;
  let last = { x: 0, y: 0 };
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 1) { panning = true; last = { x: e.offsetX, y: e.offsetY }; e.preventDefault(); return; }
    if (e.button === 0) { painting = true; applyAt(e.offsetX, e.offsetY); }
  });
  canvas.addEventListener("mousemove", (e) => {
    const cell = viewport.screenToCell(e.offsetX, e.offsetY, tileSize, doc.width, doc.height);
    status.textContent = cell.inside ? `Célula (${cell.x}, ${cell.y})` : "Fora do nível";
    if (panning) {
      viewport.panByScreen(e.offsetX - last.x, e.offsetY - last.y);
      last = { x: e.offsetX, y: e.offsetY };
      repaint();
    } else if (painting && tool !== "flood") {
      applyAt(e.offsetX, e.offsetY);
    }
  });
  window.addEventListener("mouseup", () => { painting = false; panning = false; });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    viewport.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    repaint();
  }, { passive: false });

  async function publish(): Promise<void> {
    const payload = doc.toLevelPayload({
      levelId: "nivel-1",
      tileSize,
      seed: 1,
      rules: [
        { name: "chao", patternSize: 1, pattern: [1], tileIds: [1] },
        { name: "parede", patternSize: 1, pattern: [2], tileIds: [2] },
        { name: "perigo", patternSize: 1, pattern: [3], tileIds: [3] },
      ],
    });
    try {
      await window.p7m.dispatch("level/define", payload);
      status.textContent = "Nível publicado no runtime.";
    } catch (err) {
      status.textContent = `Falha ao publicar: ${err instanceof Error ? err.message : err}`;
    }
  }

  resize();
  viewport.fit(doc.width, doc.height, tileSize);
  repaint();
}

// ---------------------------------------------------------- painel inferior

function wireBottomPanel(): void {
  for (const tabButton of document.querySelectorAll<HTMLButtonElement>("#bottom-tabs [role=tab]")) {
    tabButton.addEventListener("click", () => model.selectBottomTab(tabButton.dataset["tab"] as BottomTab));
  }
  $("log-filter").addEventListener("input", renderBottom);
}

function renderBottom(): void {
  const tab = model.currentBottomTab;
  for (const tabButton of document.querySelectorAll<HTMLButtonElement>("#bottom-tabs [role=tab]")) {
    tabButton.setAttribute("aria-selected", String(tabButton.dataset["tab"] === tab));
  }
  const content = $("bottom-content");
  content.replaceChildren();
  const filterText = ($("log-filter") as HTMLInputElement).value;

  if (tab === "problems") {
    const problems = log
      .list({ ...(filterText ? { text: filterText } : {}) })
      .filter((e) => e.projectionStatus === "skipped" || e.projectionStatus === "deferred");
    if (problems.length === 0) {
      content.append(placeholder("Nenhum problema", "Tudo aplicado no runtime."));
      return;
    }
    for (const entry of problems) {
      const card = document.createElement("div");
      card.className = "problem-card";
      const title = document.createElement("strong");
      title.textContent = entry.summary;
      const reason = document.createElement("div");
      reason.className = "reason";
      reason.textContent = `${entry.projectionLabel}${entry.projectionReason ? ` — ${entry.projectionReason}` : ""}`;
      card.append(title, reason);
      content.append(card);
    }
    return;
  }

  const entries = log.list({ ...(filterText ? { text: filterText } : {}) });
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "log-row";
    const time = document.createElement("time");
    time.textContent = new Date(entry.timestampMs).toLocaleTimeString();
    const label = document.createElement("span");
    label.textContent = entry.summary;
    row.append(time, label);
    if (tab === "output" && entry.projectionLabel) {
      const status = document.createElement("span");
      status.className = `status-${entry.projectionStatus}`;
      status.textContent = entry.projectionLabel;
      row.append(status);
    }
    content.append(row);
  }
}

function refreshProblemBadge(): void {
  const badge = $("problem-count");
  badge.textContent = String(log.problemCount);
  badge.dataset["zero"] = String(log.problemCount === 0);
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  wireProjectToolbar();
  wireBottomPanel();
  model.onChange(() => {
    renderRail();
    renderView();
    renderBottom();
  });
  renderRail();
  renderView();
  renderBottom();

  window.p7m.onProjectStatus(applyProjectStatus);
  window.p7m.onMenuAction((action) => {
    if (action === "undo") activeEditor.undo?.();
    else if (action === "redo") activeEditor.redo?.();
  });
  window.p7m.onBlueprintEvent((event) => {
    log.record(event as { kind: string } & Record<string, unknown>);
    refreshProblemBadge();
    renderBottom();
  });

  try {
    await window.p7m.connect();
    $("connection-dot").className = "dot online";
    $("status-connection").textContent = "Conectado ao middleware";
    applyProjectStatus(await window.p7m.projectStatus());

    const experience = (await window.p7m.experience()) as ResolvedExperienceLike;
    model.applyExperience(experience);
    $("runtime-label").textContent = model.runtimeLabel;
  } catch (err) {
    $("connection-dot").className = "dot offline";
    $("status-connection").textContent =
      `Sem conexão com o middleware — verifique os serviços e tente novamente. (${err instanceof Error ? err.message : err})`;
    const retry = document.createElement("button");
    retry.textContent = "Tentar reconectar";
    retry.addEventListener("click", () => window.location.reload());
    $("status-bar").append(retry);
  }
}

void boot();
