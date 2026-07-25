/**
 * Vista do editor de níveis (P0.4) — DOM/eventos apenas; as decisões de
 * ferramenta vivem em core/levelEditorTools.ts (puras e testadas) e o
 * documento em core/intGridDocument.ts. Montada pelo workbench
 * (renderer.ts) com contexto explícito — organizada para crescer sem
 * estado de módulo compartilhado.
 */

import { CanvasViewport } from "../core/canvasViewport.js";
import { IntGridDocument } from "../core/intGridDocument.js";
import {
  applyBrushAt,
  cellCenter,
  commitDrag,
  dragCells,
  hitMarker,
  nextEntityId,
  type CellPoint,
  type LevelTool,
} from "../core/levelEditorTools.js";
import { LEVEL_PALETTE, TILE_COLORS, defaultLevelRules } from "../core/levelPresets.js";
import { presentError } from "../core/errorCatalog.js";
import { projectionLabel } from "../core/vocabulary.js";
import type { ExperienceGate } from "../core/experienceGate.js";
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

export interface LevelEditorContext {
  readonly host: HTMLElement;
  /** Ações undo/redo do editor ativo (menu Editar / atalhos globais). */
  readonly activeEditor: { undo?: () => void; redo?: () => void };
  /** Registra a limpeza a executar quando o painel for trocado. */
  readonly setCleanup: (cleanup: () => void) => void;
  /** Gate da experiência (governança por runtime); pode não existir offline. */
  readonly gate: ExperienceGate | undefined;
}

export function mountLevelEditor(ctx: LevelEditorContext): void {
  const { host, activeEditor, gate } = ctx;
  const LEVEL_ID = "nivel-1";
  let doc = new IntGridDocument(48, 27);
  // integração com o save (P0.2 ⇄ P0.4): publicações viram level/define ou
  // level/update no Blueprint — e daí para o documento salvo do projeto
  let levelInBlueprint = false;
  const tileSize = 16;
  let activeValue = 1;
  let tool: LevelTool = "pencil";

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
  const selectTool = (name: LevelTool): void => {
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

  // governança: a ferramenta de spawn segue a decisão do perfil/manifesto
  // (fail-safe, com a razão no tooltip — nunca um "indisponível" genérico)
  const spawnAnswer = gate?.feature("entities.spawn");
  if (spawnAnswer && !spawnAnswer.enabled) {
    const entityButton = toolButtons.get("entity")!;
    entityButton.disabled = true;
    entityButton.title = spawnAnswer.reason;
  }

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
  let dragAnchor: CellPoint | undefined;
  let dragCurrent: CellPoint | undefined;

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
      for (const [x, y] of dragCells(tool, dragAnchor, dragCurrent)) {
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
    return hitMarker(entities.values(), offsetX, offsetY, (wx, wy) => viewport.worldToScreen(wx, wy), hitRadius);
  }

  /** Posição do clique em pixels do mundo, ancorada no centro da célula. */
  function snapToCellCenter(offsetX: number, offsetY: number): [number, number] | undefined {
    const cell = viewport.screenToCell(offsetX, offsetY, tileSize, doc.width, doc.height);
    if (!cell.inside) return undefined;
    return cellCenter(cell.x, cell.y, tileSize);
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

  /**
   * Qualifica a mensagem de sucesso com o que REALMENTE aconteceu no runtime.
   * O dispatch devolve a projeção; ignorá-la era o que fazia o editor afirmar
   * que aplicou o que a engine recusou.
   */
  function withProjection(base: string, outcome: unknown): string {
    const projection = (outcome as { projection?: { status?: string; reason?: string } } | undefined)
      ?.projection;
    if (!projection || projection.status === "projected") return base;
    const label = projectionLabel(projection.status ?? "");
    return projection.reason ? `${base} ${label}: ${projection.reason}.` : `${base} ${label}.`;
  }

  async function placeEntityAt(position: [number, number]): Promise<void> {
    await ensureEntityDef();
    const entityId = nextEntityId(entities, ENTITY_DEF.entityDefId);
    const outcome = await window.p7m.dispatch("entity/place", {
      entityId,
      entityDefId: ENTITY_DEF.entityDefId,
      position,
      fields: {},
    });
    entities.set(entityId, { entityId, position });
    selectedEntityId = entityId;
    status.textContent = withProjection(
      `Jogador posicionado em (${position[0]}, ${position[1]}).`,
      outcome,
    );
    repaint();
  }

  async function moveEntity(marker: EntityMarker, position: [number, number]): Promise<void> {
    const outcome = await window.p7m.dispatch("entity/move", {
      entityId: marker.entityId,
      position,
    });
    status.textContent = withProjection(
      `Jogador movido para (${position[0]}, ${position[1]}).`,
      outcome,
    );
  }

  async function removeSelectedEntity(): Promise<void> {
    if (!selectedEntityId) return;
    const entityId = selectedEntityId;
    const outcome = await window.p7m.dispatch("entity/remove", { entityId });
    entities.delete(entityId);
    selectedEntityId = undefined;
    status.textContent = withProjection("Jogador removido.", outcome);
    repaint();
  }

  const applyAt = (offsetX: number, offsetY: number): void => {
    const cell = viewport.screenToCell(offsetX, offsetY, tileSize, doc.width, doc.height);
    if (!cell.inside) return;
    if (applyBrushAt(doc, tool, cell.x, cell.y, activeValue)) onEdited();
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
  ctx.setCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    delete activeEditor.undo;
    delete activeEditor.redo;
  });

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
      commitDrag(doc, tool, dragAnchor, dragCurrent, activeValue);
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
      const outcome = await window.p7m.dispatch(
        levelInBlueprint ? "level/update" : "level/define",
        payload,
      );
      levelInBlueprint = true;
      status.textContent = withProjection(
        "Nível publicado — salve o projeto para persistir (Ctrl+S).",
        outcome,
      );
    } catch (err) {
      const presented = presentError(err);
      status.textContent = `${presented.title}: ${presented.cause} ${presented.action}`;
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
