/**
 * Viewport do canvas de níveis (ALPHA-0.1 P0.4): pan, zoom no cursor, fit e
 * as transformações tela↔mundo↔célula. Puro (portável para o worker de
 * render) — o canvas real só aplica `worldToScreen` ao desenhar e converte
 * eventos de mouse com `screenToCell`.
 *
 * Convenções: mundo em pixels (célula = tileSize px); tela em pixels CSS com
 * origem no canto superior esquerdo do canvas.
 */

export interface ViewportState {
  /** Posição do mundo no canto superior esquerdo da tela. */
  readonly worldX: number;
  readonly worldY: number;
  /** Pixels de tela por pixel de mundo. */
  readonly zoom: number;
}

export interface CellHit {
  readonly x: number;
  readonly y: number;
  readonly inside: boolean;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 32;

export class CanvasViewport {
  private state: ViewportState = { worldX: 0, worldY: 0, zoom: 1 };

  constructor(
    public viewWidth: number,
    public viewHeight: number,
  ) {}

  get current(): ViewportState {
    return this.state;
  }

  /** Redimensionamento do canvas (mantém o canto superior esquerdo estável). */
  resize(viewWidth: number, viewHeight: number): void {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: (worldX - this.state.worldX) * this.state.zoom,
      y: (worldY - this.state.worldY) * this.state.zoom,
    };
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: this.state.worldX + screenX / this.state.zoom,
      y: this.state.worldY + screenY / this.state.zoom,
    };
  }

  /** Célula sob o cursor, com verificação de limites do grid. */
  screenToCell(
    screenX: number,
    screenY: number,
    tileSize: number,
    gridWidth: number,
    gridHeight: number,
  ): CellHit {
    const world = this.screenToWorld(screenX, screenY);
    const x = Math.floor(world.x / tileSize);
    const y = Math.floor(world.y / tileSize);
    return { x, y, inside: x >= 0 && y >= 0 && x < gridWidth && y < gridHeight };
  }

  /** Pan em pixels de TELA (drag do botão do meio / espaço+drag). */
  panByScreen(deltaX: number, deltaY: number): void {
    this.state = {
      ...this.state,
      worldX: this.state.worldX - deltaX / this.state.zoom,
      worldY: this.state.worldY - deltaY / this.state.zoom,
    };
  }

  /**
   * Zoom CENTRADO NO CURSOR: o ponto do mundo sob o cursor permanece sob o
   * cursor após o zoom (comportamento padrão de editores de mapa).
   */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const anchor = this.screenToWorld(screenX, screenY);
    const zoom = clamp(this.state.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.state = {
      zoom,
      worldX: anchor.x - screenX / zoom,
      worldY: anchor.y - screenY / zoom,
    };
  }

  /** Enquadra o nível inteiro com margem, centralizado. */
  fit(gridWidth: number, gridHeight: number, tileSize: number, marginPx = 24): void {
    const worldW = gridWidth * tileSize;
    const worldH = gridHeight * tileSize;
    const zoom = clamp(
      Math.min(
        (this.viewWidth - marginPx * 2) / worldW,
        (this.viewHeight - marginPx * 2) / worldH,
      ),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    this.state = {
      zoom,
      worldX: -(this.viewWidth / zoom - worldW) / 2,
      worldY: -(this.viewHeight / zoom - worldH) / 2,
    };
  }

  /** Faixa de células visíveis (culling do render). */
  visibleCells(
    tileSize: number,
    gridWidth: number,
    gridHeight: number,
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.viewWidth, this.viewHeight);
    return {
      minX: Math.max(0, Math.floor(topLeft.x / tileSize)),
      minY: Math.max(0, Math.floor(topLeft.y / tileSize)),
      maxX: Math.min(gridWidth - 1, Math.floor(bottomRight.x / tileSize)),
      maxY: Math.min(gridHeight - 1, Math.floor(bottomRight.y / tileSize)),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
