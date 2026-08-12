/**
 * Atalhos de teclado como DADO (E10).
 *
 * Um atalho é um acorde normalizado, não uma cadeia de `if` dentro de cada
 * vista. Isso é o que permite detectar conflito no registro: enquanto cada
 * vista instalava o próprio `keydown`, dois donos do mesmo Ctrl+Z conviviam
 * em silêncio e vencia quem tivesse sido montado por último.
 *
 * Módulo puro (regra F1) — não depende de `KeyboardEvent`, só do formato.
 */

export interface Chord {
  /**
   * Ctrl e Cmd são o MESMO modificador aqui, de propósito. Separá-los faria um
   * atalho existir só numa plataforma, e o editor roda nas duas.
   */
  readonly ctrlOrCmd: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** Tecla normalizada em minúsculas: "z", "delete", "f5", "1". */
  readonly key: string;
}

/** O mínimo que o núcleo precisa de um evento de teclado — sem tipos do DOM. */
export interface KeyStroke {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

export class InvalidChordError extends Error {
  constructor(text: string, detail: string) {
    super(`atalho inválido "${text}": ${detail}`);
    this.name = "InvalidChordError";
  }
}

const CTRL_TOKENS = new Set(["ctrl", "control", "cmd", "command", "meta", "mod", "ctrlorcmd"]);
const ALT_TOKENS = new Set(["alt", "option", "opt"]);

/** "Ctrl+Shift+Z" → acorde. Modificador desconhecido é erro, não é ignorado. */
export function parseChord(text: string): Chord {
  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new InvalidChordError(text, "vazio");

  const isModifier = (token: string): boolean =>
    CTRL_TOKENS.has(token) || token === "shift" || ALT_TOKENS.has(token);

  const key = parts[parts.length - 1]!.toLowerCase();
  if (isModifier(key)) throw new InvalidChordError(text, "sem tecla, só modificadores");

  let ctrlOrCmd = false;
  let shift = false;
  let alt = false;
  for (const part of parts.slice(0, -1)) {
    const token = part.toLowerCase();
    if (CTRL_TOKENS.has(token)) ctrlOrCmd = true;
    else if (token === "shift") shift = true;
    else if (ALT_TOKENS.has(token)) alt = true;
    else throw new InvalidChordError(text, `modificador desconhecido "${part}"`);
  }
  return { ctrlOrCmd, shift, alt, key };
}

export function chordFromStroke(stroke: KeyStroke): Chord {
  return {
    ctrlOrCmd: stroke.ctrlKey === true || stroke.metaKey === true,
    shift: stroke.shiftKey === true,
    alt: stroke.altKey === true,
    key: stroke.key.toLowerCase(),
  };
}

/** Chave de mapa: dois acordes iguais produzem a MESMA string. */
export function chordKey(chord: Chord): string {
  return [
    chord.ctrlOrCmd ? "mod" : "",
    chord.shift ? "shift" : "",
    chord.alt ? "alt" : "",
    chord.key,
  ]
    .filter(Boolean)
    .join("+");
}

const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  delete: "Delete",
  backspace: "Backspace",
  escape: "Esc",
  enter: "Enter",
  " ": "Espaço",
  tab: "Tab",
};

/**
 * Rótulo do atalho para a UI. `mac` troca o Ctrl pelo símbolo de Command —
 * a escolha da plataforma é da casca, não do núcleo.
 */
export function formatChord(chord: Chord, mac = false): string {
  const parts: string[] = [];
  if (chord.ctrlOrCmd) parts.push(mac ? "⌘" : "Ctrl");
  if (chord.shift) parts.push("Shift");
  if (chord.alt) parts.push(mac ? "⌥" : "Alt");
  const key = DISPLAY_KEYS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  parts.push(key);
  return parts.join("+");
}
