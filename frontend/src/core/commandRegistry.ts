import {
  ContributionUnavailableError,
  evaluateCapabilities,
  type ContributionAvailability,
} from "./capabilityRegistry.js";
import type { ContributionContext } from "./contributionContext.js";
import {
  supportsSelections,
  type SelectionKind,
  type SelectionMatchPolicy,
} from "./selectionService.js";

export type CommandSurface =
  | "menu"
  | "toolbar"
  | "context-menu"
  | "command-palette"
  | "shortcut"
  | "corrective-action";

interface PlacementBase<S extends CommandSurface> {
  readonly surface: S;
  readonly group?: string;
  readonly order?: number;
}

export interface MenuCommandPlacement extends PlacementBase<"menu"> {
  /** Caminho semântico, por exemplo `["Projeto", "Abrir"]`. */
  readonly path: readonly string[];
}

export interface ToolbarCommandPlacement extends PlacementBase<"toolbar"> {
  readonly compactLabel?: string;
}

export interface ContextMenuCommandPlacement extends PlacementBase<"context-menu"> {}

export interface PaletteCommandPlacement extends PlacementBase<"command-palette"> {}

export interface ShortcutCommandPlacement extends PlacementBase<"shortcut"> {
  /** Chord declarativo e independente de KeyboardEvent, como `CtrlOrMeta+Shift+P`. */
  readonly chord: string;
}

export interface CorrectiveCommandPlacement extends PlacementBase<"corrective-action"> {
  /** Categoria de problema que pode sugerir a ação. */
  readonly problemKind?: string;
}

export type CommandPlacement =
  | MenuCommandPlacement
  | ToolbarCommandPlacement
  | ContextMenuCommandPlacement
  | PaletteCommandPlacement
  | ShortcutCommandPlacement
  | CorrectiveCommandPlacement;

export interface CommandEnablement {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface CommandContribution<TArguments = unknown, TResult = unknown> {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly icon?: string;
  readonly keywords?: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly supportedSelections?: readonly SelectionKind[];
  readonly selectionPolicy?: SelectionMatchPolicy;
  /** O boundary DOM deve confirmar drafts focados antes de executar. */
  readonly commitEditorDrafts?: boolean;
  readonly placements: readonly CommandPlacement[];
  readonly visibleWhen?: (context: ContributionContext) => boolean;
  readonly enableWhen?: (context: ContributionContext) => boolean | CommandEnablement;
  execute(context: ContributionContext, args: TArguments): TResult | Promise<TResult>;
}

export interface ResolvedCommand extends ContributionAvailability {
  readonly contribution: CommandContribution;
}

export interface PlacedCommand extends ResolvedCommand {
  readonly placement: CommandPlacement;
}

export interface CommandListOptions {
  readonly includeHidden?: boolean;
  readonly includeDisabled?: boolean;
  readonly group?: string;
}

export interface PaletteMatch extends ResolvedCommand {
  readonly score: number;
  readonly matchedText: string;
}

export interface ShortcutExecution<TResult = unknown> {
  readonly handled: boolean;
  readonly commandId?: string;
  readonly result?: TResult;
  readonly reason?: string;
}

export type ResolvedShortcutCommand = PlacedCommand & {
  readonly placement: ShortcutCommandPlacement;
};

export interface CommandExecutionEvent {
  readonly commandId: string;
}

export class CommandRegistry {
  private readonly contributions = new Map<string, CommandContribution>();
  private readonly listeners = new Set<() => void>();
  private readonly executionListeners = new Set<(event: CommandExecutionEvent) => void>();

  register<TArguments, TResult>(contribution: CommandContribution<TArguments, TResult>): () => void {
    assertCommand(contribution);
    if (this.contributions.has(contribution.id)) {
      throw new Error(`Command contribution “${contribution.id}” is already registered.`);
    }
    // A coleção é heterogênea por construção; o boundary execute recebe unknown.
    this.contributions.set(contribution.id, contribution as CommandContribution);
    this.notify();
    return () => {
      if (this.contributions.get(contribution.id) !== contribution) return;
      this.contributions.delete(contribution.id);
      this.notify();
    };
  }

  get(id: string): CommandContribution | undefined {
    return this.contributions.get(id);
  }

  availability(id: string, context: ContributionContext): ResolvedCommand | undefined {
    const contribution = this.contributions.get(id);
    if (!contribution) return undefined;
    const capability = evaluateCapabilities(contribution.requiredCapabilities, context.capabilities);
    const selectionSupported = supportsSelections(
      contribution.supportedSelections,
      context.selection.selections,
      contribution.selectionPolicy,
    );
    const visible = selectionSupported && (contribution.visibleWhen?.(context) ?? true);
    const dynamic = normalizeEnablement(contribution.enableWhen?.(context));
    const enabled = visible && capability.enabled && dynamic.enabled;
    const reason = !selectionSupported
      ? "O comando não se aplica à seleção atual."
      : capability.reason ?? (!dynamic.enabled ? dynamic.reason : undefined);

    return {
      contribution,
      visible,
      enabled,
      ...(reason ? { reason } : {}),
      missingCapabilities: capability.missingCapabilities,
    };
  }

  list(
    surface: CommandSurface,
    context: ContributionContext,
    options: CommandListOptions = {},
  ): PlacedCommand[] {
    const result: PlacedCommand[] = [];
    for (const contribution of this.contributions.values()) {
      const resolved = this.availability(contribution.id, context)!;
      if (!options.includeHidden && !resolved.visible) continue;
      if (options.includeDisabled === false && !resolved.enabled) continue;
      for (const placement of contribution.placements) {
        if (placement.surface !== surface) continue;
        if (options.group !== undefined && placement.group !== options.group) continue;
        result.push({ ...resolved, placement });
      }
    }
    return result.sort(comparePlacedCommands);
  }

  search(query: string, context: ContributionContext, limit = 20): PaletteMatch[] {
    const needle = normalizeSearchText(query);
    const paletteCommands = this.list("command-palette", context)
      .filter((entry, index, all) =>
        all.findIndex((candidate) => candidate.contribution.id === entry.contribution.id) === index)
      .map((entry) => {
        const fields = commandSearchFields(entry.contribution);
        const scored = fields
          .map((field) => ({ field, score: scoreMatch(field, needle) }))
          .sort((left, right) => right.score - left.score)[0]!;
        return { ...entry, score: scored.score, matchedText: scored.field };
      })
      .filter(({ score }) => score >= 0)
      .sort((left, right) => right.score - left.score || compareResolvedCommands(left, right));
    return paletteCommands.slice(0, Math.max(0, limit));
  }

  async execute<TResult = unknown>(
    id: string,
    context: ContributionContext,
    args?: unknown,
  ): Promise<TResult> {
    const resolved = this.availability(id, context);
    if (!resolved) throw new Error(`Unknown command contribution “${id}”.`);
    if (!resolved.enabled) {
      throw new ContributionUnavailableError(
        id,
        resolved.reason ?? "O comando não está disponível.",
        resolved.missingCapabilities,
      );
    }
    const result = await resolved.contribution.execute(context, args) as TResult;
    const event = Object.freeze({ commandId: id });
    for (const listener of [...this.executionListeners]) listener(event);
    return result;
  }

  async executePalette<TResult = unknown>(
    id: string,
    context: ContributionContext,
    args?: unknown,
  ): Promise<TResult> {
    const command = this.contributions.get(id);
    if (!command?.placements.some(({ surface }) => surface === "command-palette")) {
      throw new Error(`Command “${id}” is not contributed to the command palette.`);
    }
    return this.execute<TResult>(id, context, args);
  }

  async executeShortcut<TResult = unknown>(
    chord: string,
    context: ContributionContext,
  ): Promise<ShortcutExecution<TResult>> {
    const match = this.resolveShortcut(chord, context);
    if (!match) return { handled: false };
    if (!match.enabled) {
      return {
        handled: true,
        commandId: match.contribution.id,
        ...(match.reason ? { reason: match.reason } : {}),
      };
    }
    const result = await this.execute<TResult>(match.contribution.id, context);
    return { handled: true, commandId: match.contribution.id, result };
  }

  /** Resolve sincronamente para que o boundary DOM possa cancelar o default antes do primeiro await. */
  resolveShortcut(
    chord: string,
    context: ContributionContext,
  ): ResolvedShortcutCommand | undefined {
    const normalized = normalizeShortcut(chord);
    return this.list("shortcut", context, { includeDisabled: true })
      .filter((entry): entry is ResolvedShortcutCommand => entry.placement.surface === "shortcut")
      .find(({ placement }) => normalizeShortcut(placement.chord) === normalized);
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observa toda execução bem-sucedida, independentemente da superfície que a iniciou. */
  onDidExecute(listener: (event: CommandExecutionEvent) => void): () => void {
    this.executionListeners.add(listener);
    return () => this.executionListeners.delete(listener);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function normalizeEnablement(value: boolean | CommandEnablement | undefined): CommandEnablement {
  if (value === undefined || value === true) return { enabled: true };
  if (value === false) return { enabled: false, reason: "O comando não está disponível no estado atual." };
  return value;
}

function assertCommand(command: CommandContribution): void {
  if (!command.id.trim()) throw new Error("Command id must not be empty.");
  if (!command.label.trim()) throw new Error(`Command “${command.id}” must have a label.`);
  if (command.placements.length === 0) {
    throw new Error(`Command “${command.id}” must contribute to at least one surface.`);
  }
  for (const placement of command.placements) {
    if (placement.surface === "shortcut" && !placement.chord.trim()) {
      throw new Error(`Shortcut for command “${command.id}” must not be empty.`);
    }
  }
}

function comparePlacedCommands(left: PlacedCommand, right: PlacedCommand): number {
  return (left.placement.order ?? 0) - (right.placement.order ?? 0)
    || left.contribution.label.localeCompare(right.contribution.label, "pt-BR")
    || left.contribution.id.localeCompare(right.contribution.id);
}

function compareResolvedCommands(left: ResolvedCommand, right: ResolvedCommand): number {
  return left.contribution.label.localeCompare(right.contribution.label, "pt-BR")
    || left.contribution.id.localeCompare(right.contribution.id);
}

function commandSearchFields(command: CommandContribution): string[] {
  return [
    command.label,
    command.category ?? "",
    command.description ?? "",
    ...(command.keywords ?? []),
    command.id,
  ].map(normalizeSearchText);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
}

function scoreMatch(field: string, needle: string): number {
  if (!needle) return 0;
  if (field === needle) return 100;
  if (field.startsWith(needle)) return 80 - Math.min(field.length - needle.length, 20);
  const index = field.indexOf(needle);
  if (index >= 0) return 50 - Math.min(index, 20);
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => field.includes(token))) return 20;
  return -1;
}

const MODIFIER_ORDER = ["CtrlOrMeta", "Ctrl", "Meta", "Alt", "Shift"] as const;

/** Normaliza chord textual; não depende de DOM, plataforma ou KeyboardEvent. */
export function normalizeShortcut(chord: string): string {
  const aliases: Readonly<Record<string, string>> = {
    cmdorctrl: "CtrlOrMeta",
    ctrlormeta: "CtrlOrMeta",
    commandorcontrol: "CtrlOrMeta",
    control: "Ctrl",
    ctrl: "Ctrl",
    command: "Meta",
    cmd: "Meta",
    meta: "Meta",
    option: "Alt",
    alt: "Alt",
    shift: "Shift",
    esc: "Escape",
    space: "Space",
  };
  const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
  const modifiers = new Set<string>();
  let key = "";
  for (const rawPart of parts) {
    const canonical = aliases[rawPart.toLocaleLowerCase("en-US")];
    if (canonical && MODIFIER_ORDER.includes(canonical as (typeof MODIFIER_ORDER)[number])) {
      modifiers.add(canonical);
    } else {
      key = canonical ?? (rawPart.length === 1 ? rawPart.toLocaleUpperCase("en-US") : rawPart);
    }
  }
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key]
    .filter(Boolean)
    .join("+");
}
