/** Seleções semânticas compartilhadas entre canvas, árvore, inspector e comandos. */

export type SelectionKind =
  | "project"
  | "level"
  | "cell"
  | "entity-definition"
  | "entity-instance"
  | "asset"
  | "camera"
  | "light"
  | "problem";

interface SelectionBase<K extends SelectionKind> {
  readonly kind: K;
  /** Escopo anti-stale: nenhuma seleção sobrevive à troca de ProjectSession. */
  readonly projectSessionId: string;
  readonly projectId: string;
}

export interface ProjectSelection extends SelectionBase<"project"> {
}

export interface LevelSelection extends SelectionBase<"level"> {
  readonly levelId: string;
}

export interface CellCoordinate {
  readonly x: number;
  readonly y: number;
  readonly index?: number;
}

export interface CellSelection extends SelectionBase<"cell"> {
  readonly levelId: string;
  readonly cells: readonly CellCoordinate[];
  readonly anchor?: CellCoordinate;
}

export interface EntityDefinitionSelection extends SelectionBase<"entity-definition"> {
  readonly definitionId: string;
}

export interface EntityInstanceSelection extends SelectionBase<"entity-instance"> {
  readonly entityId: string;
  readonly levelId?: string;
}

export interface AssetSelection extends SelectionBase<"asset"> {
  readonly assetId: string;
  readonly assetType?: string;
}

export interface CameraSelection extends SelectionBase<"camera"> {
  readonly cameraId: string;
  readonly levelId?: string;
}

export interface LightSelection extends SelectionBase<"light"> {
  readonly lightId: string;
  readonly levelId?: string;
}

export interface ProblemSelection extends SelectionBase<"problem"> {
  readonly problemId: string;
  readonly severity?: "info" | "warning" | "error";
  readonly subjectKind?: SelectionKind;
  readonly subjectId?: string;
}

export type Selection =
  | ProjectSelection
  | LevelSelection
  | CellSelection
  | EntityDefinitionSelection
  | EntityInstanceSelection
  | AssetSelection
  | CameraSelection
  | LightSelection
  | ProblemSelection;

export interface SelectionChange {
  readonly previous?: Selection;
  readonly current?: Selection;
  readonly previousSelections: readonly Selection[];
  readonly selections: readonly Selection[];
  readonly projectSessionId?: string;
  /** Origem semântica para diagnóstico e prevenção de ciclos na integração. */
  readonly source: string;
}

export type SelectionListener = (change: SelectionChange) => void;
export type SelectionMatchPolicy = "primary" | "all" | "any";

function sameSelection(left: Selection | undefined, right: Selection | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  // Seleções são objetos pequenos e declarativos. A comparação estrutural evita
  // repinturas quando canvas e árvore publicam a mesma identidade semântica.
  return JSON.stringify(left) === JSON.stringify(right);
}

export class SelectionService {
  private activeSessionId: string | undefined;
  private activeProjectId: string | undefined;
  private values: readonly Selection[] = [];
  private readonly listeners = new Set<SelectionListener>();

  constructor(projectSessionId?: string) {
    this.activeSessionId = projectSessionId;
  }

  get current(): Selection | undefined {
    return this.values[0];
  }

  get primary(): Selection | undefined {
    return this.current;
  }

  get selections(): readonly Selection[] {
    return this.values;
  }

  get projectSessionId(): string | undefined {
    return this.activeSessionId;
  }

  get projectId(): string | undefined {
    return this.activeProjectId;
  }

  get kind(): SelectionKind | undefined {
    return this.current?.kind;
  }

  is<K extends SelectionKind>(kind: K): this is SelectionService & {
    readonly current: Extract<Selection, { readonly kind: K }>;
  } {
    return this.current?.kind === kind;
  }

  select(selection: Selection, source = "unknown"): boolean {
    return this.selectMany([selection], 0, source);
  }

  /**
   * Publica seleção múltipla com um item primário. Todos os itens precisam
   * pertencer à sessão/projeto ativos; eventos atrasados retornam false.
   */
  selectMany(
    selections: readonly Selection[],
    primaryIndex = 0,
    source = "unknown",
  ): boolean {
    if (selections.length === 0) return this.clear(source);
    if (!this.activeSessionId) return false;
    if (!Number.isInteger(primaryIndex) || primaryIndex < 0 || primaryIndex >= selections.length) {
      throw new RangeError("Selection primaryIndex is out of range.");
    }
    const projectId = selections[0]!.projectId;
    if (this.activeProjectId && this.activeProjectId !== projectId) return false;
    if (selections.some((selection) =>
      selection.projectSessionId !== this.activeSessionId || selection.projectId !== projectId)) {
      return false;
    }
    const primary = selections[primaryIndex]!;
    const ordered = [primary];
    for (let index = 0; index < selections.length; index++) {
      if (index === primaryIndex) continue;
      const selection = selections[index]!;
      if (!ordered.some((candidate) => sameSelection(candidate, selection))) ordered.push(selection);
    }
    if (sameSelectionSet(this.values, ordered)) return false;
    const previousSelections = this.values;
    const previous = previousSelections[0];
    this.activeProjectId = projectId;
    this.values = ordered;
    this.notify({
      ...(previous ? { previous } : {}),
      current: primary,
      previousSelections,
      selections: ordered,
      projectSessionId: this.activeSessionId,
      source,
    });
    return true;
  }

  clear(source = "unknown"): boolean {
    if (this.values.length === 0) return false;
    const previousSelections = this.values;
    const previous = previousSelections[0]!;
    this.values = [];
    this.notify({
      previous,
      previousSelections,
      selections: [],
      ...(this.activeSessionId ? { projectSessionId: this.activeSessionId } : {}),
      source,
    });
    return true;
  }

  /**
   * Troca o escopo antes de aceitar eventos do novo projeto e limpa o conjunto
   * atomicamente. Um evento atrasado da sessão anterior não consegue repovoá-lo.
   */
  switchSession(projectSessionId: string | undefined, source = "session-switch"): boolean {
    if (this.activeSessionId === projectSessionId) return false;
    const previousSelections = this.values;
    const previous = previousSelections[0];
    this.activeSessionId = projectSessionId;
    this.activeProjectId = undefined;
    this.values = [];
    this.notify({
      ...(previous ? { previous } : {}),
      previousSelections,
      selections: [],
      ...(projectSessionId ? { projectSessionId } : {}),
      source,
    });
    return true;
  }

  subscribe(listener: SelectionListener, emitCurrent = false): () => void {
    this.listeners.add(listener);
    if (emitCurrent) {
      listener({
        ...(this.current ? { current: this.current } : {}),
        previousSelections: [],
        selections: this.values,
        ...(this.activeSessionId ? { projectSessionId: this.activeSessionId } : {}),
        source: "subscribe",
      });
    }
    return () => this.listeners.delete(listener);
  }

  private notify(change: SelectionChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}

function sameSelectionSet(left: readonly Selection[], right: readonly Selection[]): boolean {
  return left.length === right.length && left.every((selection, index) => sameSelection(selection, right[index]));
}

export function supportsSelection(
  supportedSelections: readonly SelectionKind[] | undefined,
  selection: Selection | undefined,
): boolean {
  if (!supportedSelections || supportedSelections.length === 0) return true;
  return selection !== undefined && supportedSelections.includes(selection.kind);
}

export function supportsSelections(
  supportedSelections: readonly SelectionKind[] | undefined,
  selections: readonly Selection[],
  policy: SelectionMatchPolicy = "all",
): boolean {
  if (!supportedSelections || supportedSelections.length === 0) return true;
  if (selections.length === 0) return false;
  if (policy === "primary") return supportedSelections.includes(selections[0]!.kind);
  if (policy === "any") return selections.some(({ kind }) => supportedSelections.includes(kind));
  return selections.every(({ kind }) => supportedSelections.includes(kind));
}

/**
 * Identidade estável do alvo editável. Campos contextuais (índice derivado,
 * anchor, levelId opcional) não podem criar uma segunda falha pendente para o
 * mesmo objeto canônico.
 */
export function semanticSelectionSetIdentityKey(
  selections: readonly Selection[],
): string {
  const atomicIdentities: string[] = [];
  for (const selection of selections) {
    const scope = [selection.projectSessionId, selection.projectId, selection.kind];
    if (selection.kind === "cell") {
      for (const cell of selection.cells) {
        atomicIdentities.push(JSON.stringify([...scope, selection.levelId, cell.x, cell.y]));
      }
      continue;
    }
    const id = selection.kind === "project" ? selection.projectId
      : selection.kind === "level" ? selection.levelId
        : selection.kind === "entity-definition" ? selection.definitionId
          : selection.kind === "entity-instance" ? selection.entityId
            : selection.kind === "asset" ? selection.assetId
              : selection.kind === "camera" ? selection.cameraId
                : selection.kind === "light" ? selection.lightId
                  : selection.problemId;
    atomicIdentities.push(JSON.stringify([...scope, id]));
  }
  return JSON.stringify([...new Set(atomicIdentities)].sort());
}
