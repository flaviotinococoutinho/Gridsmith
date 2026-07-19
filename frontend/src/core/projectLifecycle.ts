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
  private dirtyCommands = 0;
  private lastSaveAtMs: number;
  private pendingOpen:
    | {
        readonly previousState: "no-project" | "open-clean" | "open-dirty";
        readonly descriptor?: ProjectDescriptor;
        readonly dirtyCommands: number;
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
    this.recents = [...initialRecents];
    this.lastSaveAtMs = this.now();
  }

  // ---- projeções ----

  get currentState(): ProjectState {
    return this.state;
  }

  get isDirty(): boolean {
    return (
      this.state === "open-dirty" ||
      (this.state === "opening" && this.pendingOpen?.previousState === "open-dirty")
    );
  }

  get project(): ProjectDescriptor | undefined {
    return this.descriptor;
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
      dirtyCommands: this.dirtyCommands,
      lastSaveAtMs: this.lastSaveAtMs,
    };
    this.transition("opening");
  }

  /** Replay/criação concluído com sucesso. */
  opened(descriptor: ProjectDescriptor): void {
    this.assertState("opening", "opened");
    this.descriptor = descriptor;
    this.dirtyCommands = 0;
    this.lastSaveAtMs = this.now();
    this.pendingOpen = undefined;
    if (descriptor.filePath) this.touchRecent(descriptor.filePath, descriptor.name);
    this.transition("open-clean");
  }

  /** Abertura falhou: restaura exatamente a sessão local anterior. */
  openFailed(): void {
    this.assertState("opening", "openFailed");
    const previous = this.pendingOpen;
    if (!previous) {
      throw new ProjectLifecycleError("openFailed requires a pending open transaction");
    }
    this.descriptor = previous.descriptor;
    this.dirtyCommands = previous.dirtyCommands;
    this.lastSaveAtMs = previous.lastSaveAtMs;
    this.pendingOpen = undefined;
    this.transition(previous.previousState);
  }

  /**
   * Um evento de Blueprint chegou (broadcast do gateway). Retorna true se um
   * autosave ficou devido (limiar de comandos sujos atingido).
   */
  commandApplied(): boolean {
    if (this.state !== "open-clean" && this.state !== "open-dirty") {
      return false; // eventos de replay durante opening não sujam o documento
    }
    this.dirtyCommands++;
    if (this.state === "open-clean") {
      this.transition("open-dirty");
      this.emit({ kind: "dirtyChanged", state: this.state });
    }
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
    this.transition("saving");
  }

  /** Save concluído. `filePath` atualiza o descritor num Save As. */
  saved(filePath?: string): void {
    this.assertState("saving", "saved");
    if (filePath && this.descriptor) {
      this.descriptor = { ...this.descriptor, filePath };
      this.touchRecent(filePath, this.descriptor.name);
    }
    this.dirtyCommands = 0;
    this.lastSaveAtMs = this.now();
    this.transition("open-clean");
    this.emit({ kind: "dirtyChanged", state: this.state });
  }

  /** Save falhou: o documento volta a sujo (nada foi perdido). */
  saveFailed(): void {
    this.assertState("saving", "saveFailed");
    this.transition("open-dirty");
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
    const decision = this.state === "open-dirty" ? "confirm-discard" : "close";
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
    this.transition(this.dirtyCommands > 0 ? "open-dirty" : "open-clean");
  }

  // ---- internos ----

  private finishClose(): void {
    this.descriptor = undefined;
    this.dirtyCommands = 0;
    this.pendingOpen = undefined;
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
