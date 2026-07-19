/**
 * Vista DOM do editor de níveis. O canvas encaminha entradas para a instância
 * ativa do ToolRegistry; decisões geométricas continuam nos módulos puros de
 * core e nenhuma ferramenta é escolhida por ID hardcoded na casca.
 */

import { CanvasViewport } from "../core/canvasViewport.js";
import {
  commandFailureMessage,
  isAvailabilityError,
} from "../core/canonicalCommandFeedback.js";
import type { ContributionContext } from "../core/contributionContext.js";
import type { DispatchOutcome, LevelPatchCommand } from "../core/editorCommands.js";
import { IntGridDocument } from "../core/intGridDocument.js";
import type { LevelEditorStore } from "../core/levelEditorStore.js";
import {
  applyBrushAt,
  applyBrushStroke,
  commitDrag,
  dragCells,
  hitMarker,
  LEVEL_EDITOR_TOOL_CONTROLLER_SERVICE,
  nextEntityId,
  type CellPoint,
  type LevelEditorToolController,
  type LevelEditorToolInput,
  type LevelEditorToolInstance,
  type LevelEditorToolKind,
  type LevelTool,
} from "../core/levelEditorTools.js";
import {
  LEVEL_PALETTE,
  TILE_COLORS,
  defaultLevelRules,
  type LevelRule,
} from "../core/levelPresets.js";
import type { SelectionService } from "../core/selectionService.js";
import type { ResolvedTool, ToolContext, ToolKind, ToolRegistry } from "../core/toolRegistry.js";
import { cellToWorldCenter } from "./vendor/GridCoordinates.js";
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
  /** Registry transversal; registrations são feitas pela composição. */
  readonly toolRegistry: ToolRegistry;
  /** Seleção compartilhada por canvas, árvore e inspector. */
  readonly selection: SelectionService;
  /** Contexto de capability/mode/serviços fornecido pelo workbench. */
  readonly contributionContext: Omit<ContributionContext, "selection">;
  /** Escopo explícito que impede seleções atrasadas de contaminarem outra sessão. */
  readonly projectSessionId: string;
  readonly projectId: string;
  /** ID vindo do documento/resultado de Open; nunca criado pelo renderer. */
  readonly preferredLevelId?: string;
  /** Publica o resultado estruturado no diagnóstico da shell. */
  readonly onDispatchOutcome?: (outcome: DispatchOutcome) => void;
}

export interface LevelEditorViewHandle {
  /** Reavalia capabilities sem reconstruir o canvas ou perder o viewport. */
  activate(): void;
}

interface EntityMarker {
  readonly entityId: string;
  position: [number, number];
}

type DragLevelTool = Extract<LevelTool, "line" | "rect">;

export function mountLevelEditor(ctx: LevelEditorContext): LevelEditorViewHandle {
  const { host, projectId, projectSessionId, selection, store, toolRegistry } = ctx;
  selection.switchSession(projectSessionId, "level-editor-mount");
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

  // Marcadores são hidratados da projeção canônica e só recebem feedback
  // otimista enquanto o dispatch correspondente aguarda confirmação.
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

  const toolbar = document.createElement("div");
  toolbar.id = "level-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Ferramentas do nível");

  const toolStrip = document.createElement("span");
  toolStrip.className = "level-tool-contributions";
  toolStrip.setAttribute("role", "group");
  toolStrip.setAttribute("aria-label", "Ferramentas de edição");
  toolbar.append(toolStrip);

  const addSeparator = (): void => {
    const separator = document.createElement("span");
    separator.className = "sep";
    separator.setAttribute("role", "separator");
    toolbar.append(separator);
  };
  const addButton = (label: string, onClick: () => void, title?: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (title) button.title = title;
    button.addEventListener("click", onClick);
    toolbar.append(button);
    return button;
  };

  addSeparator();
  const paletteHost = document.createElement("span");
  paletteHost.className = "level-palette";
  paletteHost.setAttribute("role", "group");
  paletteHost.setAttribute("aria-label", "Significados da paleta");
  toolbar.append(paletteHost);

  addSeparator();
  addButton(
    "Editar paleta…",
    () => void editActivePaletteEntry().catch(showCommandError("editar paleta")),
    "Altera nome/cor do significado ativo em uma transação canônica",
  );

  const canvas = document.createElement("canvas");
  canvas.id = "level-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute(
    "aria-label",
    "Canvas do nível. Use as setas para navegar, Enter ou Espaço para aplicar a ferramenta e a barra para escolher uma ação.",
  );
  canvas.setAttribute("aria-describedby", "level-status");

  const status = document.createElement("div");
  status.id = "level-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Selecione uma ferramenta · roda = zoom · botão do meio = pan";

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

  let meaningColors = new Map(levelPalette.map((entry) => [entry.value, entry.color]));
  const swatches = new Map<number, HTMLButtonElement>();

  const selectValue = (value: number): void => {
    activeValue = value;
    for (const [candidate, swatch] of swatches) {
      swatch.setAttribute("aria-pressed", String(candidate === value));
    }
  };

  const renderPaletteSwatches = (): void => {
    swatches.clear();
    paletteHost.replaceChildren();
    for (const entry of levelPalette) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "palette-swatch";
      swatch.style.background = entry.color;
      swatch.title = `${entry.value} — ${entry.name} (tecla ${entry.shortcut})`;
      swatch.setAttribute("aria-label", `${entry.value}: ${entry.name}`);
      swatch.setAttribute("aria-keyshortcuts", entry.shortcut);

      // O número continua visível sobre qualquer cor: a paleta nunca comunica
      // significado apenas pelo matiz do swatch.
      const valueBadge = document.createElement("span");
      valueBadge.className = "palette-value-label";
      valueBadge.textContent = String(entry.value);
      swatch.append(valueBadge);
      swatch.addEventListener("click", () => selectValue(entry.value));
      swatches.set(entry.value, swatch);
      paletteHost.append(swatch);
    }
    if (!swatches.has(activeValue)) activeValue = levelPalette[0]?.value ?? 1;
    selectValue(activeValue);
  };
  renderPaletteSwatches();

  // "Pinte significado, derive arte": o preview usa o mesmo resolvedor da projeção.
  let artPreview = false;
  let previewTiles: Int32Array | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  function schedulePreview(delayMs = 80): void {
    if (!artPreview) {
      repaint();
      return;
    }
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

  addButton("Enquadrar", () => {
    viewport.fit(doc.width, doc.height, tileSize);
    repaint();
  });
  const previewButton = addButton("Ver arte", () => {
    artPreview = !artPreview;
    previewButton.setAttribute("aria-pressed", String(artPreview));
    schedulePreview(0);
  }, "Alterna entre significado (IntGrid) e arte derivada pelas regras");
  addButton(
    "Recalcular arte",
    () => schedulePreview(0),
    "Reexecuta a arte derivada; toda edição já segue o caminho canônico",
  );

  function showCommandError(action: string): (error: unknown) => void {
    return (error) => {
      status.textContent = commandFailureMessage(`Falha ao ${action}`, error);
    };
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
      const outcome = await window.p7m.dispatch(command.kind, {
        levelId: command.levelId,
        changes: command.changes,
        transactionId: command.transactionId,
        metadata: command.metadata,
      }) as DispatchOutcome;
      ctx.onDispatchOutcome?.(outcome);
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
    status.textContent = "Editar paleta: confirmando…";
    let confirmationUncertain = false;
    try {
      const outcome = await window.p7m.dispatch("level/palette", {
        levelId,
        changes: [{ value: current.value, before, after }],
        transactionId,
        metadata: { label: `Alterar paleta: ${current.name}` },
      }) as DispatchOutcome;
      ctx.onDispatchOutcome?.(outcome);
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

  // Ghost compartilhado apenas como estado visual; cada strategy controla seu
  // próprio ciclo de início/commit/cancelamento.
  let dragAnchor: CellPoint | undefined;
  let dragCurrent: CellPoint | undefined;
  let dragPreviewTool: DragLevelTool | undefined;

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

    if (dragPreviewTool && dragAnchor && dragCurrent) {
      context.globalAlpha = 0.55;
      context.fillStyle = meaningColors.get(activeValue) ?? "#888";
      const size = tileSize * zoom;
      for (const [x, y] of dragCells(dragPreviewTool, dragAnchor, dragCurrent)) {
        const screen = viewport.worldToScreen(x * tileSize, y * tileSize);
        context.fillRect(screen.x, screen.y, size - gap, size - gap);
      }
      context.globalAlpha = 1;
    }

    // Seleção usa contorno + tracejado, não apenas outra cor.
    const currentSelection = selection.current;
    if (currentSelection?.kind === "cell" && currentSelection.levelId === levelId) {
      context.save();
      context.lineWidth = 2;
      context.strokeStyle = "#fff";
      context.setLineDash([5, 3]);
      for (const cell of currentSelection.cells) {
        const screen = viewport.worldToScreen(cell.x * tileSize, cell.y * tileSize);
        const size = tileSize * zoom;
        context.strokeRect(screen.x + 1, screen.y + 1, Math.max(1, size - 2), Math.max(1, size - 2));
      }
      context.restore();
    }

    for (const marker of entities.values()) {
      const screen = viewport.worldToScreen(marker.position[0], marker.position[1]);
      const radius = Math.max(5, tileSize * 0.45 * zoom);
      context.beginPath();
      context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      context.fillStyle = "#3aa0f0";
      context.fill();
      if (marker.entityId === selectedEntityId) {
        context.lineWidth = 2;
        context.strokeStyle = "#fff";
        context.stroke();
      }
      context.fillStyle = "#fff";
      context.font = `${Math.max(8, radius)}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("J", screen.x, screen.y);
    }
  }

  function cellAtScreen(screenX: number, screenY: number): CellPoint | undefined {
    const cell = viewport.screenToCell(screenX, screenY, tileSize, doc.width, doc.height);
    return cell.inside ? { x: cell.x, y: cell.y } : undefined;
  }

  function publishCellSelection(cell: CellPoint): void {
    if (!levelId) return;
    const coordinate = { x: cell.x, y: cell.y, index: cell.y * doc.width + cell.x };
    selection.select({
      kind: "cell",
      projectSessionId,
      projectId,
      levelId,
      cells: [coordinate],
      anchor: coordinate,
    }, "level-canvas");
  }

  function publishEntitySelection(entityId: string): void {
    selection.select({
      kind: "entity-instance",
      projectSessionId,
      projectId,
      entityId,
      ...(levelId ? { levelId } : {}),
    }, "level-canvas");
  }

  function publishLevelSelection(): void {
    if (!levelId) return;
    selection.select({
      kind: "level",
      projectSessionId,
      projectId,
      levelId,
    }, "level-canvas");
  }

  function entityAtScreen(screenX: number, screenY: number): EntityMarker | undefined {
    const zoom = viewport.current.zoom;
    const hitRadius = Math.max(6, tileSize * 0.5 * zoom);
    return hitMarker(
      entities.values(),
      screenX,
      screenY,
      (worldX, worldY) => viewport.worldToScreen(worldX, worldY),
      hitRadius,
    );
  }

  /** Posição em pixels do mundo, centralizada na célula pela conversão única. */
  function snapToCellCenter(screenX: number, screenY: number): [number, number] | undefined {
    const cell = cellAtScreen(screenX, screenY);
    return cell ? [...cellToWorldCenter(cell, tileSize)] : undefined;
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
    publishEntitySelection(entityId);
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
      ctx.onDispatchOutcome?.(outcome);
      confirmationUncertain = !store.applyAcknowledgement(outcome.event);
    } catch (error) {
      confirmationUncertain = isAvailabilityError(error);
      if (!confirmationUncertain) {
        entities.delete(entityId);
        selectedEntityId = undefined;
        publishLevelSelection();
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
      ctx.onDispatchOutcome?.(outcome);
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
    publishLevelSelection();
    repaint();
    let confirmationUncertain = false;
    try {
      const outcome = await window.p7m.dispatch("entity/remove", {
        entityId,
        transactionId,
        metadata: { label: "Remover Jogador" },
      }) as DispatchOutcome;
      ctx.onDispatchOutcome?.(outcome);
      confirmationUncertain = !store.applyAcknowledgement(outcome.event);
      status.textContent = "Jogador removido.";
    } catch (error) {
      confirmationUncertain = isAvailabilityError(error);
      if (!confirmationUncertain) {
        entities.set(entityId, marker);
        selectedEntityId = entityId;
        publishEntitySelection(entityId);
        repaint();
      }
      throw error;
    } finally {
      if (!confirmationUncertain) window.p7m.endEditGesture(transactionId);
    }
  }

  function applyAt(
    brush: Extract<LevelTool, "pencil" | "eraser" | "flood">,
    screenX: number,
    screenY: number,
  ): CellPoint | undefined {
    const cell = cellAtScreen(screenX, screenY);
    if (!cell) return undefined;
    publishCellSelection(cell);
    if (applyBrushAt(doc, brush, cell.x, cell.y, activeValue)) onEdited();
    return cell;
  }

  const ownedToolInstances = new Set<LevelEditorToolInstance>();

  function createToolInstance(
    handle: (input: LevelEditorToolInput) => void,
    cancel: (reason: string) => void = () => undefined,
  ): LevelEditorToolInstance {
    let disposed = false;
    let instance: LevelEditorToolInstance;
    instance = {
      handleInput(input): void {
        if (!disposed) handle(input);
      },
      cancel(reason): void {
        if (!disposed) cancel(reason);
      },
      dispose(): void {
        disposed = true;
        ownedToolInstances.delete(instance);
      },
    };
    ownedToolInstances.add(instance);
    return instance;
  }

  function createSelectionTool(): LevelEditorToolInstance {
    return createToolInstance((input) => {
      if (input.type !== "pointer-down" || input.button !== 0) return;
      const hit = entityAtScreen(input.screenX, input.screenY);
      if (hit) {
        selectedEntityId = hit.entityId;
        publishEntitySelection(hit.entityId);
      } else {
        selectedEntityId = undefined;
        const cell = cellAtScreen(input.screenX, input.screenY);
        if (cell) publishCellSelection(cell);
      }
      repaint();
    });
  }

  function createBrushTool(brush: Extract<LevelTool, "pencil" | "eraser">): LevelEditorToolInstance {
    let painting = false;
    let lastPaintCell: CellPoint | undefined;
    const labels: Record<typeof brush, string> = {
      pencil: "Pintar células",
      eraser: "Apagar células",
    };
    const reset = (): void => {
      painting = false;
      lastPaintCell = undefined;
    };
    return createToolInstance((input) => {
      if (input.type === "pointer-down" && input.button === 0) {
        beginLevelGesture(labels[brush]);
        painting = true;
        lastPaintCell = applyAt(brush, input.screenX, input.screenY);
        return;
      }
      if (input.type === "pointer-move" && painting) {
        const current = cellAtScreen(input.screenX, input.screenY);
        if (current) {
          publishCellSelection(current);
          if (lastPaintCell && applyBrushStroke(doc, brush, lastPaintCell, current, activeValue)) {
            onEdited();
          }
          lastPaintCell = current;
        }
        return;
      }
      if (input.type === "pointer-up" && painting) {
        reset();
        void finishLevelGesture().catch(showCommandError("editar nível"));
      }
    }, () => {
      if (painting) cancelLevelGesture();
      reset();
    });
  }

  function createFloodTool(): LevelEditorToolInstance {
    return createToolInstance((input) => {
      if (input.type !== "pointer-down" || input.button !== 0) return;
      beginLevelGesture("Preencher região");
      applyAt("flood", input.screenX, input.screenY);
      void finishLevelGesture().catch(showCommandError("preencher região"));
    }, cancelLevelGesture);
  }

  function createDragTool(kind: Extract<LevelEditorToolKind, "line" | "rectangle">): LevelEditorToolInstance {
    const legacyByKind: Record<typeof kind, DragLevelTool> = { line: "line", rectangle: "rect" };
    const labelByKind: Record<typeof kind, string> = {
      line: "Pintar linha",
      rectangle: "Pintar retângulo",
    };
    const legacy = legacyByKind[kind];
    const reset = (): void => {
      dragAnchor = undefined;
      dragCurrent = undefined;
      dragPreviewTool = undefined;
    };
    return createToolInstance((input) => {
      if (input.type === "pointer-down" && input.button === 0) {
        const cell = cellAtScreen(input.screenX, input.screenY);
        if (!cell) return;
        beginLevelGesture(labelByKind[kind]);
        publishCellSelection(cell);
        dragAnchor = cell;
        dragCurrent = cell;
        dragPreviewTool = legacy;
        repaint();
        return;
      }
      if (input.type === "pointer-move" && dragAnchor) {
        const cell = cellAtScreen(input.screenX, input.screenY);
        if (cell) {
          dragCurrent = cell;
          publishCellSelection(cell);
          repaint();
        }
        return;
      }
      if (input.type === "pointer-up" && dragAnchor && dragCurrent) {
        const anchor = dragAnchor;
        const current = dragCurrent;
        reset();
        commitDrag(doc, legacy, anchor, current, activeValue);
        onEdited();
        void finishLevelGesture().catch(showCommandError("editar nível"));
      }
    }, () => {
      if (dragAnchor) cancelLevelGesture();
      reset();
      repaint();
    });
  }

  function activateFirstToolOfKind(kind: LevelEditorToolKind): boolean {
    const resolved = toolRegistry.list(toolContext, { includeDisabled: true })
      .find((candidate) => candidate.contribution.kind === kind && candidate.enabled);
    if (!resolved) return false;
    toolRegistry.activate(resolved.contribution.id, toolContext);
    return true;
  }

  function createPickerTool(): LevelEditorToolInstance {
    return createToolInstance((input) => {
      if (input.type !== "pointer-down" || input.button !== 0) return;
      const cell = cellAtScreen(input.screenX, input.screenY);
      if (!cell) return;
      publishCellSelection(cell);
      const value = doc.valueAt(cell.x, cell.y);
      if (value > 0) selectValue(value);
      const nextKind: LevelEditorToolKind = value > 0 ? "pencil" : "eraser";
      status.textContent = value > 0
        ? `Significado “${levelPalette.find((entry) => entry.value === value)?.name ?? value}” selecionado.`
        : "Célula vazia: borracha selecionada.";
      activateFirstToolOfKind(nextKind);
    });
  }

  function cancelEntityDrag(): void {
    if (draggingEntity && draggingEntityBefore) draggingEntity.position = draggingEntityBefore;
    if (draggingEntityTransactionId) window.p7m.endEditGesture(draggingEntityTransactionId);
    draggingEntity = undefined;
    draggingEntityBefore = undefined;
    draggingEntityTransactionId = undefined;
    repaint();
  }

  function createEntityTool(): LevelEditorToolInstance {
    return createToolInstance((input) => {
      if (input.type === "delete") {
        void removeSelectedEntity().catch(showCommandError("remover Jogador"));
        return;
      }
      if (input.type === "pointer-down" && input.button === 0) {
        const hit = entityAtScreen(input.screenX, input.screenY);
        if (hit) {
          selectedEntityId = hit.entityId;
          publishEntitySelection(hit.entityId);
          draggingEntity = hit;
          draggingEntityBefore = [...hit.position];
          draggingEntityTransactionId = crypto.randomUUID();
          window.p7m.beginEditGesture(draggingEntityTransactionId);
          repaint();
          return;
        }
        const position = snapToCellCenter(input.screenX, input.screenY);
        if (position) {
          void placeEntityAt(position).catch((error) => {
            status.textContent = `Falha ao posicionar: ${error instanceof Error ? error.message : error}`;
          });
        }
        return;
      }
      if (input.type === "pointer-move" && draggingEntity) {
        const position = snapToCellCenter(input.screenX, input.screenY);
        if (position) {
          draggingEntity.position = position;
          repaint();
        }
        return;
      }
      if (input.type === "pointer-up" && draggingEntity) {
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
    }, cancelEntityDrag);
  }

  const toolFactories = new Map<LevelEditorToolKind, () => LevelEditorToolInstance>([
    ["selection", createSelectionTool],
    ["pencil", () => createBrushTool("pencil")],
    ["eraser", () => createBrushTool("eraser")],
    ["line", () => createDragTool("line")],
    ["rectangle", () => createDragTool("rectangle")],
    ["flood", createFloodTool],
    ["picker", createPickerTool],
    ["entity", createEntityTool],
  ]);

  const toolController: LevelEditorToolController = {
    activate(kind) {
      const factory = toolFactories.get(kind);
      if (!factory) throw new Error(`A ferramenta “${kind}” não opera neste editor.`);
      return factory();
    },
  };
  const services = new Map(ctx.contributionContext.services ?? []);
  services.set(LEVEL_EDITOR_TOOL_CONTROLLER_SERVICE, toolController);
  const toolContext: ToolContext = {
    ...ctx.contributionContext,
    selection,
    services,
  };

  const toolButtons = new Map<string, HTMLButtonElement>();

  function isLevelEditorToolKind(kind: ToolKind): kind is LevelEditorToolKind {
    return toolFactories.has(kind as LevelEditorToolKind);
  }

  function viewAvailability(resolved: ResolvedTool): { enabled: boolean; reason?: string } {
    if (!isLevelEditorToolKind(resolved.contribution.kind)) {
      return { enabled: false, reason: "Esta ferramenta ainda não opera no editor de níveis." };
    }
    if (!levelId) {
      return { enabled: false, reason: "O projeto ativo não possui um nível editável." };
    }
    if (resolved.contribution.kind === "entity" && !entityDefinitionId) {
      return { enabled: false, reason: "O documento não possui uma definição Player." };
    }
    return {
      enabled: resolved.enabled,
      ...(resolved.reason ? { reason: resolved.reason } : {}),
    };
  }

  function updateToolPressedState(): void {
    for (const [id, button] of toolButtons) {
      button.setAttribute("aria-pressed", String(toolRegistry.activeId === id));
    }
    canvas.style.cursor = toolRegistry.activeId
      ? toolRegistry.get(toolRegistry.activeId)?.cursor ?? "default"
      : "default";
  }

  function refreshLocalToolAvailability(): void {
    const activeId = toolRegistry.activeId;
    if (!activeId) return;
    const resolved = toolRegistry.availability(activeId, toolContext);
    if (!resolved || !viewAvailability(resolved).enabled) {
      toolRegistry.deactivate("unavailable");
    }
  }

  function renderToolButtons(): void {
    const focusedId = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.toolId
      : undefined;
    toolButtons.clear();
    toolStrip.replaceChildren();
    for (const resolved of toolRegistry.list(toolContext, { includeDisabled: true })) {
      const { contribution } = resolved;
      const availability = viewAvailability(resolved);
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = contribution.label;
      button.dataset.toolId = contribution.id;
      button.setAttribute("aria-pressed", String(toolRegistry.activeId === contribution.id));
      button.setAttribute("aria-disabled", String(!availability.enabled));
      const explanation = [contribution.description, availability.reason].filter(Boolean).join(" — ");
      if (explanation) button.title = explanation;
      if (!availability.enabled) {
        button.classList.add("tool-disabled");
        button.setAttribute(
          "aria-label",
          `${contribution.label}. Indisponível: ${availability.reason ?? "recurso não habilitado"}`,
        );
      }
      button.addEventListener("click", () => {
        if (!availability.enabled) {
          status.textContent = availability.reason ?? "Ferramenta indisponível.";
          return;
        }
        try {
          toolRegistry.activate(contribution.id, toolContext);
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      toolButtons.set(contribution.id, button);
      toolStrip.append(button);
    }
    updateToolPressedState();
    if (focusedId) toolButtons.get(focusedId)?.focus();
  }

  const onToolbarKeyDown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>("button")];
    const currentIndex = buttons.indexOf(event.target);
    if (currentIndex < 0) return;
    const targetIndexByKey: Readonly<Record<string, number>> = {
      ArrowLeft: (currentIndex - 1 + buttons.length) % buttons.length,
      ArrowRight: (currentIndex + 1) % buttons.length,
      Home: 0,
      End: buttons.length - 1,
    };
    const targetIndex = targetIndexByKey[event.key];
    if (targetIndex === undefined) return;
    event.preventDefault();
    buttons[targetIndex]?.focus();
  };
  toolbar.addEventListener("keydown", onToolbarKeyDown);

  const onToolRegistryChange = (): void => renderToolButtons();
  const unsubscribeToolRegistry = toolRegistry.onDidChange(onToolRegistryChange);
  const unsubscribeToolActivation = toolRegistry.onDidActivate((change) => {
    updateToolPressedState();
    if (change.activeId) {
      const active = toolRegistry.get(change.activeId);
      if (active) status.textContent = `${active.label} ativa.`;
    }
  });

  let toolSelectionKind = selection.kind;
  const unsubscribeSelection = selection.subscribe(({ current }) => {
    if (current?.kind === "entity-instance") {
      selectedEntityId = entities.has(current.entityId) ? current.entityId : undefined;
    } else if (current?.kind !== "entity-definition") {
      selectedEntityId = undefined;
    }
    if (current?.kind !== toolSelectionKind) {
      toolSelectionKind = current?.kind;
      toolRegistry.refresh(toolContext);
      renderToolButtons();
    }
    repaint();
  });

  if (!selection.current) {
    if (levelId) publishLevelSelection();
    else selection.select({ kind: "project", projectSessionId, projectId }, "level-editor-mount");
  }
  const activateAvailableTool = (): void => {
    refreshLocalToolAvailability();
    renderToolButtons();
    if (!toolRegistry.activeId) {
      const initialTool = toolRegistry.list(toolContext, { includeDisabled: true })
        .find((candidate) => viewAvailability(candidate).enabled);
      if (initialTool) toolRegistry.activate(initialTool.contribution.id, toolContext);
    }
  };
  renderToolButtons();
  if (toolRegistry.activeInstance && !ownedToolInstances.has(
    toolRegistry.activeInstance as LevelEditorToolInstance,
  )) {
    toolRegistry.deactivate();
  }
  activateAvailableTool();

  let panning = false;
  let lastPanPoint = { x: 0, y: 0 };
  const sendToolInput = (input: LevelEditorToolInput): void => {
    (toolRegistry.activeInstance as LevelEditorToolInstance | undefined)?.handleInput(input);
  };

  canvas.addEventListener("mousedown", (event) => {
    canvas.focus();
    if (event.button === 1) {
      panning = true;
      lastPanPoint = { x: event.offsetX, y: event.offsetY };
      event.preventDefault();
      return;
    }
    sendToolInput({
      type: "pointer-down",
      screenX: event.offsetX,
      screenY: event.offsetY,
      button: event.button,
    });
  });

  canvas.addEventListener("mousemove", (event) => {
    const cell = cellAtScreen(event.offsetX, event.offsetY);
    status.textContent = cell ? `Célula (${cell.x}, ${cell.y})` : "Fora do nível";
    if (panning) {
      viewport.panByScreen(event.offsetX - lastPanPoint.x, event.offsetY - lastPanPoint.y);
      lastPanPoint = { x: event.offsetX, y: event.offsetY };
      repaint();
      return;
    }
    sendToolInput({ type: "pointer-move", screenX: event.offsetX, screenY: event.offsetY });
  });

  const onMouseUp = (): void => {
    panning = false;
    sendToolInput({ type: "pointer-up" });
  };
  window.addEventListener("mouseup", onMouseUp);

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    viewport.zoomAt(event.offsetX, event.offsetY, event.deltaY < 0 ? 1.15 : 1 / 1.15);
    repaint();
  }, { passive: false });

  const canvasNavigation: Readonly<Record<string, readonly [number, number]>> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  canvas.addEventListener("keydown", (event) => {
    const delta = canvasNavigation[event.key];
    const current = selection.current?.kind === "cell" && selection.current.levelId === levelId
      ? selection.current.anchor ?? selection.current.cells[0]
      : undefined;
    if (delta) {
      event.preventDefault();
      const next = {
        x: Math.max(0, Math.min(doc.width - 1, (current?.x ?? 0) + delta[0])),
        y: Math.max(0, Math.min(doc.height - 1, (current?.y ?? 0) + delta[1])),
      };
      publishCellSelection(next);
      status.textContent = `Célula (${next.x}, ${next.y}) selecionada pelo teclado.`;
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    const target = current ?? { x: 0, y: 0 };
    publishCellSelection(target);
    const screen = viewport.worldToScreen(
      (target.x + 0.5) * tileSize,
      (target.y + 0.5) * tileSize,
    );
    sendToolInput({ type: "pointer-down", screenX: screen.x, screenY: screen.y, button: 0 });
    sendToolInput({ type: "pointer-up" });
  });

  // Atalhos locais; undo/redo continuam globais no CommandRegistry/workbench.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable)
    ) return;
    const paletteEntry = levelPalette.find((entry) => entry.shortcut === event.key);
    if (paletteEntry) {
      selectValue(paletteEntry.value);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      sendToolInput({ type: "delete" });
    }
  };
  window.addEventListener("keydown", onKeyDown);

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
    } else {
      cancelLevelGesture();
      levelId = undefined;
      doc = new IntGridDocument(1, 1);
      tileSize = 16;
      levelSeed = 1;
      levelRules = defaultLevelRules();
      levelPalette = LEVEL_PALETTE;
      meaningColors = new Map(levelPalette.map((entry) => [entry.value, entry.color]));
      previewTiles = undefined;
      dragAnchor = undefined;
      dragCurrent = undefined;
      dragPreviewTool = undefined;
      selectedEntityId = undefined;
      renderPaletteSwatches();
      viewport.fit(1, 1, tileSize);
      status.textContent = "O projeto ativo não possui um nível editável.";
    }
    if (!draggingEntity) {
      entities.clear();
      for (const entity of level ? projection.entities : []) {
        entities.set(entity.entityId, {
          entityId: entity.entityId,
          position: [entity.position[0], entity.position[1]],
        });
      }
    }
    entityDefinitionId = projection.playerEntityDefinitionId;
    refreshLocalToolAvailability();
    renderToolButtons();
    onEdited();
  };
  const unsubscribeStore = store.onChange(syncFromStore);
  syncFromStore();

  resize();
  viewport.fit(doc.width, doc.height, tileSize);
  repaint();

  ctx.setCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("mouseup", onMouseUp);
    toolbar.removeEventListener("keydown", onToolbarKeyDown);
    unsubscribeStore();
    unsubscribeSelection();
    unsubscribeToolRegistry();
    unsubscribeToolActivation();
    resizeObserver.disconnect();
    clearTimeout(previewTimer);
    const activeInstance = toolRegistry.activeInstance;
    if (activeInstance && ownedToolInstances.has(activeInstance as LevelEditorToolInstance)) {
      toolRegistry.deactivate();
    }
    cancelLevelGesture();
    cancelEntityDrag();
  });
  return { activate: activateAvailableTool };
}
