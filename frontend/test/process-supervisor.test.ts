import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProcessSupervisor,
  backoffDelayMs,
  type ManagedProcess,
  type ServiceSpec,
} from "../src/main/ProcessSupervisor.js";

/** Processo falso controlável pelos testes. */
class FakeProcess implements ManagedProcess {
  killed = false;
  private resolveExit!: (v: { code: number | null; error?: string }) => void;
  readonly exited = new Promise<{ code: number | null; error?: string }>((resolve) => {
    this.resolveExit = resolve;
  });

  kill(): void {
    this.killed = true;
    this.resolveExit({ code: 0 });
  }

  crash(code: number, error?: string): void {
    this.resolveExit(error !== undefined ? { code, error } : { code });
  }
}

interface FakeService {
  spec: ServiceSpec;
  launches: FakeProcess[];
  setReady(ready: boolean): void;
}

function makeService(
  id: string,
  options: { optional?: boolean; maxAttempts?: number; readyFromLaunch?: number } = {},
): FakeService {
  const launches: FakeProcess[] = [];
  let ready = false;
  const readyFrom = options.readyFromLaunch ?? 1;
  return {
    launches,
    setReady: (value) => (ready = value),
    spec: {
      id,
      displayName: `Serviço ${id}`,
      launch: () => {
        const proc = new FakeProcess();
        launches.push(proc);
        if (launches.length >= readyFrom) ready = true;
        return proc;
      },
      waitReady: async () => {
        // simula health check assíncrono
        await Promise.resolve();
        if (!ready) return new Promise<boolean>(() => {}); // nunca responde: quem decide é o exit
        return true;
      },
      ...(options.optional !== undefined ? { optional: options.optional } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    },
  };
}

const instantSleep = async (): Promise<void> => {};

test("sobe serviços em ordem e reporta running", async () => {
  const middleware = makeService("middleware");
  const runtime = makeService("runtime");
  const supervisor = new ProcessSupervisor([middleware.spec, runtime.spec], instantSleep);

  const ok = await supervisor.startAll();
  assert.equal(ok, true);
  assert.equal(supervisor.isHealthy, true);
  assert.equal(supervisor.status("middleware").state, "running");
  assert.equal(supervisor.status("runtime").state, "running");
  // ordem: middleware lançado antes do runtime
  assert.equal(middleware.launches.length, 1);
  assert.equal(runtime.launches.length, 1);
});

test("retry com backoff: falha 2 vezes, sobe na terceira", async () => {
  const flaky = makeService("engine", { readyFromLaunch: 3, maxAttempts: 3 });
  const delays: number[] = [];
  const supervisor = new ProcessSupervisor([flaky.spec], async (ms) => {
    delays.push(ms);
  });

  const startPromise = supervisor.startAll();
  // as duas primeiras tentativas terminam sem ficar prontas
  await Promise.resolve();
  flaky.launches[0]!.crash(1, "porta ocupada");
  await new Promise((r) => setTimeout(r, 10));
  flaky.launches[1]!.crash(1);
  const ok = await startPromise;

  assert.equal(ok, true);
  assert.equal(flaky.launches.length, 3);
  assert.deepEqual(delays, [backoffDelayMs(1), backoffDelayMs(2)]); // 500, 1000
  assert.equal(supervisor.status("engine").state, "running");
  assert.equal(supervisor.status("engine").attempts, 3);
});

test("serviço obrigatório que esgota tentativas vira failed com causa legível", async () => {
  const broken = makeService("middleware", { readyFromLaunch: 99, maxAttempts: 2 });
  const supervisor = new ProcessSupervisor([broken.spec], instantSleep);

  const startPromise = supervisor.startAll();
  await Promise.resolve();
  broken.launches[0]!.crash(127, "comando não encontrado");
  await new Promise((r) => setTimeout(r, 10));
  broken.launches[1]!.crash(127, "comando não encontrado");
  const ok = await startPromise;

  assert.equal(ok, false);
  const status = supervisor.status("middleware");
  assert.equal(status.state, "failed");
  assert.match(status.detail ?? "", /não iniciou após 2 tentativas/);
  assert.match(status.detail ?? "", /comando não encontrado/);
  assert.equal(supervisor.isHealthy, false);
});

test("serviço OPCIONAL que falha vira modo degradado (startAll segue true)", async () => {
  const middleware = makeService("middleware");
  const engine = makeService("engine", { optional: true, readyFromLaunch: 99, maxAttempts: 1 });
  const supervisor = new ProcessSupervisor([middleware.spec, engine.spec], instantSleep);

  const startPromise = supervisor.startAll();
  await new Promise((r) => setTimeout(r, 10));
  engine.launches[0]?.crash(1, "SDL indisponível");
  const ok = await startPromise;

  assert.equal(ok, true); // aplicação utilizável sem engine
  assert.equal(supervisor.isHealthy, true); // saúde considera só os obrigatórios
  assert.equal(supervisor.status("engine").state, "failed");
});

test("queda pós-ready dispara reinício automático (vigia)", async () => {
  const engine = makeService("engine");
  const supervisor = new ProcessSupervisor([engine.spec], instantSleep);
  await supervisor.startAll();
  assert.equal(supervisor.status("engine").state, "running");

  const states: string[] = [];
  supervisor.onEvent((e) => states.push(e.service.state));

  engine.launches[0]!.crash(139, "segfault");
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(states.includes("retrying"), `expected retrying in ${states}`);
  assert.equal(supervisor.status("engine").state, "running"); // voltou sozinho
  assert.equal(engine.launches.length, 2);
});

test("shutdown encerra na ordem inversa e não religa nada", async () => {
  const middleware = makeService("middleware");
  const engine = makeService("engine");
  const supervisor = new ProcessSupervisor([middleware.spec, engine.spec], instantSleep);
  await supervisor.startAll();

  await supervisor.shutdown();

  assert.equal(middleware.launches[0]?.killed, true);
  assert.equal(engine.launches[0]?.killed, true);
  assert.equal(supervisor.status("middleware").state, "stopped");
  assert.equal(supervisor.status("engine").state, "stopped");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.launches.length, 1); // o vigia não religou após shutdown
});

test("restart isolado preserva os demais serviços", async () => {
  const middleware = makeService("middleware");
  const engine = makeService("engine");
  const supervisor = new ProcessSupervisor([middleware.spec, engine.spec], instantSleep);
  await supervisor.startAll();

  const ok = await supervisor.restart("engine");
  assert.equal(ok, true);
  assert.equal(engine.launches.length, 2);
  assert.equal(middleware.launches.length, 1); // middleware intocado
  assert.equal(supervisor.status("engine").state, "running");
});

test("waitReady=false encerra processo ainda vivo antes do retry e não trava", async () => {
  const launches: FakeProcess[] = [];
  let readinessCalls = 0;
  const spec: ServiceSpec = {
    id: "middleware",
    displayName: "Middleware",
    maxAttempts: 2,
    launch: () => {
      const proc = new FakeProcess();
      launches.push(proc);
      return proc;
    },
    waitReady: async () => ++readinessCalls >= 2,
  };
  const supervisor = new ProcessSupervisor([spec], instantSleep);

  assert.equal(await supervisor.startAll(), true);
  assert.equal(launches.length, 2);
  assert.equal(launches[0]?.killed, true);
  assert.equal(supervisor.status("middleware").state, "running");
});

test("restart aguarda saída antiga antes de abrir um novo processo", async () => {
  class SlowStopProcess implements ManagedProcess {
    killed = false;
    private resolveExit!: (value: { code: number | null }) => void;
    readonly exited = new Promise<{ code: number | null }>((resolve) => {
      this.resolveExit = resolve;
    });

    kill(): void {
      this.killed = true;
    }

    release(): void {
      this.resolveExit({ code: 0 });
    }
  }

  const launches: ManagedProcess[] = [];
  const first = new SlowStopProcess();
  const spec: ServiceSpec = {
    id: "middleware",
    displayName: "Middleware",
    launch: () => {
      const process = launches.length === 0 ? first : new FakeProcess();
      launches.push(process);
      return process;
    },
    waitReady: async () => true,
  };
  const supervisor = new ProcessSupervisor([spec], instantSleep, 1_000);
  await supervisor.startAll();

  const restarting = supervisor.restart("middleware");
  await Promise.resolve();
  assert.equal(first.killed, true);
  assert.equal(launches.length, 1, "novo bind deve esperar o processo anterior sair");
  first.release();

  assert.equal(await restarting, true);
  assert.equal(launches.length, 2);
});

test("processo que ignora terminação cancela restart para evitar colisão", async () => {
  const stuck: ManagedProcess = {
    exited: new Promise(() => {}),
    kill: () => undefined,
  };
  let launches = 0;
  const spec: ServiceSpec = {
    id: "middleware",
    displayName: "Middleware",
    launch: () => (++launches === 1 ? stuck : new FakeProcess()),
    waitReady: async () => true,
  };
  const supervisor = new ProcessSupervisor([spec], instantSleep, 10);
  await supervisor.startAll();

  assert.equal(await supervisor.restart("middleware"), false);
  assert.equal(launches, 1);
  assert.equal(supervisor.status("middleware").state, "failed");
  assert.match(supervisor.status("middleware").detail ?? "", /colisão de endpoint/);
});

test("readiness diferencia processo, GraphQL e gRPC sem bloquear fallback legítimo", async () => {
  const process = new FakeProcess();
  const spec: ServiceSpec = {
    id: "middleware",
    displayName: "Middleware",
    launch: () => process,
    waitReady: async () => ({
      ready: true,
      detail: "GraphQL ativo; gRPC indisponível; fallback habilitado",
      checks: { middleware: "active", graphql: "active", grpc: "inactive" },
    }),
  };
  const supervisor = new ProcessSupervisor([spec], instantSleep);

  assert.equal(await supervisor.startAll(), true);
  assert.deepEqual(supervisor.status("middleware").checks, {
    middleware: "active",
    graphql: "active",
    grpc: "inactive",
  });
  assert.match(supervisor.status("middleware").detail ?? "", /fallback/);
});

test("readiness de autenticação é não recuperável e não relança", async () => {
  const launches: FakeProcess[] = [];
  const spec: ServiceSpec = {
    id: "middleware",
    displayName: "Middleware",
    maxAttempts: 3,
    launch: () => {
      const process = new FakeProcess();
      launches.push(process);
      return process;
    },
    waitReady: async () => ({
      ready: false,
      retryable: false,
      detail: "falha de autenticação no gRPC",
      checks: { middleware: "active", graphql: "active", grpc: "authentication-failed" },
    }),
  };
  const supervisor = new ProcessSupervisor([spec], instantSleep);

  assert.equal(await supervisor.startAll(), false);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.killed, true);
  assert.equal(supervisor.status("middleware").state, "failed");
  assert.equal(supervisor.status("middleware").checks?.["grpc"], "authentication-failed");
});
