/**
 * Supervisor do ecossistema (ALPHA-0.1, P0.1): o Electron é quem inicia,
 * observa e encerra middleware e runtime — o usuário abre UM executável.
 *
 *   Editor ├─ inicia/descobre Middleware ├─ inicia/descobre Runtime
 *          ├─ health por serviço          └─ encerramento coordenado
 *
 * O launcher é INJETÁVEL: os testes dirigem a máquina de estados com
 * processos falsos (sem spawn real), e o main de produção injeta
 * child_process. Estados por serviço são compreensíveis e alimentam a tela
 * de inicialização ("Iniciando serviços…", "Conectando ao MonoGame…").
 */

export type ServiceState =
  | "stopped"
  | "starting"
  | "running"
  | "retrying" // caiu; aguardando backoff para nova tentativa
  | "failed"; // esgotou as tentativas — requer ação do usuário

export interface ManagedProcess {
  /** Resolve quando o processo TERMINA (código de saída ou erro). */
  readonly exited: Promise<{ code: number | null; error?: string }>;
  kill(): void;
}

export interface ServiceSpec {
  readonly id: string;
  /** Nome humano para a UI ("Middleware P7M", "MonoGame Runtime"). */
  readonly displayName: string;
  /** Sinal de prontidão: resolve true quando o serviço responde (health check). */
  readonly waitReady: () => Promise<boolean>;
  /** Dispara o processo. */
  readonly launch: () => ManagedProcess;
  /** Tentativas antes de "failed". Default 3. */
  readonly maxAttempts?: number;
  /** true: a aplicação segue utilizável sem este serviço (modo degradado). */
  readonly optional?: boolean;
}

export interface ServiceStatus {
  readonly id: string;
  readonly displayName: string;
  readonly state: ServiceState;
  readonly attempts: number;
  /** Razão legível do estado corrente (falha, backoff...). */
  readonly detail?: string;
}

export interface SupervisorEvent {
  readonly service: ServiceStatus;
}

/** Backoff exponencial: 500ms, 1s, 2s... limitado a 8s. */
export function backoffDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8_000);
}

export class ProcessSupervisor {
  private readonly statuses = new Map<string, ServiceStatus>();
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly listeners = new Set<(event: SupervisorEvent) => void>();
  private shuttingDown = false;

  constructor(
    private readonly services: readonly ServiceSpec[],
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    for (const spec of services) {
      this.statuses.set(spec.id, {
        id: spec.id,
        displayName: spec.displayName,
        state: "stopped",
        attempts: 0,
      });
    }
  }

  onEvent(listener: (event: SupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(id: string): ServiceStatus {
    const status = this.statuses.get(id);
    if (!status) throw new Error(`Unknown service "${id}"`);
    return status;
  }

  get all(): readonly ServiceStatus[] {
    return [...this.statuses.values()];
  }

  /** true quando todos os serviços obrigatórios estão rodando. */
  get isHealthy(): boolean {
    return this.services
      .filter((s) => !s.optional)
      .every((s) => this.statuses.get(s.id)!.state === "running");
  }

  /**
   * Sobe os serviços EM ORDEM (middleware antes do runtime). Serviço
   * obrigatório que falha interrompe; opcional que falha vira modo degradado.
   * Retorna true se o ecossistema obrigatório está de pé.
   */
  async startAll(): Promise<boolean> {
    for (const spec of this.services) {
      const ok = await this.startService(spec);
      if (!ok && !spec.optional) return false;
    }
    return true;
  }

  /** Reinicia um serviço isoladamente (ex.: runtime caiu; projeto preservado). */
  async restart(id: string): Promise<boolean> {
    const spec = this.services.find((s) => s.id === id);
    if (!spec) throw new Error(`Unknown service "${id}"`);
    this.processes.get(id)?.kill();
    this.processes.delete(id);
    this.update(id, { state: "stopped", attempts: 0 });
    return this.startService(spec);
  }

  /** Encerramento coordenado, na ordem INVERSA da subida. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const spec of [...this.services].reverse()) {
      const managed = this.processes.get(spec.id);
      if (managed) {
        managed.kill();
        await managed.exited.catch(() => undefined);
        this.processes.delete(spec.id);
      }
      this.update(spec.id, { state: "stopped" });
    }
  }

  private async startService(spec: ServiceSpec): Promise<boolean> {
    const maxAttempts = spec.maxAttempts ?? 3;

    for (let attempt = 1; attempt <= maxAttempts && !this.shuttingDown; attempt++) {
      this.update(spec.id, {
        state: "starting",
        attempts: attempt,
        detail: attempt > 1 ? `tentativa ${attempt} de ${maxAttempts}` : undefined,
      });

      const managed = spec.launch();
      this.processes.set(spec.id, managed);

      // corrida: prontidão × término prematuro
      const ready = await Promise.race([
        spec.waitReady(),
        managed.exited.then(() => false),
      ]);

      if (ready) {
        this.update(spec.id, { state: "running", detail: undefined });
        // vigia: se cair depois de pronto, reinicia sozinho
        void managed.exited.then((exit) => {
          if (this.shuttingDown || this.processes.get(spec.id) !== managed) return;
          this.processes.delete(spec.id);
          this.update(spec.id, {
            state: "retrying",
            detail: `processo terminou (código ${exit.code ?? "?"}) — reiniciando`,
          });
          void this.startService(spec);
        });
        return true;
      }

      const exit = await managed.exited.catch(() => ({ code: null, error: "unknown" }));
      this.processes.delete(spec.id);
      if (attempt < maxAttempts) {
        const delay = backoffDelayMs(attempt);
        this.update(spec.id, {
          state: "retrying",
          detail: `saiu com código ${exit.code ?? "?"}${exit.error ? ` (${exit.error})` : ""}; nova tentativa em ${delay}ms`,
        });
        await this.sleep(delay);
      } else {
        this.update(spec.id, {
          state: "failed",
          detail:
            `${spec.displayName} não iniciou após ${maxAttempts} tentativas` +
            `${exit.error ? `: ${exit.error}` : ""}`,
        });
      }
    }

    return false;
  }

  private update(
    id: string,
    changes: { state?: ServiceState; attempts?: number; detail?: string | undefined },
  ): void {
    const current = this.statuses.get(id)!;
    const detail = "detail" in changes ? changes.detail : current.detail;
    const next: ServiceStatus = {
      id: current.id,
      displayName: current.displayName,
      state: changes.state ?? current.state,
      attempts: changes.attempts ?? current.attempts,
      ...(detail !== undefined ? { detail } : {}),
    };
    this.statuses.set(id, next);
    for (const listener of this.listeners) listener({ service: next });
  }
}
