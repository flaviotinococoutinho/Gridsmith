/**
 * Vista do editor de níveis (P0.4) — DOM/eventos apenas; as decisões de
 * ferramenta vivem em core/levelEditorTools.ts (puras e testadas) e o
 * documento em core/intGridDocument.ts. Montada pelo workbench
 * (renderer.ts) com contexto explícito — organizada para crescer sem
 * estado de módulo compartilhado.
 */

import { CanvasViewport } from "../core/canvasViewport.js";
import {
  commandFailureMessage,
  isAvailabilityError,
} from "../core/canonicalCommandFeedback.js";
import { IntGridDocument } from "../core/intGridDocument.js";
import {
  applyBrushAt,
  applyBrushStroke,
  commitDrag,
  dragCells,
  hitMarker,
  nextEntityId,
  type CellPoint,
  type LevelTool,
} from "../core/levelEditorTools.js";
import { cellToWorldCenter } from "./vendor/GridCoordinates.js";
import type { DispatchOutcome, LevelPatchCommand } from "../core/editorCommands.js";
import type { LevelEditorStore } from "../core/levelEditorStore.js";
import {
  LEVEL_PALETTE,
  TILE_COLORS,
  defaultLevelRules,
  type LevelRule,
} from "../core/levelPresets.js";
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
  /** Projeção da sessão, preservada ao trocar de painel. */
  readonly store: LevelEditorStore;
  /** Registra a limpeza a executar quando o painel for trocado. */
  readonly setCleanup: (cleanup: () => void) => void;
  /** Gate da experiência (governança por runtime); pode não existir offline. */
  readonly gate: ExperienceGate | undefined;
  /** ID vindo do documento/resultado de Open; nunca criado pelo renderer. */
  readonly preferredLevelId?: string;
}

export function mountLevelEditor(ctx: LevelEditorContext): void {
  const { host, gate, store } = ctx;
  store.select(ctx.preferredLevelId);
  const initial = store.snapshot.level;
  let levelId = initial?.levelId;
  let doc = initial?.intGrid ?? new IntGridDocument(1, 1);
  let tileSize = initial?.tileSize ?? 16;
  let levelSeed = initial?.seed ?? 1;
  let levelRules: readonly LevelRule[] = initial?.rules ?? defaultLevelRules();
  let levelPalette = initial?.palette?.map((entry) => ({
    ...entry,
    shortcut: String(entry.value),
  })) ?? LEVEL_PALETTE;
  let activeValue = 1;
  let tool: LevelTool = "pencil";

  // camada de entidades (P0.4 placement ⇄ P0.6 spawn): marcadores em pixels
  // do mundo, hidratados do Blueprint e mantidos pelos próprios dispatches
  interface EntityMarker {
    entityId: string;
    position: [number, number];
  }
  let entityDefinitionId = store.snapshot.playerEntityDefinitionId;
  const entities = new Map<string, EntityMarker>();
  for (const entity of store.snapshot.entities) {
    entities.set(entity.entityId, { entityId: entity.entityId, position: [...entity.position] });
  }
  let selectedEntityId: string | undefined;
  let draggingEntity: EntityMarker | undefined;
  let draggingEntityBefore: [number, number] | undefined;
  let draggingEntityTransactionId: string | undefined;

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
  const entityToolButton = addButton(
    "Jogador",
    () => selectTool("entity"),
    "Clique posiciona, arraste move, Delete remove",
  );
  toolButtons.set("entity", entityToolButton);
  entityToolButton.disabled = true; // habilitado somente após ler a definição real
  selectTool("pencil");

  // governança: a ferramenta de spawn segue a decisão do perfil/manifesto
  // (fail-safe, com a razão no tooltip — nunca um "indisponível" genérico)
  const spawnAnswer = gate?.feature("entities.spawn");
  if (spawnAnswer && !spawnAnswer.enabled) {
    entityToolButton.disabled = true;
    entityToolButton.title = spawnAnswer.reason;
  }

  toolbar.append(Object.assign(document.createElement("span"), { className: "sep" }));

  const swatches = new Map<number, HTMLButtonElement>();
  const paletteHost = document.createElement("span");
  paletteHost.className = "level-palette";
  toolbar.append(paletteHost);
  const selectValue = (value: number): void => {
    activeValue = value;
    for (const [v, s] of swatches) s.setAttribute("aria-pressed", String(v === value));
  };
  const renderPaletteSwatches = (): void => {
    swatches.clear();
    paletteHost.replaceChildren();
    for (const entry of levelPalette) {
      const swatch = document.createElement("button");
      swatch.className = "palette-swatch";
      swatch.style.background = entry.color;
      swatch.title = `${entry.name} (tecla ${entry.shortcut})`;
      swatch.setAttribute("aria-label", entry.name);
      swatch.addEventListener("click", () => selectValue(entry.value));
      swatches.set(entry.value, swatch);
      paletteHost.append(swatch);
    }
    if (!swatches.has(activeValue)) activeValue = levelPalette[0]?.value ?? 1;
    selectValue(activeValue);
  };
  renderPaletteSwatches();

  toolbar.append(Object.assign(document.createElement("span"), { className: "sep" }));
  const doUndo = (): void => {
    void window.p7m.undo().catch(showCommandError("desfazer"));
  };
  const doRedo = (): void => {
    void window.p7m.redo().catch(showCommandError("refazer"));
  };
  addButton("Desfazer", doUndo, "Ctrl+Z — histórico global do projeto");
  addButton("Refazer", doRedo, "Ctrl+Shift+Z — histórico global do projeto");
  addButton(
    "Editar paleta…",
    () => void editActivePaletteEntry().catch(showCommandError("editar paleta")),
    "Altera nome/cor do significado ativo em uma transação canônica",
  );
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
          levelRules as never,
          levelSeed,
        ).tiles;
        repaint();
      });
    }, delayMs);
  }

  function onEdited(): void {
    repaint();
    schedulePreview();
  }

  let openLevelTransactionId: string | undefined;

  function beginLevelGesture(label: string): string {
    if (openLevelTransactionId) return openLevelTransactionId;
    const transactionId = crypto.randomUUID();
    openLevelTransactionId = transactionId;
    doc.beginGesture(transactionId, label);
    window.p7m.beginEditGesture(transactionId);
    return transactionId;
  }

  async function finishLevelGesture(): Promise<void> {
    const transactionId = openLevelTransactionId;
    if (!transactionId) return;
    openLevelTransactionId = undefined;
    const gesture = doc.finishGesture();
    if (!gesture) {
      window.p7m.endEditGesture(transactionId);
      return;
    }
    if (!levelId) {
      doc.reject(transactionId);
      window.p7m.endEditGesture(transactionId);
      throw new Error("O projeto não contém um nível editável");
    }
    const command: LevelPatchCommand = {
      kind: "level/patch",
      levelId,
      changes: gesture.changes,
      transactionId,
      metadata: { label: gesture.label },
    };
    status.textContent = `${gesture.label}: confirmando…`;
    let confirmationUncertain = false;
    try {
      const outcome = await window.p7m.dispatch(
        command.kind,
        {
          levelId: command.levelId,
          changes: command.changes,
          transactionId: command.transactionId,
          metadata: command.metadata,
        },
      ) as DispatchOutcome;
      // A resposta sela o patch antes de o journal necessariamente entregar o
      // eco. O apply posterior é idempotente pelo transactionId.
      confirmationUncertain = !store.applyAcknowledgement(outcome.event);
      status.textContent = `${gesture.label} aplicada.`;
    } catch (error) {
      confirmationUncertain = isAvailabilityError(error);
      if (!confirmationUncertain) store.rejectLevelPatch(levelId, transactionId);
      status.textContent = commandFailureMessage(gesture.label, error);
    } finally {
      if (!confirmationUncertain) window.p7m.endEditGesture(transactionId);
      onEdited();
    }
  }

  function cancelLevelGesture(): void {
    const transactionId = openLevelTransactionId;
    if (!transactionId) return;
    openLevelTransactionId = undefined;
    doc.cancelGesture();
    window.p7m.endEditGesture(transactionId);
    onEdited();
  }

  addButton(
    "Recalcular arte",
    () => schedulePreview(0),
    "Reexecuta a arte derivada; toda edição já segue o caminho canônico",
  );

  // canvas
  const canvas = document.createElement("canvas");
  canvas.id = "level-canvas";
  const status = document.createElement("div");
  status.id = "level-status";
  status.textContent = "Pincel: pinte com o botão esquerdo · roda = zoom · botão do meio = pan";

  function showCommandError(action: string): (error: unknown) => void {
    return (error) => {
      status.textContent = commandFailureMessage(`Falha ao ${action}`, error);
    };
  }

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
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  let meaningColors = new Map(levelPalette.map((p) => [p.value, p.color]));

  function applyPaletteEntryLocally(entry: { value: number; name: string; color: string }): void {
    levelPalette = levelPalette.map((current) =>
      current.value === entry.value
        ? { ...entry, shortcut: String(entry.value) }
        : current,
    );
    meaningColors = new Map(levelPalette.map((current) => [current.value, current.color]));
    renderPaletteSwatches();
    onEdited();
  }

  async function editActivePaletteEntry(): Promise<void> {
    if (!levelId) throw new Error("O projeto não contém um nível editável");
    const current = levelPalette.find((entry) => entry.value === activeValue);
    if (!current) throw new Error("Selecione um significado existente da paleta");
    const name = window.prompt("Nome do significado", current.name)?.trim();
    if (!name) return;
    const color = window.prompt("Cor CSS do significado", current.color)?.trim();
    if (!color) return;
    if (name === current.name && color === current.color) return;

    const before = { value: current.value, name: current.name, color: current.color };
    const after = { value: current.value, name, color };
    const transactionId = crypto.randomUUID();
    window.p7m.beginEditGesture(transactionId);
    applyPaletteEntryLocally(after);
    status.textContent = `Editar paleta: confirmando…`;
    let confirmationUncertain = false;
    try {
      const outcome = await window.p7m.dispatch("level/palette", {
        levelId,
        changes: [{ value: current.value, before, after }],
        transactionId,
        metadata: { label: `Alterar paleta: ${current.name}` },
      }) as DispatchOutcome;
      confirmationUncertain = !store.applyAcknowledgement(outcome.event);
      status.textContent = `Paleta alterada para “${name}”.`;
    } catch (error) {
      confirmationUncertain = isAvailabilityError(error);
      if (!confirmationUncertain) applyPaletteEntryLocally(before);
      status.textContent = commandFailureMessage("Editar paleta", error);
    } finally {
      if (!confirmationUncertain) window.p7m.endEditGesture(transactionId);
    }
  }

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
    return [...cellToWorldCenter({ x: cell.x, y: cell.y }, tileSize)];
  }

  async function ensureEntityDef(): Promise<void> {
    if (!entityDefinitionId) {
      throw new Error("O documento não contém uma definição de entidade Player");
    }
  }

  async function placeEntityAt(position: [number, number]): Promise<void> {
    await ensureEntityDef();
    const definitionId = entityDefinitionId!;
    const entityId = nextEntityId(entities, definitionId);
    const transactionId = crypto.randomUUID();
    const marker = { entityId, position };
    window.p7m.beginEditGesture(transactionId);
    entities.set(entityId, marker);
    selectedEntityId = entityId;
    repaint();
    let confirmationUncertain = false;
    try {
      const outcome = await window.p7m.dispatch("entity/place", {
        entityId,
        entityDefId: definitionId,
        position,
        fields: {},
        transactionId,
        metadata: { label: "Posicionar Jogador" },
      }) as DispatchOutcome;
      confirmationUncertain = !store.applyAcknowledgement(outcome.event);
    } catch (error) {
      confirmationUncertain = isAvailabilityError(error);
      if (!confirmationUncertain) {
        entities.delete(entityId);
        selectedEntityId = undefined;
        repaint();
      }
      throw error;
    } finally {
      if (!confirmationUncertain) window.p7m.endEditGesture(transactionId);
    }
    status.textContent = `Jogador posicionado em (${position[0]}, ${position[1]}).`;
  }

  async function moveEntity(
    marker: EntityMarker,
    before: [number, number],
    position: [number, number],
    transactionId: string,
  ): Promise<void> {
    let confirmationUncertain = false;
    try {
      if (before[0] === position[0] && before[1] === position[1]) return;
      const outcome = await window.p7m.dispatch("entity/move", {
        entityId: marker.entityId,
        position,
        transactionId,
        metadata: { label: "Mover Jogador" },
      }) as DispatchOutcome;
      confirmationUncertain = !store.applyAcknowledgement(outcome.event);
      status.textContent = `Jogador movido para (${position[0]}, ${position[1]}).`;
    } catch (error) {
      confirmationUncertain = isAvailabilityError(error);
      if (!confirmationUncertain) {
        marker.position = before;
        repaint();
      }
      throw error;
    } finally {
      if (!confirmationUncertain) window.p7m.endEditGesture(transactionId);
    }
  }

  async function removeSelectedEntity(): Promise<void> {
    if (!selectedEntityId) return;
    const entityId = selectedEntityId;
    const marker = entities.get(entityId);
    if (!marker) return;
    const transactionId = crypto.randomUUID();
    window.p7m.beginEditGesture(transactionId);
    entities.delete(entityId);
    selectedEntityId = undefined;
    repaint();
    let confirmationUncertain = false;
    try {
      const outcome = await window.p7m.dispatch("entity/remove", {
        entityId,
        transactionId,
        metadata: { label: "Remover Jogador" },
      }) as DispatchOutcome;
      confirmationUncertain = !store.applyAcknowledgement(outcome.event);
      status.textContent = "Jogador removido.";
    } catch (error) {
      confirmationUncertain = isAvailabilityError(error);
      if (!confirmationUncertain) {
        entities.set(entityId, marker);
        selectedEntityId = entityId;
        repaint();
      }
      throw error;
    } finally {
      if (!confirmationUncertain) window.p7m.endEditGesture(transactionId);
    }
  }

  const applyAt = (offsetX: number, offsetY: number): CellPoint | undefined => {
    const cell = viewport.screenToCell(offsetX, offsetY, tileSize, doc.width, doc.height);
    if (!cell.inside) return undefined;
    if (applyBrushAt(doc, tool, cell.x, cell.y, activeValue)) onEdited();
    return { x: cell.x, y: cell.y };
  };

  // Atalhos locais: undo/redo é global e fica no workbench, não nesta vista.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    const paletteEntry = levelPalette.find((p) => p.shortcut === e.key);
    if (paletteEntry) { selectValue(paletteEntry.value); return; }
    if (e.key === "Delete" && selectedEntityId) {
      e.preventDefault();
      void removeSelectedEntity().catch(showCommandError("remover Jogador"));
    }
  };
  window.addEventListener("keydown", onKeyDown);

  let painting = false;
  let lastPaintCell: CellPoint | undefined;
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
          ? `Significado "${levelPalette.find((p) => p.value === value)?.name ?? value}" selecionado.`
          : "Célula vazia: borracha selecionada.";
      }
      return;
    }

    if (tool === "entity") {
      const hit = entityAtScreen(e.offsetX, e.offsetY);
      if (hit) {
        selectedEntityId = hit.entityId;
        draggingEntity = hit;
        draggingEntityBefore = [...hit.position];
        draggingEntityTransactionId = crypto.randomUUID();
        window.p7m.beginEditGesture(draggingEntityTransactionId);
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
        beginLevelGesture(tool === "rect" ? "Pintar retângulo" : "Pintar linha");
        dragAnchor = { x: cell.x, y: cell.y };
        dragCurrent = { x: cell.x, y: cell.y };
        repaint();
      }
      return;
    }

    if (tool === "flood") {
      beginLevelGesture("Preencher região");
      applyAt(e.offsetX, e.offsetY);
      void finishLevelGesture().catch(showCommandError("preencher região"));
      return;
    }
    if (tool === "pencil" || tool === "eraser") {
      beginLevelGesture(tool === "eraser" ? "Apagar células" : "Pintar células");
      painting = true;
      lastPaintCell = applyAt(e.offsetX, e.offsetY);
    }
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
      if (cell.inside) {
        const current = { x: cell.x, y: cell.y };
        if (
          lastPaintCell &&
          applyBrushStroke(doc, tool, lastPaintCell, current, activeValue)
        ) onEdited();
        lastPaintCell = current;
      }
    }
  });
  const onMouseUp = (): void => {
    if (draggingEntity) {
      const marker = draggingEntity;
      const before = draggingEntityBefore ?? [...marker.position];
      const transactionId = draggingEntityTransactionId;
      draggingEntity = undefined;
      draggingEntityBefore = undefined;
      draggingEntityTransactionId = undefined;
      if (transactionId) {
        void moveEntity(marker, before, [...marker.position], transactionId)
          .catch(showCommandError("mover Jogador"));
      }
    }
    if (dragAnchor && dragCurrent) {
      commitDrag(doc, tool, dragAnchor, dragCurrent, activeValue);
      dragAnchor = undefined;
      dragCurrent = undefined;
      onEdited();
      void finishLevelGesture().catch(showCommandError("editar nível"));
    } else if (painting) {
      void finishLevelGesture().catch(showCommandError("editar nível"));
    }
    painting = false;
    lastPaintCell = undefined;
    panning = false;
  };
  window.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    viewport.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    repaint();
  }, { passive: false });

  resize();
  viewport.fit(doc.width, doc.height, tileSize);
  repaint();

  const syncFromStore = (): void => {
    const projection = store.snapshot;
    const level = projection.level;
    if (level) {
      levelId = level.levelId;
      tileSize = level.tileSize;
      levelSeed = level.seed;
      levelRules = level.rules;
      levelPalette = level.palette?.map((entry) => ({ ...entry, shortcut: String(entry.value) })) ?? LEVEL_PALETTE;
      meaningColors = new Map(levelPalette.map((entry) => [entry.value, entry.color]));
      renderPaletteSwatches();
      if (level.intGrid !== doc) {
        doc = level.intGrid;
        viewport.fit(doc.width, doc.height, tileSize);
      }
    }
    if (!draggingEntity) {
      entities.clear();
      for (const entity of projection.entities) {
        entities.set(entity.entityId, {
          entityId: entity.entityId,
          position: [entity.position[0], entity.position[1]],
        });
      }
    }
    entityDefinitionId = projection.playerEntityDefinitionId;
    entityToolButton.disabled = !entityDefinitionId || Boolean(spawnAnswer && !spawnAnswer.enabled);
    if (!entityDefinitionId && !(spawnAnswer && !spawnAnswer.enabled)) {
      entityToolButton.title = "O documento não possui uma definição Player";
    }
    onEdited();
  };
  const unsubscribeStore = store.onChange(syncFromStore);
  syncFromStore();

  ctx.setCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("mouseup", onMouseUp);
    unsubscribeStore();
    resizeObserver.disconnect();
    cancelLevelGesture();
    if (draggingEntityTransactionId) {
      if (draggingEntity && draggingEntityBefore) draggingEntity.position = draggingEntityBefore;
      window.p7m.endEditGesture(draggingEntityTransactionId);
    }
  });
}
