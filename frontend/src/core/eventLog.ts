/**
 * Log estruturado do workbench (ALPHA-0.1 P0.3) — substitui o "hora — tipo".
 *
 * Cada entrada carrega o que o diagnóstico exigiu: rótulo humano, resumo do
 * payload, origem, status da projeção COM razão e o objeto afetado (para
 * navegação futura). Filtro por texto e por status, capacidade limitada —
 * tudo puro e testável; o renderer só desenha.
 */

import { eventLabel, projectionLabel } from "./vocabulary.js";

export interface LogEntry {
  readonly sequence: number;
  readonly timestampMs: number;
  /** Kind interno do evento (não exibir cru — use `label`). */
  readonly kind: string;
  readonly label: string;
  /** Id do objeto afetado (lightId, levelId...), quando identificável. */
  readonly subject?: string;
  /** Resumo curto do payload para a linha do log. */
  readonly summary: string;
  readonly projectionStatus?: "projected" | "skipped" | "deferred";
  readonly projectionLabel?: string;
  readonly projectionReason?: string;
  readonly actor?: "human" | "agent" | "pipeline";
  readonly historyAction?: "apply" | "undo" | "redo";
  readonly transactionId?: string;
  readonly projectSessionId?: string;
  readonly projectId?: string;
  readonly commandSequence?: string;
  readonly domain?: "blueprint" | "application";
  readonly severity?: "info" | "warning" | "error";
  readonly detail?: string;
  readonly applicationPayload?: Readonly<Record<string, unknown>>;
  readonly operationId?: string;
}

export interface LogFilter {
  readonly text?: string;
  readonly status?: "projected" | "skipped" | "deferred";
}

/** Extrai o id do objeto afetado dos shapes conhecidos de evento. */
export function subjectOf(event: Record<string, unknown>): string | undefined {
  const candidates = [
    (event["skeleton"] as { skeletonId?: string } | undefined)?.skeletonId,
    (event["binding"] as { meshId?: string } | undefined)?.meshId,
    (event["light"] as { lightId?: string } | undefined)?.lightId,
    event["lightId"],
    (event["definition"] as { entityDefId?: string } | undefined)?.entityDefId,
    (event["entity"] as { entityId?: string } | undefined)?.entityId,
    event["entityId"],
    (event["level"] as { levelId?: string } | undefined)?.levelId,
    event["levelId"],
    event["assetId"],
    (event["placement"] as { levelId?: string } | undefined)?.levelId,
  ];
  const found = candidates.find((c) => typeof c === "string" && c.length > 0);
  return found as string | undefined;
}

export class EventLog {
  private readonly entries: LogEntry[] = [];
  private sequence = 0;

  constructor(
    private readonly capacity = 500,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registra um evento do Blueprint (broadcast) com projeção opcional. */
  record(
    event: { kind: string } & Record<string, unknown>,
    projection?: { status: "projected" | "skipped" | "deferred"; reason?: string },
  ): LogEntry {
    const subject = subjectOf(event);
    const actor = event["actor"];
    const historyAction = event["historyAction"];
    const transactionId = event["transactionId"];
    const projectSessionId = event["projectSessionId"];
    const projectId = event["projectId"];
    const commandSequence = event["commandSequence"];
    const duplicateIndex = typeof commandSequence === "string" && typeof projectSessionId === "string"
      ? this.entries.findIndex((candidate) => candidate.commandSequence === commandSequence &&
        candidate.projectSessionId === projectSessionId)
      : -1;
    if (duplicateIndex >= 0) {
      const existing = this.entries[duplicateIndex]!;
      if (!projection) return existing;
      const {
        projectionStatus: _status,
        projectionLabel: _label,
        projectionReason: _reason,
        ...base
      } = existing;
      const updated: LogEntry = {
        ...base,
        projectionStatus: projection.status,
        projectionLabel: projectionLabel(projection.status),
        ...(projection.reason !== undefined ? { projectionReason: projection.reason } : {}),
      };
      this.entries[duplicateIndex] = updated;
      return updated;
    }
    const entry: LogEntry = {
      sequence: ++this.sequence,
      timestampMs: this.now(),
      kind: event.kind,
      label: eventLabel(event.kind),
      ...(subject !== undefined ? { subject } : {}),
      summary: subject !== undefined ? `${eventLabel(event.kind)}: ${subject}` : eventLabel(event.kind),
      ...(actor === "human" || actor === "agent" || actor === "pipeline" ? { actor } : {}),
      ...(historyAction === "apply" || historyAction === "undo" || historyAction === "redo"
        ? { historyAction }
        : {}),
      ...(typeof transactionId === "string" ? { transactionId } : {}),
      ...(typeof projectSessionId === "string" ? { projectSessionId } : {}),
      ...(typeof projectId === "string" ? { projectId } : {}),
      ...(typeof commandSequence === "string" ? { commandSequence } : {}),
      domain: "blueprint",
      ...(projection !== undefined
        ? {
            projectionStatus: projection.status,
            projectionLabel: projectionLabel(projection.status),
            ...(projection.reason !== undefined ? { projectionReason: projection.reason } : {}),
          }
        : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }

  /** Eventos operacionais têm severidade própria e não fingem projeção Blueprint. */
  recordApplication(event: {
    readonly seq: string;
    readonly domain: string;
    readonly kind: string;
    readonly severity: "info" | "warning" | "error";
    readonly projectSessionId?: string;
    readonly projectId?: string;
    readonly operationId?: string;
    readonly payload?: unknown;
    readonly detail?: string;
  }): LogEntry {
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : undefined;
    const subject = firstString(payload?.["assetId"], payload?.["sourcePath"], event.operationId);
    const commandSequence = `application:${event.domain}:${event.seq}`;
    const duplicateIndex = event.projectSessionId
      ? this.entries.findIndex((candidate) => candidate.commandSequence === commandSequence &&
        candidate.projectSessionId === event.projectSessionId)
      : -1;
    if (duplicateIndex >= 0) return this.entries[duplicateIndex]!;
    const detail = event.detail ?? firstString(payload?.["message"], payload?.["stderr"]);
    const label = eventLabel(event.kind);
    const entry: LogEntry = {
      sequence: ++this.sequence,
      timestampMs: this.now(),
      kind: event.kind,
      label,
      summary: subject ? `${label}: ${subject}` : label,
      domain: "application",
      severity: event.severity,
      commandSequence,
      ...(subject ? { subject } : {}),
      ...(event.operationId ? { operationId: event.operationId } : {}),
      ...(detail ? { detail } : {}),
      ...(payload ? { applicationPayload: { ...payload } } : {}),
      ...(event.projectSessionId ? { projectSessionId: event.projectSessionId } : {}),
      ...(event.projectId ? { projectId: event.projectId } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }

  /** Mais recentes primeiro, com filtro por texto (label/subject) e status. */
  list(filter: LogFilter = {}): readonly LogEntry[] {
    const text = filter.text?.toLowerCase();
    return [...this.entries]
      .reverse()
      .filter((entry) => {
        if (filter.status && entry.projectionStatus !== filter.status) return false;
        if (text) {
          const haystack = `${entry.label} ${entry.subject ?? ""} ${entry.projectionReason ?? ""} ${entry.detail ?? ""}`.toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        return true;
      });
  }

  get size(): number {
    return this.entries.length;
  }

  resolveApplication(options: {
    readonly kind: string;
    readonly projectSessionId?: string;
    readonly subject?: string;
    readonly operationId?: string;
  }): number {
    let removed = 0;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!;
      if (entry.domain !== "application" || entry.kind !== options.kind) continue;
      if (options.projectSessionId && entry.projectSessionId !== options.projectSessionId) continue;
      if (options.subject && entry.subject !== options.subject) continue;
      if (options.operationId && entry.operationId !== options.operationId) continue;
      this.entries.splice(index, 1);
      removed++;
    }
    return removed;
  }

  /** Troca de ProjectSession cria uma nova partição de diagnóstico. */
  clear(): void {
    this.entries.splice(0);
  }

  /** Problemas: entradas skipped/deferred (alimenta o contador da status bar). */
  get problemCount(): number {
    return this.entries.filter(
      (e) => e.projectionStatus === "skipped" || e.projectionStatus === "deferred" ||
        e.severity === "warning" || e.severity === "error",
    ).length;
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}
