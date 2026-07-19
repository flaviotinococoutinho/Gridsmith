/**
 * Histórico append-only de uma única sessão de projeto.
 *
 * Nesta fase ele não implementa undo/redo: é exclusivamente o relógio lógico
 * que associa cada comando aplicado ao evento resultante. Uma nova sessão
 * recebe uma nova instância, portanto sequências nunca vazam entre projetos.
 */

import type { BlueprintCommand, BlueprintEvent } from "../domain/BlueprintStore.js";

export interface CommandHistoryEntry {
  readonly commandSequence: bigint;
  readonly command: BlueprintCommand;
  readonly event: BlueprintEvent;
  readonly appliedAt: number;
}

export class CommandHistory {
  private readonly entries: CommandHistoryEntry[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  get lastSequence(): bigint {
    return this.entries.at(-1)?.commandSequence ?? 0n;
  }

  get length(): number {
    return this.entries.length;
  }

  list(): readonly CommandHistoryEntry[] {
    return Object.freeze([...this.entries]);
  }

  append(command: BlueprintCommand, event: BlueprintEvent): CommandHistoryEntry {
    const entry: CommandHistoryEntry = Object.freeze({
      commandSequence: this.lastSequence + 1n,
      command,
      event,
      appliedAt: this.now(),
    });
    this.entries.push(entry);
    return entry;
  }
}
