/**
 * Logger estruturado com CONTROLE DE VERBOSIDADE (GRIDSMITH_VERBOSITY).
 *
 * Zero dependências (portável a workers, como fnv1a — regra R5-friendly).
 * Níveis: silent < error < warn < info < debug < trace. O nível ativo vem de
 * `GRIDSMITH_VERBOSITY` (default "info"); o sink é injetável para os testes — o
 * default escreve em stderr (stdout é reservado ao transporte MCP).
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

/** true sse `level` deve ser emitido quando o nível ativo é `active`. */
export function levelEnabled(active: LogLevel, level: Exclude<LogLevel, "silent">): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(active) && active !== "silent";
}

/** Linha estável: `[scope] LEVEL message — detail(json)`. */
export function formatRecord(record: LogRecord): string {
  const detail =
    record.detail === undefined ? "" : ` — ${safeJson(record.detail)}`;
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

const defaultSink: LogSink = (line) => {
  // stderr: stdout é o transporte MCP (contrato do processo)
  (globalThis as { process?: { stderr?: { write(s: string): void } } }).process?.stderr?.write(
    `${line}\n`,
  );
};

export function createLogger(
  scope: string,
  options: { level?: LogLevel; sink?: LogSink } = {},
): Logger {
  const level =
    options.level ??
    parseLogLevel(
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
        "GRIDSMITH_VERBOSITY"
      ],
    );
  const sink = options.sink ?? defaultSink;

  const emit = (recordLevel: Exclude<LogLevel, "silent">, message: string, detail?: unknown): void => {
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
