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

  /** Mais recentes primeiro, com filtro por texto (label/subject) e status. */
  list(filter: LogFilter = {}): readonly LogEntry[] {
    const text = filter.text?.toLowerCase();
    return [...this.entries]
      .reverse()
      .filter((entry) => {
        if (filter.status && entry.projectionStatus !== filter.status) return false;
        if (text) {
          const haystack = `${entry.label} ${entry.subject ?? ""} ${entry.projectionReason ?? ""}`.toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        return true;
      });
  }

  get size(): number {
    return this.entries.length;
  }

  /** Troca de ProjectSession cria uma nova partição de diagnóstico. */
  clear(): void {
    this.entries.splice(0);
  }

  /** Problemas: entradas skipped/deferred (alimenta o contador da status bar). */
  get problemCount(): number {
    return this.entries.filter(
      (e) => e.projectionStatus === "skipped" || e.projectionStatus === "deferred",
    ).length;
  }
}
