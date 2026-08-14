/**
 * Importador do export CLI do Aseprite — a arte é a fonte da verdade do
 * timing (ver docs/RESEARCH-EDITOR-LANDSCAPE.md).
 *
 * Consome o JSON gerado por `aseprite -b sprite.ase --sheet out.png --data
 * out.json --list-tags --list-slices` nos DOIS formatos (`json-hash`, com
 * frames como objeto, e `json-array`) e o normaliza para o modelo Gridsmith:
 *
 * - `meta.frameTags` → clipes de animação (com a direção pingpong/reverse
 *   EXPANDIDA deterministicamente para a sequência de playback);
 * - `meta.slices`   → pivôs e centros de 9-slice;
 * - durações por frame → timeline em milissegundos.
 *
 * O watcher taxonômico da Fase 4 chama o CLI e alimenta este importador; o
 * resultado abastece os clipes do editor e o compile MGCB → .xnb.
 */

export interface SpriteFrame {
  readonly index: number;
  /** Retângulo no spritesheet. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly durationMs: number;
}

export type ClipDirection = "forward" | "reverse" | "pingpong";

export interface AnimationClip {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly direction: ClipDirection;
  /** Sequência de playback com a direção expandida (índices de frame). */
  readonly playback: readonly number[];
  /** Duração total de UM ciclo do playback, em ms. */
  readonly durationMs: number;
}

export interface SpriteSlice {
  readonly name: string;
  readonly bounds: { x: number; y: number; w: number; h: number };
  /** Região central para 9-slice (relativa a bounds), se definida. */
  readonly center?: { x: number; y: number; w: number; h: number };
  /** Pivô (relativo a bounds), se definido. */
  readonly pivot?: { x: number; y: number };
}

export interface SpriteDocument {
  readonly imagePath: string;
  readonly frames: readonly SpriteFrame[];
  readonly clips: readonly AnimationClip[];
  readonly slices: readonly SpriteSlice[];
}

interface RawFrame {
  frame: { x: number; y: number; w: number; h: number };
  duration: number;
}

export class AsepriteImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsepriteImportError";
  }
}

/** Normaliza o JSON do Aseprite (objeto já parseado) para o modelo Gridsmith. */
export function importAseprite(data: unknown): SpriteDocument {
  const root = data as {
    frames?: unknown;
    meta?: {
      image?: string;
      frameTags?: Array<{ name: string; from: number; to: number; direction: string }>;
      slices?: Array<{
        name: string;
        keys?: Array<{
          frame: number;
          bounds: { x: number; y: number; w: number; h: number };
          center?: { x: number; y: number; w: number; h: number };
          pivot?: { x: number; y: number };
        }>;
      }>;
    };
  };

  if (!root || typeof root !== "object" || root.frames === undefined || root.meta === undefined) {
    throw new AsepriteImportError('Not an Aseprite export: missing "frames" or "meta"');
  }

  const frames = normalizeFrames(root.frames);
  if (frames.length === 0) {
    throw new AsepriteImportError("Aseprite export contains no frames");
  }

  const clips = (root.meta.frameTags ?? []).map((tag) => toClip(tag, frames));
  const slices = (root.meta.slices ?? []).map(toSlice);

  return {
    imagePath: root.meta.image ?? "",
    frames,
    clips,
    slices,
  };
}

/** Aceita tanto `json-array` (frames: []) quanto `json-hash` (frames: {}). */
function normalizeFrames(rawFrames: unknown): SpriteFrame[] {
  const entries: RawFrame[] = Array.isArray(rawFrames)
    ? (rawFrames as RawFrame[])
    : Object.values(rawFrames as Record<string, RawFrame>);

  return entries.map((raw, index) => {
    if (!raw?.frame || typeof raw.duration !== "number") {
      throw new AsepriteImportError(`Frame ${index} is malformed (missing "frame" or "duration")`);
    }
    return {
      index,
      x: raw.frame.x,
      y: raw.frame.y,
      w: raw.frame.w,
      h: raw.frame.h,
      durationMs: raw.duration,
    };
  });
}

function toClip(
  tag: { name: string; from: number; to: number; direction: string },
  frames: readonly SpriteFrame[],
): AnimationClip {
  if (
    !Number.isInteger(tag.from) ||
    !Number.isInteger(tag.to) ||
    tag.from < 0 ||
    tag.to >= frames.length ||
    tag.from > tag.to
  ) {
    throw new AsepriteImportError(
      `Frame tag "${tag.name}": range [${tag.from}..${tag.to}] is invalid for ${frames.length} frames`,
    );
  }

  const direction = normalizeDirection(tag.name, tag.direction);
  const playback = expandPlayback(tag.from, tag.to, direction);
  const durationMs = playback.reduce((total, frame) => total + frames[frame]!.durationMs, 0);
  return { name: tag.name, from: tag.from, to: tag.to, direction, playback, durationMs };
}

function normalizeDirection(tagName: string, direction: string): ClipDirection {
  switch (direction) {
    case "forward":
    case "reverse":
    case "pingpong":
      return direction;
    default:
      throw new AsepriteImportError(`Frame tag "${tagName}": unknown direction "${direction}"`);
  }
}

/**
 * Expande a direção para a sequência de playback de um ciclo:
 * - forward:  a, a+1, ..., b
 * - reverse:  b, b-1, ..., a
 * - pingpong: a, ..., b, b-1, ..., a+1  (extremos não repetem no retorno)
 */
export function expandPlayback(from: number, to: number, direction: ClipDirection): number[] {
  const ascending: number[] = [];
  for (let i = from; i <= to; i++) ascending.push(i);

  switch (direction) {
    case "forward":
      return ascending;
    case "reverse":
      return [...ascending].reverse();
    case "pingpong": {
      if (ascending.length <= 2) return ascending;
      const back = ascending.slice(1, -1).reverse();
      return [...ascending, ...back];
    }
  }
}

function toSlice(raw: {
  name: string;
  keys?: Array<{
    frame: number;
    bounds: { x: number; y: number; w: number; h: number };
    center?: { x: number; y: number; w: number; h: number };
    pivot?: { x: number; y: number };
  }>;
}): SpriteSlice {
  const key = raw.keys?.[0];
  if (!key?.bounds) {
    throw new AsepriteImportError(`Slice "${raw.name}" has no keys with bounds`);
  }
  return {
    name: raw.name,
    bounds: key.bounds,
    ...(key.center !== undefined ? { center: key.center } : {}),
    ...(key.pivot !== undefined ? { pivot: key.pivot } : {}),
  };
}
