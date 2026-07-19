/**
 * Ciclo de vida do projeto (ALPHA-0.1, P0.2).
 *
 * O editor começa pelo PROJETO, não pela conexão a um pipe. Esta máquina de
 * estados explícita governa `sem projeto → aberto → modificado → salvando →
 * fechado`, com dirty tracking por eventos do Blueprint, política de
 * autosave e lista de recentes — tudo puro e injetável (relógio e
 * persistência de recentes entram por parâmetro), testável sem Electron.
 *
 * A escrita em disco e os diálogos nativos vivem no processo main; aqui vive
 * a VERDADE sobre o estado do documento. Abertura e substituição são
 * transações: enquanto o middleware prepara a nova sessão, o descritor e o
 * dirty state anteriores ficam preservados para rollback local.
 */

export type ProjectState =
  | "no-project" // shell aberta, nada carregado
  | "opening" // replay/criação em andamento
  | "open-clean" // projeto aberto, sem alterações não salvas
  | "open-dirty" // alterações não salvas
  | "saving" // save em andamento
  | "closing"; // aguardando confirmação/descarte

export interface ProjectDescriptor {
  /** Caminho do arquivo .p7m (ou undefined para projeto novo não salvo). */
  readonly filePath?: string;
  readonly name: string;
  /** Identidade imutável da sessão ativa no middleware. */
  readonly projectSessionId?: string;
  readonly projectId?: string;
  /** Sidecar que originou uma cópia/restauração; removido só após Save confirmado. */
  readonly recoverySourceFilePath?: string;
}

export interface RecentProject {
  readonly filePath: string;
  readonly name: string;
  readonly lastOpenedUnixMs: number;
}

export interface AutosavePolicy {
  /** Intervalo mínimo entre autosaves. Default 30 s. */
  readonly intervalMs?: number;
  /** Quantos comandos sujos disparam autosave imediato. Default 20. */
  readonly dirtyCommandThreshold?: number;
}

export interface LifecycleEvent {
  readonly kind:
    | "stateChanged"
    | "dirtyChanged"
    | "autosaveDue"
    | "recentsChanged";
  readonly state: ProjectState;
}

export class ProjectLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectLifecycleError";
  }
}

const MAX_RECENTS = 10;

export class ProjectLifecycle {
  private state: ProjectState = "no-project";
  private descriptor: ProjectDescriptor | undefined;
  private dirty = false;
  private dirtyCommands = 0;
  private observedCommandSequence = 0n;
  private persistedCommandSequence = 0n;
  private autosavedCommandSequence = 0n;
  private savingFromState: "open-clean" | "open-dirty" | undefined;
  private closingFromState: "open-clean" | "open-dirty" | undefined;
  private lastSaveAtMs: number;
  private pendingOpen:
    | {
        readonly previousState: "no-project" | "open-clean" | "open-dirty";
        readonly descriptor?: ProjectDescriptor;
        readonly dirty: boolean;
        readonly dirtyCommands: number;
        readonly observedCommandSequence: bigint;
        readonly persistedCommandSequence: bigint;
        readonly autosavedCommandSequence: bigint;
        readonly lastSaveAtMs: number;
      }
    | undefined;
  private recents: RecentProject[] = [];
  private readonly listeners = new Set<(event: LifecycleEvent) => void>();
  private readonly intervalMs: number;
  private readonly dirtyThreshold: number;

  constructor(
    private readonly now: () => number = Date.now,
    policy: AutosavePolicy = {},
    initialRecents: readonly RecentProject[] = [],
  ) {
    this.intervalMs = policy.intervalMs ?? 30_000;
    this.dirtyThreshold = policy.dirtyCommandThreshold ?? 20;
    this.recents = initialRecents.filter(isRecentProject).slice(0, MAX_RECENTS);
    this.lastSaveAtMs = this.now();
  }

  // ---- projeções ----

  get currentState(): ProjectState {
    return this.state;
  }

  get isDirty(): boolean {
    return this.state === "opening" ? (this.pendingOpen?.dirty ?? false) : this.dirty;
  }

  get project(): ProjectDescriptor | undefined {
    return this.descriptor;
  }

  /** Watermark da revisão canônica já observada (diagnóstico/recovery). */
  get commandSequence(): string {
    return this.observedCommandSequence.toString();
  }

  /** Título de janela pronto: "nome — P7M" com marcador de sujo. */
  get windowTitle(): string {
    if (!this.descriptor) return "P7M";
    return `${this.isDirty ? "● " : ""}${this.descriptor.name} — P7M`;
  }

  get recentProjects(): readonly RecentProject[] {
    return this.recents;
  }

  onEvent(listener: (event: LifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- transições ----

  /**
   * Início de New/Open. Pode substituir um projeto aberto: o estado anterior
   * fica guardado até `opened` confirmar a troca atômica ou `openFailed`
   * restaurá-lo sem alterar dirty state, recents ou descritor.
   */
  beginOpen(): void {
    if (
      this.state !== "no-project" &&
      this.state !== "open-clean" &&
      this.state !== "open-dirty"
    ) {
      throw new ProjectLifecycleError(
        `Cannot open a project while state is "${this.state}"`,
      );
    }
    this.pendingOpen = {
      previousState: this.state,
      ...(this.descriptor ? { descriptor: this.descriptor } : {}),
      dirty: this.dirty,
      dirtyCommands: this.dirtyCommands,
      observedCommandSequence: this.observedCommandSequence,
      persistedCommandSequence: this.persistedCommandSequence,
      autosavedCommandSequence: this.autosavedCommandSequence,
      lastSaveAtMs: this.lastSaveAtMs,
    };
    this.transition("opening");
  }

  /** Replay/criação concluído com sucesso. */
  opened(
    descriptor: ProjectDescriptor,
    options: { readonly dirty?: boolean; readonly commandSequence?: string } = {},
  ): void {
    this.assertState("opening", "opened");
    const commandSequence = parseCommandSequence(options.commandSequence ?? "0");
    this.descriptor = descriptor;
    this.dirty = options.dirty ?? false;
    this.dirtyCommands = options.dirty ? 1 : 0;
    this.observedCommandSequence = commandSequence;
    this.persistedCommandSequence = commandSequence;
    this.autosavedCommandSequence = commandSequence;
    this.lastSaveAtMs = this.now();
    this.pendingOpen = undefined;
    if (descriptor.filePath) this.touchRecent(descriptor.filePath, descriptor.name);
    this.transition(options.dirty ? "open-dirty" : "open-clean");
    if (options.dirty) this.emit({ kind: "dirtyChanged", state: this.state });
  }

  /** Abertura falhou: restaura exatamente a sessão local anterior. */
  openFailed(): void {
    this.assertState("opening", "openFailed");
    const previous = this.pendingOpen;
    if (!previous) {
      throw new ProjectLifecycleError("openFailed requires a pending open transaction");
    }
    this.descriptor = previous.descriptor;
    this.dirty = previous.dirty;
    this.dirtyCommands = previous.dirtyCommands;
    this.observedCommandSequence = previous.observedCommandSequence;
    this.persistedCommandSequence = previous.persistedCommandSequence;
    this.autosavedCommandSequence = previous.autosavedCommandSequence;
    this.lastSaveAtMs = previous.lastSaveAtMs;
    this.pendingOpen = undefined;
    this.transition(previous.previousState);
  }

  /**
   * Um evento de Blueprint chegou (broadcast do gateway). Retorna true se um
   * autosave ficou devido (limiar de comandos sujos atingido).
   */
  commandApplied(commandSequence?: string): boolean {
    if (!this.descriptor || this.state === "opening" || this.state === "no-project") {
      return false; // eventos de replay durante opening não sujam o documento
    }
    const nextSequence = commandSequence === undefined
      ? this.observedCommandSequence + 1n
      : parseCommandSequence(commandSequence);
    if (nextSequence <= this.observedCommandSequence) return false;
    const newlyObserved = sequenceDistance(nextSequence, this.observedCommandSequence);
    this.observedCommandSequence = nextSequence;
    const wasDirty = this.dirty;
    this.dirty = true;
    this.dirtyCommands = Math.min(Number.MAX_SAFE_INTEGER, this.dirtyCommands + newlyObserved);
    if (this.state === "open-clean") {
      this.transition("open-dirty");
    }
    if (!wasDirty) this.emit({ kind: "dirtyChanged", state: this.state });
    if (this.dirtyCommands >= this.dirtyThreshold) {
      this.emit({ kind: "autosaveDue", state: this.state });
      return true;
    }
    return false;
  }

  /** Tick periódico (timer do main). Retorna true se autosave ficou devido. */
  autosaveTick(): boolean {
    if (this.state !== "open-dirty") return false;
    if (this.now() - this.lastSaveAtMs < this.intervalMs) return false;
    this.emit({ kind: "autosaveDue", state: this.state });
    return true;
  }

  /** Início de Save/Save As. */
  beginSave(): void {
    if (this.state !== "open-dirty" && this.state !== "open-clean") {
      throw new ProjectLifecycleError(`Cannot save while state is "${this.state}"`);
    }
    this.savingFromState = this.state;
    this.transition("saving");
  }

  /** Save concluído. `filePath` atualiza o descritor num Save As. */
  saved(filePath?: string, throughCommandSequence?: string): void {
    this.assertState("saving", "saved");
    const through = throughCommandSequence === undefined
      ? this.observedCommandSequence
      : parseCommandSequence(throughCommandSequence);
    if (through < this.persistedCommandSequence) {
      throw new ProjectLifecycleError("Save snapshot commandSequence moved backwards");
    }
    if (through > this.observedCommandSequence) this.observedCommandSequence = through;
    this.persistedCommandSequence = through;
    if (filePath && this.descriptor) {
      this.descriptor = { ...this.descriptor, filePath };
      this.touchRecent(filePath, this.descriptor.name);
    }
    this.dirty = this.observedCommandSequence > through;
    this.dirtyCommands = this.dirty
      ? sequenceDistance(this.observedCommandSequence, through)
      : 0;
    this.savingFromState = undefined;
    this.lastSaveAtMs = this.now();
    this.transition(this.dirty ? "open-dirty" : "open-clean");
    this.emit({ kind: "dirtyChanged", state: this.state });
  }

  /** Save falhou: o documento volta a sujo (nada foi perdido). */
  saveFailed(): void {
    this.assertState("saving", "saveFailed");
    this.savingFromState = undefined;
    this.transition(this.dirty ? "open-dirty" : "open-clean");
  }

  /** Autosave confirmado: continua dirty, mas reinicia intervalo/limiar. */
  autosaveCompleted(throughCommandSequence?: string): void {
    if (this.state !== "open-dirty") return;
    const through = throughCommandSequence === undefined
      ? this.observedCommandSequence
      : parseCommandSequence(throughCommandSequence);
    if (through > this.observedCommandSequence) this.observedCommandSequence = through;
    this.autosavedCommandSequence = through;
    this.lastSaveAtMs = this.now();
    this.dirtyCommands = sequenceDistance(this.observedCommandSequence, through);
  }

  /**
   * Um middleware reiniciado cria outra identidade de sessão. Rebind troca
   * somente IDs/watermark e preserva caminho, recovery e dirty state locais.
   */
  rebindSession(
    identity: { readonly projectSessionId: string; readonly projectId: string },
    commandSequence: string,
  ): void {
    if (!this.descriptor || (this.state !== "open-clean" && this.state !== "open-dirty")) {
      throw new ProjectLifecycleError(`Cannot rebind project while state is "${this.state}"`);
    }
    const sequence = parseCommandSequence(commandSequence);
    this.descriptor = { ...this.descriptor, ...identity };
    this.observedCommandSequence = sequence;
    this.persistedCommandSequence = sequence;
    this.autosavedCommandSequence = sequence;
    this.dirtyCommands = this.dirty ? 1 : 0;
    this.emit({ kind: "stateChanged", state: this.state });
  }

  removeRecent(filePath: string): boolean {
    const next = this.recents.filter((recent) => recent.filePath !== filePath);
    if (next.length === this.recents.length) return false;
    this.recents = next;
    this.emit({ kind: "recentsChanged", state: this.state });
    return true;
  }

  /**
   * Pedido de fechar (ou trocar de projeto). Retorna a decisão que a UI deve
   * tomar: fechar direto, ou perguntar (documento sujo).
   */
  requestClose(): "close" | "confirm-discard" {
    if (this.state === "no-project") return "close";
    if (this.state !== "open-clean" && this.state !== "open-dirty") {
      throw new ProjectLifecycleError(`Cannot close while state is "${this.state}"`);
    }
    const decision = this.dirty ? "confirm-discard" : "close";
    this.closingFromState = this.state;
    this.transition("closing");
    return decision;
  }

  /** Usuário confirmou descartar (ou o save prévio completou). */
  confirmClose(): void {
    this.assertState("closing", "confirmClose");
    this.finishClose();
  }

  /** Usuário cancelou o fechamento. */
  cancelClose(): void {
    this.assertState("closing", "cancelClose");
    const previous = this.closingFromState ?? (this.dirty ? "open-dirty" : "open-clean");
    this.closingFromState = undefined;
    this.transition(this.dirty ? "open-dirty" : previous);
  }

  // ---- internos ----

  private finishClose(): void {
    this.descriptor = undefined;
    this.dirty = false;
    this.dirtyCommands = 0;
    this.observedCommandSequence = 0n;
    this.persistedCommandSequence = 0n;
    this.autosavedCommandSequence = 0n;
    this.pendingOpen = undefined;
    this.savingFromState = undefined;
    this.closingFromState = undefined;
    this.transition("no-project");
  }

  private touchRecent(filePath: string, name: string): void {
    this.recents = [
      { filePath, name, lastOpenedUnixMs: this.now() },
      ...this.recents.filter((r) => r.filePath !== filePath),
    ].slice(0, MAX_RECENTS);
    this.emit({ kind: "recentsChanged", state: this.state });
  }

  private assertState(expected: ProjectState, action: string): void {
    if (this.state !== expected) {
      throw new ProjectLifecycleError(
        `"${action}" requires state "${expected}" (current: "${this.state}")`,
      );
    }
  }

  private transition(next: ProjectState): void {
    this.state = next;
    this.emit({ kind: "stateChanged", state: next });
  }

  private emit(event: LifecycleEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function parseCommandSequence(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new ProjectLifecycleError(`Invalid commandSequence "${value}"`);
  }
  return BigInt(value);
}

function sequenceDistance(high: bigint, low: bigint): number {
  if (high <= low) return 0;
  const distance = high - low;
  return distance > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(distance);
}

function isRecentProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== "object") return false;
  const recent = value as Record<string, unknown>;
  return (
    typeof recent["filePath"] === "string" &&
    recent["filePath"].length > 0 &&
    typeof recent["name"] === "string" &&
    recent["name"].length > 0 &&
    typeof recent["lastOpenedUnixMs"] === "number" &&
    Number.isFinite(recent["lastOpenedUnixMs"])
  );
}
