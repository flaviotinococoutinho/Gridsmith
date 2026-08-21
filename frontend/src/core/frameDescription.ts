/**
 * Descrição de frame no lado do EDITOR — o espelho exato do `FrameComposer`
 * da engine (`Gridsmith.Engine.Core/Rendering/FrameComposer.cs`).
 *
 * É a metade TS da paridade visual da ADR-022: dado o MESMO estado (tiles
 * resolvidos, atores, recorte), os dois lados produzem a MESMA lista de quads
 * — culling, ordem do pintor, âncora do ator, célula parcial da borda, tudo.
 * `scripts/verify-visual-parity.sh` compara as duas saídas BYTE a BYTE, sem
 * tolerância: qualquer divergência de fórmula aparece como diff, não como
 * "ficou parecido".
 *
 * Por isso este módulo NÃO reusa `canvasViewport` nem abstrações do canvas: a
 * matemática espelha a da engine linha a linha, e reescrevê-la "no idioma do
 * editor" é exatamente o tipo de refactor que faria as duas listas divergirem
 * em silêncio.
 *
 * Módulo puro (regra F1).
 */

export interface FrameLevelState {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  /** width*height tiles RESOLVIDOS, linha-maior; -1 = sem arte. */
  readonly tiles: readonly number[];
}

export interface FrameActorState {
  /** Posição do CENTRO, em pixels do mundo (ENTITY_ANCHOR = center). */
  readonly x: number;
  readonly y: number;
}

export interface FrameViewportState {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
}

export interface FrameQuadDescription {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly tileId: number;
  readonly layer: "tilemap" | "actor";
  readonly source: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Ordem do pintor: tilemap primeiro, atores por cima — como na engine. */
export function composeFrame(
  level: FrameLevelState | undefined,
  actors: readonly FrameActorState[],
  viewport: FrameViewportState,
  actorSize: number,
): FrameQuadDescription[] {
  const quads: FrameQuadDescription[] = [];
  const halfWorldWidth = viewport.width / (2 * viewport.zoom);
  const halfWorldHeight = viewport.height / (2 * viewport.zoom);

  if (level && level.width > 0 && level.height > 0 && level.tileSize > 0) {
    const minX = viewport.centerX - halfWorldWidth;
    const maxX = viewport.centerX + halfWorldWidth;
    const minY = viewport.centerY - halfWorldHeight;
    const maxY = viewport.centerY + halfWorldHeight;

    const firstColumn = clamp(Math.floor(minX / level.tileSize), 0, level.width - 1);
    const lastColumn = clamp(Math.floor(maxX / level.tileSize), 0, level.width - 1);
    const firstRow = clamp(Math.floor(minY / level.tileSize), 0, level.height - 1);
    const lastRow = clamp(Math.floor(maxY / level.tileSize), 0, level.height - 1);

    const outside =
      maxX < 0 || maxY < 0 || minX > level.width * level.tileSize || minY > level.height * level.tileSize;
    if (!outside) {
      for (let row = firstRow; row <= lastRow; row++) {
        const rowOffset = row * level.width;
        for (let column = firstColumn; column <= lastColumn; column++) {
          const tileId = level.tiles[rowOffset + column]!;
          if (tileId < 0) continue; // célula sem arte não vira quad
          quads.push({
            x: column * level.tileSize,
            y: row * level.tileSize,
            width: level.tileSize,
            height: level.tileSize,
            tileId,
            layer: "tilemap",
            source: rowOffset + column,
          });
        }
      }
    }
  }

  if (actors.length > 0 && actorSize > 0) {
    const half = actorSize / 2;
    const minX = viewport.centerX - halfWorldWidth - half;
    const maxX = viewport.centerX + halfWorldWidth + half;
    const minY = viewport.centerY - halfWorldHeight - half;
    const maxY = viewport.centerY + halfWorldHeight + half;

    for (const [slot, actor] of actors.entries()) {
      if (actor.x < minX || actor.x > maxX || actor.y < minY || actor.y > maxY) continue;
      quads.push({
        x: actor.x - half,
        y: actor.y - half,
        width: actorSize,
        height: actorSize,
        tileId: -1, // o archetype ainda não carrega sprite (B6)
        layer: "actor",
        source: slot,
      });
    }
  }

  return quads;
}

/**
 * Serialização canônica de UMA linha por quad, idêntica nos dois lados.
 *
 * Texto simples em vez de JSON de propósito: comparar JSON byte a byte
 * esbarraria nas diferenças de formatação de ponto flutuante entre
 * serializadores; aqui o formato numérico é definido POR NÓS ("0.###",
 * invariante) e os cenários usam apenas frações binárias exatas.
 */
export function describeFrame(quads: readonly FrameQuadDescription[]): string {
  const fmt = (value: number): string => {
    const rounded = Math.round(value * 1000) / 1000;
    const text = rounded.toFixed(3).replace(/\.?0+$/u, "");
    return text === "-0" ? "0" : text;
  };
  const lines = [`frame quads=${quads.length}`];
  for (const quad of quads) {
    lines.push(
      `quad x=${fmt(quad.x)} y=${fmt(quad.y)} w=${fmt(quad.width)} h=${fmt(quad.height)} ` +
        `tile=${quad.tileId} layer=${quad.layer} source=${quad.source}`,
    );
  }
  return lines.join("\n") + "\n";
}
