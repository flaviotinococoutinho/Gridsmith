/**
 * Logger do editor com CONTROLE DE VERBOSIDADE — núcleo puro (regra F1:
 * zero imports; portável a workers e ao renderer).
 *
 * Níveis: silent < error < warn < info < debug < trace. O nível ativo vem de
 * `P7M_VERBOSITY` quando há `process.env` (main); no renderer o nível é
 * passado explicitamente. Sink injetável — os testes capturam linhas; o
 * default usa console.error (nunca stdout, reservado a protocolos).
 */

export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogRecord {
  readonly level: Exclude<LogLevel, "silent">;
  readonly scope: string;
  readonly message: string;
  readonly detail?: unknown;
}

export type LogSink = (line: string, record: LogRecord) => void;

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const normalized = raw?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(normalized ?? "")
    ? (normalized as LogLevel)
    : fallback;
}

export function levelEnabled(active: LogLevel, level: Exclude<LogLevel, "silent">): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(active) && active !== "silent";
}

export function formatRecord(record: LogRecord): string {
  const detail = record.detail === undefined ? "" : ` — ${safeJson(record.detail)}`;
  return `[${record.scope}] ${record.level.toUpperCase()} ${record.message}${detail}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  readonly scope: string;
  readonly level: LogLevel;
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
  trace(message: string, detail?: unknown): void;
  child(scope: string): Logger;
}

function envLevel(): LogLevel {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return parseLogLevel(env?.["P7M_VERBOSITY"]);
}

const defaultSink: LogSink = (line) => {
  console.error(line);
};

export function createLogger(
  scope: string,
  options: { level?: LogLevel; sink?: LogSink } = {},
): Logger {
  const level = options.level ?? envLevel();
  const sink = options.sink ?? defaultSink;

  const emit = (
    recordLevel: Exclude<LogLevel, "silent">,
    message: string,
    detail?: unknown,
  ): void => {
    if (!levelEnabled(level, recordLevel)) return;
    const record: LogRecord = {
      level: recordLevel,
      scope,
      message,
      ...(detail !== undefined ? { detail } : {}),
    };
    sink(formatRecord(record), record);
  };

  return {
    scope,
    level,
    error: (m, d) => emit("error", m, d),
    warn: (m, d) => emit("warn", m, d),
    info: (m, d) => emit("info", m, d),
    debug: (m, d) => emit("debug", m, d),
    trace: (m, d) => emit("trace", m, d),
    child: (childScope) => createLogger(`${scope}:${childScope}`, { level, sink }),
  };
}
