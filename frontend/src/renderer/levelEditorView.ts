/**
 * Vista do editor de níveis — DOM/eventos apenas; as decisões de ferramenta
 * vivem em core/levelEditorTools.ts (puras e testadas) e o documento em
 * core/intGridDocument.ts.
 *
 * Desde a E10 a vista não é mais dona da própria barra de ferramentas nem dos
 * próprios atalhos: ela CONTRIBUI ferramentas e comandos ao workbench e lê a
 * ferramenta ativa do registro. Foi assim que o Ctrl+Z passou a ter um dono
 * único e verificável, e que a seleção saiu do closure — sem ela fora daqui,
 * nenhum inspector conseguiria existir.
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
  pickEntityDef,
  pickLevel,
  type CellPoint,
  type LevelTool,
} from "../core/levelEditorTools.js";
import { LEVEL_PALETTE, TILE_COLORS, defaultLevelRules } from "../core/levelPresets.js";
import { fallbackTileColor, tileRegion, type TilesetTable } from "../core/tilesetAtlas.js";
import {
  requiredTilesetIds,
  resolveEntityArt,
  type EntitySpriteRef,
} from "../core/entitySprite.js";
import { presentError } from "../core/errorCatalog.js";
import { projectionLabel } from "../core/vocabulary.js";
import {
  keepActiveValue,
  resolveLevelPalette,
  type ResolvedPaletteEntry,
} from "../core/levelPalette.js";
import {
  PaintGesture,
  planGestureCommand,
  rememberOwnSequence,
  shouldRehydrate,
} from "../core/paintGesture.js";
import { LEVEL_EDITOR_PANEL } from "../core/workbench/editorContributions.js";
import type { KeyStroke } from "../core/workbench/keybindings.js";
import type { Selection } from "../core/workbench/selectionService.js";
import type { WorkbenchModel } from "../core/workbench/workbenchShell.js";
// type-only (apagado na compilação): o módulo real é vendorizado pelo build
import type { resolveAutoTiles as ResolveAutoTilesFn } from "@gridsmith/middleware/dist/leveldesign/AutoTiler.js";

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

export interface InspectorField {
  readonly label: string;
  readonly value: string;
}

/** Quem sabe descrever a seleção corrente para o inspector da casca. */
export interface InspectorDataProvider {
  fields(sectionId: string, selection: Selection): readonly InspectorField[];
}

/** Nível como a projeção canônica `levels` o entrega. */
interface HydratedLevel {
  readonly levelId: string;
  readonly width: number;
  readonly height: number;
  readonly intGrid: number[];
  readonly tileSize?: number;
  readonly seed?: number;
  readonly rules?: ReturnType<typeof defaultLevelRules>;
  readonly palette?: ReadonlyArray<{ value: number; name: string; color: string }>;
  readonly tilesetId?: string;
}

export interface LevelEditorContext {
  readonly host: HTMLElement;
  /** Registros do workbench: ferramentas, comandos, seleção e governança. */
  readonly workbench: WorkbenchModel;
  /** Registra a limpeza a executar quando o painel for trocado. */
  readonly setCleanup: (cleanup: () => void) => void;
  /** Publica o descritor da seleção para o inspector. */
  readonly setInspectorData: (provider: InspectorDataProvider) => void;
  /**
   * Teclas que só fazem sentido dentro desta vista (os dígitos da paleta). A
   * casca chama isto DEPOIS de comandos e ferramentas, então a vista nunca
   * rouba um atalho global.
   */
  readonly setKeyHandler: (handler: (stroke: KeyStroke) => boolean) => void;
  /**
   * Eventos do documento, repassados pela casca. A vista NÃO assina o IPC
   * direto: a assinatura do preload não tem cancelamento, e uma por montagem
   * vazaria um ouvinte a cada troca de painel.
   */
  readonly setDocumentListener?: (
    listener: (event: { kind: string; commandSequence: string }) => void,
  ) => void;
  /** Nível a abrir; sem ele a vista abre o primeiro nível do projeto. */
  readonly levelId?: string;
}

export function mountLevelEditor(ctx: LevelEditorContext): void {
  const { host, workbench } = ctx;
  // O editor NÃO é dono destes valores: eles descrevem o nível ABERTO. Só
  // valem como partida de um projeto vazio; a hidratação os substitui pelo
  // que o Blueprint tiver, venha do template canônico, de um agente ou de
  // outro editor. Tratá-los como constantes do editor era o que fazia um
  // projeto de template abrir com o canvas em branco.
  let levelId = ctx.levelId ?? "nivel-1";
  let doc = new IntGridDocument(48, 27);
  // integração com o save (P0.2 ⇄ P0.4): publicações viram level/define ou
  // level/update no Blueprint — e daí para o documento salvo do projeto
  let levelInBlueprint = false;
  let tileSize = 16;
  let seed = 1;
  let rules: ReturnType<typeof defaultLevelRules> = defaultLevelRules();
  let activeValue = 1;

  /** Ferramenta corrente: LIDA do registro, nunca guardada aqui. */
  const currentTool = (): LevelTool => (workbench.activeToolId() ?? "pencil") as LevelTool;

  // camada de entidades (P0.4 placement ⇄ P0.6 spawn): marcadores em pixels
  // do mundo, hidratados do Blueprint e mantidos pelos próprios dispatches
  interface EntityMarker {
    entityId: string;
    entityDefId: string;
    position: [number, number];
  }
  /** Definição projetada: o `sprite` é o que diz QUAL arte o ator desenha. */
  interface EntityDefView {
    entityDefId: string;
    archetypeId?: string;
    sprite?: EntitySpriteRef;
  }
  // idem: default de projeto vazio, substituído pela definição do projeto
  let entityDef: EntityDefView = {
    entityDefId: "jogador",
    archetypeId: "player",
  };
  // TODAS as definições, por id: o marcador precisa da arte da SUA definição,
  // não da que o editor escolheu para colocar
  const entityDefsById = new Map<string, EntityDefView>();
  const entities = new Map<string, EntityMarker>();
  let entityDefEnsured = false;
  let draggingEntity: EntityMarker | undefined;

  /** Seleção: mora no workbench, não no closure — é o que o inspector lê. */
  const selectedEntityId = (): string | undefined => {
    const selection = workbench.selection.current;
    return selection?.kind === "entity" ? selection.ids[0] : undefined;
  };
  const selectEntity = (entityId: string | undefined): void => {
    if (entityId === undefined) workbench.selection.clear();
    else workbench.selection.select("entity", [entityId], LEVEL_EDITOR_PANEL);
  };

  const view = document.createElement("div");
  view.id = "level-view";

  const toolbar = document.createElement("div");
  toolbar.id = "level-toolbar";
  const toolStrip = document.createElement("div");
  toolStrip.className = "tool-strip";
  toolbar.append(toolStrip);

  const addButton = (label: string, onClick: () => void, title?: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    toolbar.append(b);
    return b;
  };

  /**
   * A barra de ferramentas é DERIVADA do registro a cada render: a governança
   * de `entities.spawn` era aplicada uma única vez na montagem, então um
   * perfil que mudasse com o painel aberto deixava o botão clicável.
   */
  function renderToolStrip(): void {
    toolStrip.replaceChildren();
    for (const resolved of workbench.activeTools()) {
      const button = document.createElement("button");
      button.textContent = resolved.tool.label;
      button.disabled = !resolved.enabled;
      button.setAttribute("aria-pressed", String(resolved.active));
      const tooltip = resolved.enabled
        ? [resolved.tool.hint, resolved.shortcut].filter(Boolean).join(" · ")
        : resolved.reason;
      if (tooltip) button.title = tooltip;
      button.addEventListener("click", () => workbench.activateTool(resolved.tool.id));
      toolStrip.append(button);
    }
  }

  toolbar.append(Object.assign(document.createElement("span"), { className: "sep" }));

  /**
   * Paleta CORRENTE: o que o documento diz, com a constante de build como
   * fallback. Ela muda quando o nível é hidratado ou reidratado, então os
   * swatches são redesenhados em vez de criados uma vez na montagem.
   */
  let palette: readonly ResolvedPaletteEntry[] = resolveLevelPalette(undefined, LEVEL_PALETTE);
  const paletteHost = document.createElement("span");
  paletteHost.className = "palette";
  toolbar.append(paletteHost);
  const swatches = new Map<number, HTMLButtonElement>();

  const selectValue = (value: number): void => {
    activeValue = value;
    for (const [v, s] of swatches) s.setAttribute("aria-pressed", String(v === value));
  };

  function renderPalette(): void {
    paletteHost.replaceChildren();
    swatches.clear();
    for (const entry of palette) {
      const swatch = document.createElement("button");
      swatch.className = "palette-swatch";
      swatch.style.background = entry.color;
      swatch.title = entry.shortcut ? `${entry.name} (tecla ${entry.shortcut})` : entry.name;
      swatch.setAttribute("aria-label", entry.name);
      swatch.addEventListener("click", () => selectValue(entry.value));
      swatches.set(entry.value, swatch);
      paletteHost.append(swatch);
    }
    selectValue(keepActiveValue(palette, activeValue));
  }

  /** Adota a paleta do documento (ou o fallback) e redesenha o que depende dela. */
  function applyPalette(documentPalette: HydratedLevel["palette"]): void {
    palette = resolveLevelPalette(documentPalette, LEVEL_PALETTE);
    renderPalette();
  }

  renderPalette();

  toolbar.append(Object.assign(document.createElement("span"), { className: "sep" }));

  // Desfazer/refazer NÃO têm botão aqui: a pintura é canônica (F6) e quem
  // desfaz é o histórico do documento, na barra da casca. Um par local
  // recriaria a segunda verdade que esta frente acabou de eliminar.
  addButton("Enquadrar", () => {
    viewport.fit(doc.width, doc.height, tileSize);
    repaint();
  });

  // "Pinte significado, derive arte": preview usa o MESMO resolvedor da projeção
  let artPreview = false;
  let previewTiles: Int32Array | undefined;
  // Atlas CARREGADOS, por tilesetId. O nível desenha o seu (documento v5), mas
  // cada sprite de entidade (documento v6) pode vir de outro: um cache só do
  // nível faria o marcador degradar por falta de CARGA, e não por falta de
  // arte. `image === null` registra que a carga JÁ falhou — a MESMA semântica
  // do cache negativo do host: sem isso o canvas repediria a imagem por IPC a
  // cada repaint.
  interface AtlasEntry {
    readonly table: TilesetTable;
    image?: HTMLImageElement | null;
  }
  const atlases = new Map<string, AtlasEntry>();
  let levelTilesetId: string | undefined;
  const atlasOf = (tilesetId: string): AtlasEntry | undefined => atlases.get(tilesetId);

  function ensureAtlas(table: TilesetTable): void {
    const known = atlases.get(table.tilesetId);
    if (known && known.table.image === table.image) return; // já pedida
    const entry: AtlasEntry = { table };
    atlases.set(table.tilesetId, entry);
    void window.gridsmith.readAtlasImage(table.image).then((dataUrl) => {
      if (atlases.get(table.tilesetId) !== entry) return; // trocou no meio
      if (!dataUrl) {
        entry.image = null; // recusado/ausente: fallback determinístico CONJUNTO
        repaint();
        return;
      }
      const image = new Image();
      const settle = (loaded: HTMLImageElement | null): void => {
        if (atlases.get(table.tilesetId) !== entry) return;
        entry.image = loaded;
        repaint();
      };
      image.onload = () => settle(image);
      image.onerror = () => settle(null);
      image.src = dataUrl;
    });
  }

  /** Atlas do NÍVEL: sem tabela o preview volta a TILE_COLORS. */
  function loadAtlas(table: TilesetTable | undefined): void {
    levelTilesetId = table?.tilesetId;
    if (table) ensureAtlas(table);
  }
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const previewBtn = addButton(
    "Ver arte",
    () => {
      artPreview = !artPreview;
      previewBtn.setAttribute("aria-pressed", String(artPreview));
      schedulePreview(0);
    },
    "Alterna entre significado (IntGrid) e arte derivada pelas regras",
  );

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
          rules as never,
          seed,
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
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const meaningColor = (value: number): string =>
    palette.find((entry) => entry.value === value)?.color ?? "#888";

  // arrasto de retângulo/linha: âncora + célula corrente para o ghost
  let dragAnchor: CellPoint | undefined;
  let dragCurrent: CellPoint | undefined;

  function repaint(): void {
    context.fillStyle = "#101216";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const range = viewport.visibleCells(tileSize, doc.width, doc.height);
    const zoom = viewport.current.zoom;
    const gap = zoom > 4 ? 1 : 0;
    // resolvido UMA vez por frame, como o host faz com a tabela do mapa
    const levelAtlas = levelTilesetId === undefined ? undefined : atlases.get(levelTilesetId);

    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        const screen = viewport.worldToScreen(x * tileSize, y * tileSize);
        const size = tileSize * zoom;
        let fill = "#1b1e24";
        if (artPreview && previewTiles) {
          const tileId = previewTiles[y * doc.width + x]!;
          if (tileId >= 0) {
            // Com tileset no nível, a arte vem do ATLAS — e quando a tabela
            // não cobre (id fora da faixa, imagem recusada/ausente), a cor é
            // o MESMO hash determinístico do host: os dois lados degradam
            // JUNTOS, nunca um fingindo o que o outro não mostra. TILE_COLORS
            // sobrevive apenas como preview de nível SEM tileset.
            if (levelAtlas) {
              const region = levelAtlas.image ? tileRegion(levelAtlas.table, tileId) : undefined;
              if (levelAtlas.image && region) {
                context.drawImage(
                  levelAtlas.image,
                  region.x,
                  region.y,
                  region.width,
                  region.height,
                  screen.x,
                  screen.y,
                  size - gap,
                  size - gap,
                );
                continue;
              }
              fill = fallbackTileColor(tileId);
            } else {
              fill = TILE_COLORS[tileId] ?? "#888";
            }
          }
        } else {
          const value = doc.valueAt(x, y);
          if (value !== 0) fill = meaningColor(value);
        }
        context.fillStyle = fill;
        context.fillRect(screen.x, screen.y, size - gap, size - gap);
      }
    }

    // ghost do retângulo/linha em andamento (semitransparente na cor ativa)
    if (dragAnchor && dragCurrent) {
      context.globalAlpha = 0.55;
      context.fillStyle = meaningColor(activeValue);
      const size = tileSize * zoom;
      for (const [x, y] of dragCells(currentTool(), dragAnchor, dragCurrent)) {
        const screen = viewport.worldToScreen(x * tileSize, y * tileSize);
        context.fillRect(screen.x, screen.y, size - gap, size - gap);
      }
      context.globalAlpha = 1;
    }

    // Atores: o SPRITE da definição (documento v6) quando há arte, o marcador
    // redondo quando não há. A escolha é a MESMA do host — que amostra o atlas
    // do ator pelo slot do quad e cai na cor lisa em qualquer degradação —, e
    // a cor do marcador é a mesma cor lisa (`ColorOf` do Actor): os dois lados
    // mostram a mesma coisa quando a arte falta. O quadrado tem o lado do
    // diâmetro do marcador, então o hit-test não muda com a arte.
    const selected = selectedEntityId();
    for (const marker of entities.values()) {
      const screen = viewport.worldToScreen(marker.position[0], marker.position[1]);
      const radius = Math.max(5, tileSize * 0.45 * zoom);
      const art = resolveEntityArt(entityDefsById.get(marker.entityDefId)?.sprite, atlasOf);
      if (art.kind === "tile") {
        context.drawImage(
          art.image,
          art.region.x,
          art.region.y,
          art.region.width,
          art.region.height,
          screen.x - radius,
          screen.y - radius,
          radius * 2,
          radius * 2,
        );
        if (marker.entityId === selected) {
          context.lineWidth = 2;
          context.strokeStyle = "#ffffff";
          context.strokeRect(screen.x - radius, screen.y - radius, radius * 2, radius * 2);
        }
        continue;
      }
      context.beginPath();
      context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      context.fillStyle = "#3aa0f0";
      context.fill();
      if (marker.entityId === selected) {
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
    return hitMarker(
      entities.values(),
      offsetX,
      offsetY,
      (wx, wy) => viewport.worldToScreen(wx, wy),
      hitRadius,
    );
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
      await window.gridsmith.dispatch("entitydef/define", { ...entityDef, fields: [] });
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
    const entityId = nextEntityId(entities, entityDef.entityDefId);
    const outcome = await window.gridsmith.dispatch("entity/place", {
      entityId,
      entityDefId: entityDef.entityDefId,
      position,
      fields: {},
    });
    entities.set(entityId, { entityId, entityDefId: entityDef.entityDefId, position });
    selectEntity(entityId);
    status.textContent = withProjection(
      `Jogador posicionado em (${position[0]}, ${position[1]}).`,
      outcome,
    );
    repaint();
  }

  async function moveEntity(marker: EntityMarker, position: [number, number]): Promise<void> {
    const outcome = await window.gridsmith.dispatch("entity/move", {
      entityId: marker.entityId,
      position,
    });
    status.textContent = withProjection(
      `Jogador movido para (${position[0]}, ${position[1]}).`,
      outcome,
    );
  }

  async function removeSelectedEntity(): Promise<void> {
    const entityId = selectedEntityId();
    if (!entityId) return;
    const outcome = await window.gridsmith.dispatch("entity/remove", { entityId });
    entities.delete(entityId);
    selectEntity(undefined);
    status.textContent = withProjection("Jogador removido.", outcome);
    repaint();
  }

  // ------------------------------------------------- gesto → comando (F6)

  /**
   * Pincelada em curso. Ela existe entre o `mousedown` e o `mouseup`: durante
   * o traço o canvas responde localmente (o arrasto toca dezenas de células a
   * 60 Hz e um comando por célula inundaria o histórico), e no fim o lote
   * inteiro vira UM comando canônico com `transactionId` — o agrupamento que
   * a E9 preparou.
   */
  let gesture: PaintGesture | undefined;
  /**
   * Sequências dos comandos que ESTA vista despachou. O evento de volta é eco
   * do que o canvas já mostra; reidratar nele faria o editor piscar a cada
   * traço. O que precisa entrar é o que veio de fora: desfazer canônico,
   * agente, outra borda.
   */
  const ownSequences = new Set<string>();
  /** Chegou mudança externa no meio de um traço: reidrata quando ele acabar. */
  let rehydratePending = false;
  /**
   * Fila dos despachos de gesto. Duas pinceladas rápidas NÃO podem correr em
   * paralelo, e por dois motivos de correção: `level/patch` carrega o `before`
   * de cada célula, então uma chegada fora de ordem seria recusada como
   * "pintou sobre leitura velha"; e num nível ainda não publicado a segunda
   * pincelada emitiria um segundo `level/define`, que o domínio recusa como id
   * duplicado. A reidratação entra na MESMA fila: reler o nível enquanto um
   * patch está em voo devolveria o grid de antes dele.
   */
  let dispatchChain: Promise<void> = Promise.resolve();

  function beginGesture(): void {
    gesture = new PaintGesture();
  }

  /** Fecha a pincelada e enfileira o despacho. Sem mudança, nada é despachado. */
  function endGesture(): void {
    const finished = gesture;
    gesture = undefined;
    // o `catch` protege a FILA: um erro escapando envenenaria a cadeia e todo
    // gesto seguinte seria descartado em silêncio
    dispatchChain = dispatchChain.then(() => flushGesture(finished)).catch(() => undefined);
  }

  async function flushGesture(finished: PaintGesture | undefined): Promise<void> {
    if (finished) {
      const command = planGestureCommand({
        levelId,
        transactionId: crypto.randomUUID(),
        changes: finished.changes(),
        levelInBlueprint,
        definePayload: () => doc.toLevelPayload({ levelId, tileSize, seed, rules }),
      });
      if (command) {
        try {
          const outcome = await window.gridsmith.dispatch(command.kind, command.payload);
          levelInBlueprint = true;
          const sequence = (outcome as { event?: { commandSequence?: string } } | undefined)?.event
            ?.commandSequence;
          if (typeof sequence === "string") rememberOwnSequence(ownSequences, sequence);
          status.textContent = withProjection("Nível atualizado.", outcome);
        } catch (err) {
          // O documento RECUSOU a pincelada (tipicamente: alguém editou a
          // mesma célula entre a leitura e o gesto). Deixar o canvas mostrando
          // o traço recusado seria a mentira mais cara do editor — ele exibiria
          // um nível que o projeto não tem. Reidratar é a resposta honesta.
          const presented = presentError(err);
          status.textContent = `${presented.title}: ${presented.cause} ${presented.action}`;
          rehydratePending = true;
        }
      }
    }
    if (rehydratePending) {
      rehydratePending = false;
      await rehydrateGrid();
    }
  }

  /** Relê o grid do documento e substitui o espelho local. */
  async function rehydrateGrid(): Promise<void> {
    try {
      const result = (await window.gridsmith.query("levels")) as { levels?: HydratedLevel[] };
      const existing = pickLevel(result.levels ?? [], levelId);
      if (!existing) return;
      doc = new IntGridDocument(existing.width, existing.height, existing.intGrid);
      // a paleta pode ter mudado junto (level/palette de outra borda)
      applyPalette(existing.palette);
      onEdited();
    } catch {
      // gateway fora do ar: o canvas segue com o que tem, e o status já contou
    }
  }

  const applyAt = (offsetX: number, offsetY: number): void => {
    const cell = viewport.screenToCell(offsetX, offsetY, tileSize, doc.width, doc.height);
    if (!cell.inside) return;
    const changes = applyBrushAt(doc, currentTool(), cell.x, cell.y, activeValue);
    if (changes.length === 0) return;
    // o feedback é imediato e local; o comando sai no FIM do gesto
    gesture?.record(changes);
    onEdited();
  };

  // ------------------------------------------------ contribuições da vista

  /**
   * Comandos de VIDA CURTA: existem enquanto o painel está montado e são
   * devolvidos ao registro na limpeza. É isso que dá a um acorde um dono
   * único — o registro RECUSA um segundo pretendente, em vez de deixar os
   * dois conviverem e vencer o último montado.
   *
   * O Ctrl+Z NÃO está mais aqui. A pintura virou comando canônico (F6), então
   * quem desfaz é `document.undo`, registrado pela casca: o mesmo acorde
   * desfaz a pincelada, o comando de um agente e a edição de outra borda,
   * porque agora os três são a mesma coisa.
   */
  const viewCommandIds = ["entity.remove"] as const;
  workbench.commands.register({
    id: "entity.remove",
    label: "Remover a entidade selecionada",
    category: "Editar",
    requires: ["entities.spawn"],
    requiresProject: true,
    order: 4,
    keybindings: ["Delete"],
    run: () => removeSelectedEntity(),
  });

  ctx.setInspectorData({
    fields(sectionId, selection) {
      if (selection.kind !== "entity") return [];
      const marker = entities.get(selection.ids[0] ?? "");
      if (!marker) return [];
      if (sectionId === "entity.identity") {
        return [
          { label: "Identificador", value: marker.entityId },
          { label: "Definição", value: marker.entityDefId },
        ];
      }
      if (sectionId === "entity.transform") {
        return [
          { label: "X (pixels do mundo)", value: String(marker.position[0]) },
          { label: "Y (pixels do mundo)", value: String(marker.position[1]) },
          { label: "Célula", value: `${Math.floor(marker.position[0] / tileSize)}, ${Math.floor(marker.position[1] / tileSize)}` },
        ];
      }
      return [];
    },
  });

  // dígitos da paleta: teclas que só existem DENTRO desta vista, resolvidas
  // depois dos comandos e das ferramentas para nunca roubar um atalho global
  ctx.setKeyHandler((stroke) => {
    if (stroke.ctrlKey === true || stroke.metaKey === true || stroke.altKey === true) return false;
    const entry = palette.find((p) => p.shortcut === stroke.key);
    if (!entry) return false;
    selectValue(entry.value);
    return true;
  });

  /**
   * Mudança que veio de FORA (desfazer canônico, agente, outra borda) tem de
   * aparecer no canvas — senão o Ctrl+Z canônico desfaria no documento e a
   * tela continuaria mostrando o traço desfeito. Durante uma pincelada a
   * reidratação é adiada: puxar o grid no meio do traço faria a pintura do
   * usuário sumir sob a mão dele.
   */
  ctx.setDocumentListener?.((event) => {
    if (!shouldRehydrate(event.kind, event.commandSequence, ownSequences)) return;
    rehydratePending = true;
    // com pincelada em curso, quem reidrata é o fim dela; sem, entra na fila
    // agora — mas pela fila, nunca por fora dela
    if (!gesture) endGesture();
  });

  // a barra de ferramentas e o realce da seleção acompanham o workbench
  const unsubscribe = workbench.onChange(() => {
    renderToolStrip();
    repaint();
  });
  renderToolStrip();

  ctx.setCleanup(() => {
    unsubscribe();
    observer.disconnect();
    clearTimeout(previewTimer);
    window.removeEventListener("mouseup", onMouseUp);
    // devolver os comandos LIBERA os acordes: sem isso remontar o painel
    // bateria no conflito de id que o registro impõe de propósito
    for (const id of viewCommandIds) workbench.commands.unregister(id);
    // a seleção NÃO é limpa aqui: quem troca de painel já a limpa, e limpá-la
    // durante a desmontagem notificaria a casca no meio do próprio render
  });

  let painting = false;
  let panning = false;
  let last = { x: 0, y: 0 };
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 1) {
      panning = true;
      last = { x: e.offsetX, y: e.offsetY };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const tool = currentTool();

    if (tool === "picker") {
      const cell = viewport.screenToCell(e.offsetX, e.offsetY, tileSize, doc.width, doc.height);
      if (cell.inside) {
        const value = doc.valueAt(cell.x, cell.y);
        if (value > 0) selectValue(value);
        workbench.activateTool(value > 0 ? "pencil" : "eraser");
        status.textContent =
          value > 0
            ? `Significado "${palette.find((p) => p.value === value)?.name ?? value}" selecionado.`
            : "Célula vazia: borracha selecionada.";
      }
      return;
    }

    if (tool === "entity") {
      const hit = entityAtScreen(e.offsetX, e.offsetY);
      if (hit) {
        selectEntity(hit.entityId);
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
        beginGesture();
        repaint();
      }
      return;
    }

    painting = true;
    beginGesture();
    applyAt(e.offsetX, e.offsetY);
  });
  canvas.addEventListener("mousemove", (e) => {
    const cell = viewport.screenToCell(e.offsetX, e.offsetY, tileSize, doc.width, doc.height);
    status.textContent = cell.inside ? `Célula (${cell.x}, ${cell.y})` : "Fora do nível";
    const tool = currentTool();
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
  const onMouseUp = (): void => {
    if (draggingEntity) {
      const marker = draggingEntity;
      draggingEntity = undefined;
      void moveEntity(marker, marker.position).catch((err) => {
        status.textContent = `Falha ao mover: ${err instanceof Error ? err.message : err}`;
      });
    }
    if (dragAnchor && dragCurrent) {
      const changes = commitDrag(doc, currentTool(), dragAnchor, dragCurrent, activeValue);
      dragAnchor = undefined;
      dragCurrent = undefined;
      if (changes.length > 0) {
        gesture?.record(changes);
        onEdited();
      }
    }
    painting = false;
    panning = false;
    // fecha a pincelada mesmo quando ela não pintou nada: é aqui que uma
    // mudança externa represada durante o traço entra
    endGesture();
  };
  window.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      viewport.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      repaint();
    },
    { passive: false },
  );

  async function publish(): Promise<void> {
    // as MESMAS regras do preview ("Ver arte"): preview ≡ publicação
    const payload = doc.toLevelPayload({ levelId, tileSize, seed, rules });
    try {
      const outcome = await window.gridsmith.dispatch(
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
    let openLevelTilesetId: string | undefined;
    try {
      const result = (await window.gridsmith.query("levels")) as { levels?: HydratedLevel[] };
      const existing = pickLevel(result.levels ?? [], ctx.levelId);
      if (existing) {
        // o nível aberto passa a ditar id, escala, seed e regras — publicar
        // vira level/update DELE, não level/define de um segundo nível
        levelId = existing.levelId;
        if (typeof existing.tileSize === "number" && existing.tileSize > 0) {
          tileSize = existing.tileSize;
        }
        if (typeof existing.seed === "number") seed = existing.seed;
        if (Array.isArray(existing.rules) && existing.rules.length > 0) rules = existing.rules;
        doc = new IntGridDocument(existing.width, existing.height, existing.intGrid);
        // o projeto ABERTO dita os significados: desenhar a constante de build
        // sobre um documento que declara outra paleta era a interface
        // afirmando o que o projeto não diz
        applyPalette(existing.palette);
        levelInBlueprint = true;
        viewport.fit(doc.width, doc.height, tileSize);
        onEdited();
        status.textContent = "Nível carregado do projeto.";
        if (typeof existing.tilesetId === "string" && existing.tilesetId.length > 0) {
          openLevelTilesetId = existing.tilesetId;
        }
      }

      // A camada de entidades hidrata no PRÓPRIO try: o atlas vem depois dela
      // (precisa saber quais sprites existem), e sem esta separação uma falha
      // aqui deixaria o NÍVEL sem arte — degradação por acidente de ordem, que
      // é justamente o que o host não acompanharia.
      try {
        const placed = (await window.gridsmith.query("entities")) as {
          entities?: Array<{ entityId: string; entityDefId: string; position: [number, number] }>;
        };
        for (const entity of placed.entities ?? []) {
          entities.set(entity.entityId, {
            entityId: entity.entityId,
            entityDefId: entity.entityDefId,
            position: [...entity.position],
          });
        }
        const defs = (await window.gridsmith.query("entityDefs")) as {
          entityDefs?: EntityDefView[];
        };
        for (const definition of defs.entityDefs ?? []) {
          entityDefsById.set(definition.entityDefId, definition);
        }
        const chosen = pickEntityDef(defs.entityDefs ?? []);
        if (chosen) {
          // usa a definição QUE O PROJETO TEM: criar uma paralela produziria
          // entidades sem archetypeId, que a projeção recusa com razão
          entityDef = chosen;
          entityDefEnsured = true;
        }
      } catch {
        // sem entidades: o nível ainda desenha, e com o atlas dele
      }

      // Os atlas vêm da MESMA consulta canônica que o agente usa, e numa
      // consulta SÓ: o do nível e o de cada sprite de definição. Pedir os
      // tilesets antes das definições custaria uma segunda ida ao gateway
      // para descobrir a arte dos atores.
      const needed = requiredTilesetIds(openLevelTilesetId, entityDefsById.values());
      if (needed.length > 0) {
        const atlas = (await window.gridsmith.query("tilesets")) as {
          tilesets?: TilesetTable[];
        };
        const tables = new Map((atlas.tilesets ?? []).map((table) => [table.tilesetId, table]));
        // sem tilesetId (ou sem tabela) o preview do nível continua em TILE_COLORS
        loadAtlas(openLevelTilesetId === undefined ? undefined : tables.get(openLevelTilesetId));
        for (const tilesetId of needed) {
          const table = tables.get(tilesetId);
          if (table) ensureAtlas(table);
        }
      }
      // a seleção pode ter sobrevivido a uma remoção vinda de outra borda
      workbench.selection.retain((id) => entities.has(id));
      if (entities.size > 0) repaint();
    } catch {
      // gateway indisponível: o editor continua editável com um grid vazio
    }
  })();
}
