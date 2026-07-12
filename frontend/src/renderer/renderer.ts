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
import { IntGridDocument, lineCells } from "../core/intGridDocument.js";
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
  const LEVEL_ID = "nivel-1";
  let doc = new IntGridDocument(48, 27);
  // integração com o save (P0.2 ⇄ P0.4): publicações viram level/define ou
  // level/update no Blueprint — e daí para o documento salvo do projeto
  let levelInBlueprint = false;
  const tileSize = 16;
  let activeValue = 1;
  type Tool = "pencil" | "eraser" | "flood" | "rect" | "line" | "picker" | "entity";
  let tool: Tool = "pencil";

  // camada de entidades (P0.4 placement ⇄ P0.6 spawn): marcadores em pixels
  // do mundo, hidratados do Blueprint e mantidos pelos próprios dispatches
  interface EntityMarker {
    entityId: string;
    position: [number, number];
  }
  const ENTITY_DEF = { entityDefId: "jogador", archetypeId: "player" };
  const entities = new Map<string, EntityMarker>();
  let entityDefEnsured = false;
  let selectedEntityId: string | undefined;
  let draggingEntity: EntityMarker | undefined;

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
  toolButtons.set("rect", addButton("Retângulo", () => selectTool("rect"), "Arraste para preencher a área"));
  toolButtons.set("line", addButton("Linha", () => selectTool("line"), "Arraste para traçar uma linha"));
  toolButtons.set("picker", addButton("Conta-gotas", () => selectTool("picker"), "Clique para pegar o significado da célula"));
  toolButtons.set("entity", addButton("Jogador", () => selectTool("entity"), "Clique posiciona, arraste move, Delete remove"));
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

  addButton("Publicar nível", () => void publish(), "Grava o nível no projeto pelo caminho canônico");

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

  // arrasto de retângulo/linha: âncora + célula corrente para o ghost
  let dragAnchor: { x: number; y: number } | undefined;
  let dragCurrent: { x: number; y: number } | undefined;

  function ghostCells(): Array<[number, number]> {
    if (!dragAnchor || !dragCurrent) return [];
    if (tool === "line") return lineCells(dragAnchor.x, dragAnchor.y, dragCurrent.x, dragCurrent.y);
    const cells: Array<[number, number]> = [];
    const [minX, maxX] = dragAnchor.x <= dragCurrent.x ? [dragAnchor.x, dragCurrent.x] : [dragCurrent.x, dragAnchor.x];
    const [minY, maxY] = dragAnchor.y <= dragCurrent.y ? [dragAnchor.y, dragCurrent.y] : [dragCurrent.y, dragAnchor.y];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) cells.push([x, y]);
    return cells;
  }

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

    // ghost do retângulo/linha em andamento (semitransparente na cor ativa)
    if (dragAnchor && dragCurrent) {
      context.globalAlpha = 0.55;
      context.fillStyle = meaningColors.get(activeValue) ?? "#888";
      const size = tileSize * zoom;
      for (const [x, y] of ghostCells()) {
        const screen = viewport.worldToScreen(x * tileSize, y * tileSize);
        context.fillRect(screen.x, screen.y, size - gap, size - gap);
      }
      context.globalAlpha = 1;
    }

    // marcadores de entidade (círculo com inicial; anel na seleção)
    for (const marker of entities.values()) {
      const screen = viewport.worldToScreen(marker.position[0], marker.position[1]);
      const radius = Math.max(5, tileSize * 0.45 * zoom);
      context.beginPath();
      context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      context.fillStyle = "#3aa0f0";
      context.fill();
      if (marker.entityId === selectedEntityId) {
        context.lineWidth = 2;
        context.strokeStyle = "#ffffff";
        context.stroke();
      }
      context.fillStyle = "#fff";
      context.font = `${Math.max(8, radius)}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("J", screen.x, screen.y);
    }

    undoBtn.disabled = !doc.canUndo;
    redoBtn.disabled = !doc.canRedo;
  }

  // ---- camada de entidades: hit-test, placement, drag e remoção ----

  function entityAtScreen(offsetX: number, offsetY: number): EntityMarker | undefined {
    const zoom = viewport.current.zoom;
    const hitRadius = Math.max(6, tileSize * 0.5 * zoom);
    for (const marker of entities.values()) {
      const screen = viewport.worldToScreen(marker.position[0], marker.position[1]);
      if (Math.hypot(screen.x - offsetX, screen.y - offsetY) <= hitRadius) return marker;
    }
    return undefined;
  }

  /** Posição do clique em pixels do mundo, ancorada no centro da célula. */
  function snapToCellCenter(offsetX: number, offsetY: number): [number, number] | undefined {
    const cell = viewport.screenToCell(offsetX, offsetY, tileSize, doc.width, doc.height);
    if (!cell.inside) return undefined;
    return [cell.x * tileSize + tileSize / 2, cell.y * tileSize + tileSize / 2];
  }

  async function ensureEntityDef(): Promise<void> {
    if (entityDefEnsured) return;
    try {
      await window.p7m.dispatch("entitydef/define", { ...ENTITY_DEF, fields: [] });
    } catch {
      // já definida (projeto reaberto): a definição vive no Blueprint
    }
    entityDefEnsured = true;
  }

  async function placeEntityAt(position: [number, number]): Promise<void> {
    await ensureEntityDef();
    let n = entities.size + 1;
    while (entities.has(`${ENTITY_DEF.entityDefId}-${n}`)) n++;
    const entityId = `${ENTITY_DEF.entityDefId}-${n}`;
    await window.p7m.dispatch("entity/place", {
      entityId,
      entityDefId: ENTITY_DEF.entityDefId,
      position,
      fields: {},
    });
    entities.set(entityId, { entityId, position });
    selectedEntityId = entityId;
    status.textContent = `Jogador posicionado em (${position[0]}, ${position[1]}).`;
    repaint();
  }

  async function moveEntity(marker: EntityMarker, position: [number, number]): Promise<void> {
    await window.p7m.dispatch("entity/move", { entityId: marker.entityId, position });
    status.textContent = `Jogador movido para (${position[0]}, ${position[1]}).`;
  }

  async function removeSelectedEntity(): Promise<void> {
    if (!selectedEntityId) return;
    const entityId = selectedEntityId;
    await window.p7m.dispatch("entity/remove", { entityId });
    entities.delete(entityId);
    selectedEntityId = undefined;
    status.textContent = "Jogador removido.";
    repaint();
  }

  const applyAt = (offsetX: number, offsetY: number): void => {
    const cell = viewport.screenToCell(offsetX, offsetY, tileSize, doc.width, doc.height);
    if (!cell.inside) return;
    if (tool === "pencil") doc.paint(cell.x, cell.y, activeValue);
    else if (tool === "eraser") doc.paint(cell.x, cell.y, 0);
    else if (tool === "flood") doc.floodFill(cell.x, cell.y, activeValue);
    onEdited();
  };

  // Atalhos do editor: dígitos selecionam o significado, Ctrl+Z/Shift+Z desfazem
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    const paletteEntry = LEVEL_PALETTE.find((p) => p.shortcut === e.key);
    if (paletteEntry) { selectValue(paletteEntry.value); return; }
    if (e.key === "Delete" && selectedEntityId) {
      e.preventDefault();
      void removeSelectedEntity();
      return;
    }
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
    if (e.button !== 0) return;

    if (tool === "picker") {
      const cell = viewport.screenToCell(e.offsetX, e.offsetY, tileSize, doc.width, doc.height);
      if (cell.inside) {
        const value = doc.valueAt(cell.x, cell.y);
        if (value > 0) selectValue(value);
        selectTool(value > 0 ? "pencil" : "eraser");
        status.textContent = value > 0
          ? `Significado "${LEVEL_PALETTE.find((p) => p.value === value)?.name ?? value}" selecionado.`
          : "Célula vazia: borracha selecionada.";
      }
      return;
    }

    if (tool === "entity") {
      const hit = entityAtScreen(e.offsetX, e.offsetY);
      if (hit) {
        selectedEntityId = hit.entityId;
        draggingEntity = hit;
        repaint();
        return;
      }
      const position = snapToCellCenter(e.offsetX, e.offsetY);
      if (position) {
        void placeEntityAt(position).catch((err) => {
          status.textContent = `Falha ao posicionar: ${err instanceof Error ? err.message : err}`;
        });
      }
      return;
    }

    if (tool === "rect" || tool === "line") {
      const cell = viewport.screenToCell(e.offsetX, e.offsetY, tileSize, doc.width, doc.height);
      if (cell.inside) {
        dragAnchor = { x: cell.x, y: cell.y };
        dragCurrent = { x: cell.x, y: cell.y };
        repaint();
      }
      return;
    }

    painting = true;
    applyAt(e.offsetX, e.offsetY);
  });
  canvas.addEventListener("mousemove", (e) => {
    const cell = viewport.screenToCell(e.offsetX, e.offsetY, tileSize, doc.width, doc.height);
    status.textContent = cell.inside ? `Célula (${cell.x}, ${cell.y})` : "Fora do nível";
    if (panning) {
      viewport.panByScreen(e.offsetX - last.x, e.offsetY - last.y);
      last = { x: e.offsetX, y: e.offsetY };
      repaint();
    } else if (draggingEntity) {
      const position = snapToCellCenter(e.offsetX, e.offsetY);
      if (position) {
        draggingEntity.position = position; // feedback local; o dispatch sela no mouseup
        repaint();
      }
    } else if (dragAnchor && cell.inside) {
      dragCurrent = { x: cell.x, y: cell.y };
      repaint();
    } else if (painting && (tool === "pencil" || tool === "eraser")) {
      applyAt(e.offsetX, e.offsetY);
    }
  });
  window.addEventListener("mouseup", () => {
    if (draggingEntity) {
      const marker = draggingEntity;
      draggingEntity = undefined;
      void moveEntity(marker, marker.position).catch((err) => {
        status.textContent = `Falha ao mover: ${err instanceof Error ? err.message : err}`;
      });
    }
    if (dragAnchor && dragCurrent) {
      if (tool === "rect") doc.fillRect(dragAnchor.x, dragAnchor.y, dragCurrent.x, dragCurrent.y, activeValue);
      else if (tool === "line") doc.paintLine(dragAnchor.x, dragAnchor.y, dragCurrent.x, dragCurrent.y, activeValue);
      dragAnchor = undefined;
      dragCurrent = undefined;
      onEdited();
    }
    painting = false;
    panning = false;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    viewport.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    repaint();
  }, { passive: false });

  async function publish(): Promise<void> {
    // as MESMAS regras do preview ("Ver arte"): preview ≡ publicação
    const payload = doc.toLevelPayload({
      levelId: LEVEL_ID,
      tileSize,
      seed: 1,
      rules: defaultLevelRules(),
    });
    try {
      await window.p7m.dispatch(levelInBlueprint ? "level/update" : "level/define", payload);
      levelInBlueprint = true;
      status.textContent = "Nível publicado — salve o projeto para persistir (Ctrl+S).";
    } catch (err) {
      status.textContent = `Falha ao publicar: ${err instanceof Error ? err.message : err}`;
    }
  }

  resize();
  viewport.fit(doc.width, doc.height, tileSize);
  repaint();

  // Hidratação: nível e entidades já publicados (projeto reaberto) voltam
  // para o canvas
  void (async () => {
    try {
      const result = (await window.p7m.query("levels")) as {
        levels?: Array<{ levelId: string; width: number; height: number; intGrid: number[] }>;
      };
      const existing = result.levels?.find((level) => level.levelId === LEVEL_ID);
      if (existing) {
        doc = new IntGridDocument(existing.width, existing.height, existing.intGrid);
        levelInBlueprint = true;
        viewport.fit(doc.width, doc.height, tileSize);
        onEdited();
        status.textContent = "Nível carregado do projeto.";
      }

      const placed = (await window.p7m.query("entities")) as {
        entities?: Array<{ entityId: string; entityDefId: string; position: [number, number] }>;
      };
      for (const entity of placed.entities ?? []) {
        entities.set(entity.entityId, { entityId: entity.entityId, position: [...entity.position] });
      }
      const defs = (await window.p7m.query("entityDefs")) as {
        entityDefs?: Array<{ entityDefId: string }>;
      };
      entityDefEnsured = (defs.entityDefs ?? []).some((d) => d.entityDefId === ENTITY_DEF.entityDefId);
      if (entities.size > 0) repaint();
    } catch {
      // gateway indisponível: o editor continua editável com um grid vazio
    }
  })();
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
