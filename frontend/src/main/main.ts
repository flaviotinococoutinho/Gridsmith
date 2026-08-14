/**
 * Processo main do editor Electron.
 *
 * Papel: shell fina + dono do CICLO DE VIDA DO PROJETO (ALPHA-0.1 P0.2) e da
 * SUPERVISÃO DE PROCESSOS (P0.1) — o usuário abre UM executável: o main sobe
 * middleware e engine com retry/backoff, captura stdout/stderr por serviço e
 * segue utilizável em modo degradado se a engine cair. NENHUMA lógica de
 * domínio vive aqui: comandos são despachados pelo caminho canônico do
 * middleware (EditorClient) e a verdade do documento vive na ProjectLifecycle.
 *
 * Uso: npm run app -- [--pipe <nome>] [--external-services]
 *   --external-services: NÃO spawna middleware/engine (dev: serviços já
 *   rodando em terminais próprios; é o modo dos scripts verify-*).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain } from "electron";
import {
  EDITOR_AUTH_TOKEN_ENV,
  EDITOR_AUTH_TOKEN_FILE_ENV,
  generateTransportAuthToken,
  loadTransportAuthToken,
} from "@gridsmith/middleware/dist/transport/auth.js";
import {
  ProjectLifecycle,
  parseRecents,
  type ProjectDescriptor,
  type RecentProject,
} from "../core/projectLifecycle.js";
import {
  buildNewProjectPrompt,
  resolveNewProjectChoice,
  type ProjectTemplateOption,
} from "../core/newProjectChoice.js";
import {
  ProcessSupervisor,
  type ManagedProcess,
  type ServiceReadiness,
  type ServiceStatus,
} from "./ProcessSupervisor.js";
import { EditorClient, type ProjectStatus } from "./EditorClient.js";
import { ProjectFileService } from "./project/ProjectFileService.js";
import {
  planRecovery,
  planWithoutRecovery,
  type RecoveryDecision,
} from "../core/recoveryPlan.js";
import { NodeProjectFileSystem } from "./project/NodeProjectFileSystem.js";
import { projectPathFromArgs } from "./project/ProjectLaunchRouting.js";
import {
  ensureSingleInstance,
  hardenNavigation,
  hardenedWindowOptions,
  loadWindowState,
  trackWindowState,
} from "./appConfig.js";
import {
  PROJECT_EXTENSIONS,
  defaultProjectFileName,
  projectNameFromPath,
} from "../core/projectExtensions.js";

// Nome do app EXPLÍCITO, e não derivado do `name` do package.json: é ele que
// define `app.getPath("userData")`, onde moram os recentes e o estado da
// janela. Amarrado ao pacote npm, um rename de escopo (@p7m → @gridsmith)
// movia o diretório em silêncio e órfãva os dois.
app.setName("Gridsmith");

const dirname = path.dirname(fileURLToPath(import.meta.url));
// o filtro carrega TAMBÉM o sufixo herdado: com uma extensão só, todo projeto
// `.p7m.json` já gravado ficaria inselecionável no diálogo Abrir — não há
// entrada "Todos os arquivos" para escapar
const PROJECT_FILTER = [{ name: "Projeto Gridsmith", extensions: [...PROJECT_EXTENSIONS] }];

function pipeNameFromArgs(): string {
  const index = process.argv.indexOf("--pipe");
  return index >= 0 ? process.argv[index + 1]! : "gridsmith-engine";
}

// ------------------------------------------------ supervisão de processos

/** Últimas linhas de stdout/stderr por serviço (diagnóstico de falha na UI). */
const serviceLogs = new Map<string, string[]>();

function recordServiceLine(serviceId: string, stream: "stdout" | "stderr", chunk: Buffer): void {
  const lines = serviceLogs.get(serviceId) ?? [];
  for (const line of chunk.toString("utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    lines.push(`[${stream}] ${line.trimEnd()}`);
    console.log(`[${serviceId}:${stream}] ${line.trimEnd()}`);
  }
  serviceLogs.set(serviceId, lines.slice(-50));
}

/** Spawn com captura de stdout/stderr no formato ManagedProcess do supervisor. */
function launchService(
  serviceId: string,
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): ManagedProcess {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, ...env };
  // O processo filho recebe exatamente uma fonte de credencial. Isso evita
  // herdar um arquivo configurado no shell quando o Electron gerou seu token
  // efêmero direto (e vice-versa).
  if (env?.[EDITOR_AUTH_TOKEN_ENV] !== undefined) {
    delete childEnvironment[EDITOR_AUTH_TOKEN_FILE_ENV];
  } else if (env?.[EDITOR_AUTH_TOKEN_FILE_ENV] !== undefined) {
    delete childEnvironment[EDITOR_AUTH_TOKEN_ENV];
  }
  const child = spawn(command, args, {
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => recordServiceLine(serviceId, "stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => recordServiceLine(serviceId, "stderr", chunk));
  return {
    exited: new Promise((resolve) => {
      child.once("error", (err) => resolve({ code: null, error: err.message }));
      child.once("exit", (code) => resolve({ code }));
    }),
    kill: () => child.kill(),
  };
}

/** Prontidão real: GraphQL baseline obrigatório; gRPC é medido separadamente. */
async function editorTransportsReady(
  client: EditorClient,
  timeoutMs = 15_000,
): Promise<ServiceReadiness> {
  const deadline = Date.now() + timeoutMs;
  let last = await client.probeReadiness();
  while (Date.now() < deadline) {
    if (last.authenticationFailed) {
      return {
        ready: false,
        retryable: false,
        detail: "falha de autenticação nos transports locais",
        checks: {
          middleware: last.middlewareActive ? "active" : "inactive",
          graphql: last.graphqlActive
            ? "active"
            : last.graphqlAuthenticationFailed
              ? "authentication-failed"
              : "inactive",
          grpc: last.grpcActive
            ? "active"
            : last.grpcAuthenticationFailed
              ? "authentication-failed"
              : "inactive",
        },
      };
    }
    if (last.graphqlActive) {
      return {
        ready: true,
        detail: last.grpcActive
          ? "middleware, GraphQL e gRPC ativos"
          : "middleware e GraphQL ativos; gRPC indisponível em modo degradado",
        checks: {
          middleware: "active",
          graphql: "active",
          grpc: last.grpcActive ? "active" : "inactive",
        },
      };
    }
    await new Promise((r) => setTimeout(r, 300));
    last = await client.probeReadiness();
  }
  return {
    ready: false,
    detail: "GraphQL baseline não ficou pronto dentro do prazo",
    checks: {
      middleware: last.middlewareActive ? "active" : "inactive",
      graphql: last.graphqlActive ? "active" : "inactive",
      grpc: last.grpcActive ? "active" : "inactive",
    },
  };
}

function buildSupervisor(
  pipeName: string,
  client: EditorClient,
  authToken: string,
): ProcessSupervisor {
  const repoRoot = path.join(dirname, "../../..");
  const middlewareEntry = path.join(dirname, "../../node_modules/@gridsmith/middleware/dist/index.js");
  // Dois executáveis atendem o MESMO plano de controle sobre os mesmos stores
  // (ADR-022): o Host abre janela e DESENHA; o Runtime é headless. Preferimos o
  // Host quando ele estiver compilado — é o que faz o produto mostrar o jogo —
  // e caímos para o Runtime quando não estiver, em vez de deixar o editor sem
  // engine nenhuma.
  const hostDll = path.join(
    repoRoot,
    "engine/src/Gridsmith.Engine.Host/bin/Debug/net8.0/Gridsmith.Engine.Host.dll",
  );
  const runtimeDll = path.join(
    repoRoot,
    "engine/src/Gridsmith.Engine.Runtime/bin/Debug/net8.0/Gridsmith.Engine.Runtime.dll",
  );
  const graphicsHostAvailable = fs.existsSync(hostDll);
  const engineDll = graphicsHostAvailable ? hostDll : runtimeDll;

  return new ProcessSupervisor([
    {
      id: "middleware",
      displayName: "Serviços Gridsmith",
      // o Electron roda o middleware como Node (ELECTRON_RUN_AS_NODE): um
      // único executável sobe o ecossistema inteiro
      launch: () =>
        launchService(
          "middleware",
          process.execPath,
          [middlewareEntry, "--pipe", pipeName, "--no-mcp"],
          {
            ELECTRON_RUN_AS_NODE: "1",
            [EDITOR_AUTH_TOKEN_ENV]: authToken,
          },
        ),
      waitReady: () => editorTransportsReady(client),
      maxAttempts: 3,
    },
    {
      id: "engine",
      // O rótulo diz o que o processo É. Chamar de "Runtime MonoGame" um
      // servidor JSON-RPC que nunca carregou MonoGame fazia a barra de status
      // prometer pixels que não existiam.
      displayName: graphicsHostAvailable ? "Engine (janela gráfica)" : "Engine (sem janela)",
      optional: true, // editor segue editável com a engine caída (modo degradado)
      launch: () => {
        if (!fs.existsSync(engineDll)) {
          return {
            exited: Promise.resolve({
              code: null,
              error: `engine não compilada (${engineDll}); execute "dotnet build" em engine/`,
            }),
            kill: () => undefined,
          };
        }
        return launchService("engine", "dotnet", [engineDll, "--pipe", pipeName]);
      },
      waitReady: async () => {
        // pronto quando o manifesto vivo alimenta a experiência governada
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          try {
            if (!client.isConnected) await client.connect();
            const experience = (await client.resolveExperience()) as unknown as {
              liveManifestConsidered?: boolean;
            };
            if (experience.liveManifestConsidered) return true;
          } catch {
            // gateway ainda conectando: tenta de novo
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      },
      maxAttempts: 3,
    },
  ]);
}

function recentsFile(): string {
  return path.join(app.getPath("userData"), "recent-projects.json");
}

function loadRecents(): RecentProject[] {
  try {
    // arquivo em userData é entrada NÃO confiável: parseRecents descarta o
    // inválido em vez de deixar item quebrado chegar à tela inicial
    return parseRecents(JSON.parse(fs.readFileSync(recentsFile(), "utf8")));
  } catch {
    return [];
  }
}

interface ProjectStatusPayload {
  state: string;
  windowTitle: string;
  isDirty: boolean;
  project?: {
    filePath?: string;
    name: string;
    projectSessionId?: string;
    projectId?: string;
  };
  recents: readonly unknown[];
  /**
   * Verdade do runtime para a sessão ativa: `synchronized` (tudo aplicado),
   * `deferred` (há comando não projetado) ou `failed` (sessão fail-closed).
   * Ausente quando não há projeto aberto.
   */
  runtimeState?: "synchronized" | "deferred" | "failed";
  /** Aviso pontual (ex.: recuperação restaurada); consumido uma única vez. */
  notice?: string;
}

function statusOf(
  lifecycle: ProjectLifecycle,
  runtimeState?: ProjectStatus["runtimeState"],
  notice?: string,
): ProjectStatusPayload {
  return {
    state: lifecycle.currentState,
    windowTitle: lifecycle.windowTitle,
    isDirty: lifecycle.isDirty,
    ...(lifecycle.project !== undefined ? { project: lifecycle.project } : {}),
    recents: lifecycle.recentProjects,
    ...(runtimeState !== undefined ? { runtimeState } : {}),
    ...(notice ? { notice } : {}),
  };
}

let mainWindow: BrowserWindow | undefined;

/**
 * Aberturas pedidas de fora (argumento de linha de comando ou segunda
 * instância). O pedido pode chegar ANTES de o ciclo de projeto existir, então
 * ele espera numa fila em vez de se perder.
 */
const pendingOpenPaths: string[] = [];
let routeOpenPath: ((filePath: string) => void) | undefined;

function requestExternalOpen(filePath: string | undefined): void {
  if (!filePath) return;
  if (routeOpenPath) routeOpenPath(filePath);
  else pendingOpenPaths.push(filePath);
}

void app.whenReady().then(async () => {
  // instância única: a segunda sai, a primeira ganha foco — e o ARGUMENTO da
  // segunda é roteado, para abrir um .gridsmith.json pelo gerenciador de arquivos
  if (
    !ensureSingleInstance(
      () => mainWindow,
      (argv, workingDirectory) => requestExternalOpen(projectPathFromArgs(argv, workingDirectory)),
    )
  ) {
    return;
  }

  const pipeName = pipeNameFromArgs();
  const externalServices = process.argv.includes("--external-services");
  // Em produção, o segredo vive somente no main e no ambiente do filho. No
  // modo externo, o operador fornece a mesma credencial por env/arquivo.
  const authToken = externalServices
    ? loadTransportAuthToken()
    : generateTransportAuthToken();
  const client = new EditorClient(pipeName, { authToken });
  const projectFiles = new ProjectFileService(new NodeProjectFileSystem(), () => randomUUID());
  /** Aviso da última recuperação; some no próximo status para não grudar na tela. */
  let recoveryNotice = "";
  const lifecycle = new ProjectLifecycle(Date.now, {}, loadRecents());
  let window: BrowserWindow;

  // P0.1: por padrão o Electron é o supervisor do ecossistema (executável
  // único); --external-services preserva o modo dev com serviços próprios
  const supervisor = externalServices ? undefined : buildSupervisor(pipeName, client, authToken);
  const supervisionStarted = supervisor?.startAll();

  const serviceStatusPayload = (): Array<ServiceStatus & { recentLog: readonly string[] }> =>
    (supervisor?.all ?? []).map((service) => ({
      ...service,
      recentLog: (serviceLogs.get(service.id) ?? []).slice(-5),
    }));

  supervisor?.onEvent(() => {
    if (window && !window.isDestroyed()) {
      window.webContents.send("gridsmith:service-status", serviceStatusPayload());
    }
  });

  const broadcast = (): void => {
    if (window && !window.isDestroyed()) {
      window.setTitle(lifecycle.windowTitle);
      const notice = recoveryNotice;
      recoveryNotice = "";
      window.webContents.send(
        "gridsmith:project-status",
        statusOf(lifecycle, client.activeProjectStatus?.runtimeState, notice),
      );
    }
    // best-effort e durável: a lista de recentes nunca justifica derrubar o app
    void projectFiles
      .writeJsonFile(recentsFile(), lifecycle.recentProjects)
      .catch(() => undefined);
  };
  lifecycle.onEvent(() => broadcast());

  const descriptorFromStatus = (
    status: ProjectStatus,
    name: string,
    filePath?: string,
  ): ProjectDescriptor => {
    if (!status.active || !status.projectSessionId || !status.projectId) {
      throw new Error("middleware did not activate the requested project session");
    }
    return {
      name,
      projectSessionId: status.projectSessionId,
      projectId: status.projectId,
      ...(filePath ? { filePath } : {}),
    };
  };

  const writeDocument = async (
    filePath: string,
    expectedProjectSessionId: string,
  ): Promise<void> => {
    const document = await client.saveDocument(expectedProjectSessionId);
    if (
      lifecycle.project?.projectSessionId !== expectedProjectSessionId ||
      client.activeProjectSessionId !== expectedProjectSessionId
    ) {
      throw new Error("project session changed before the document could be written");
    }
    // escrita durável: temporário no mesmo diretório, fsync, rename atômico e
    // cópia anterior preservada em .bak. Um crash no meio jamais deixa o
    // projeto do usuário truncado.
    await projectFiles.writeProject(filePath, document);
    // save CONFIRMADO é o único momento (junto do descarte explícito) em que o
    // sidecar pode sumir: o arquivo agora contém o trabalho que ele guardava.
    await projectFiles.discardAutosave(filePath);
  };

  // Autosave: limiar de comandos (via commandApplied) + intervalo (tick)
  const autosave = async (): Promise<void> => {
    const descriptor = lifecycle.project;
    const filePath = descriptor?.filePath;
    const expectedProjectSessionId = descriptor?.projectSessionId;
    if (!filePath || !expectedProjectSessionId) return;
    try {
      const document = await client.saveDocument(expectedProjectSessionId);
      if (
        lifecycle.project?.projectSessionId !== expectedProjectSessionId ||
        lifecycle.project.filePath !== filePath ||
        client.activeProjectSessionId !== expectedProjectSessionId
      ) return;
      await projectFiles.writeAutosave(filePath, document);
    } catch {
      // autosave é best-effort; o save explícito reporta erros
    }
  };
  setInterval(() => {
    if (lifecycle.autosaveTick()) void autosave();
  }, 5_000).unref();

  const saveCurrentProject = async (forceSaveAs: boolean): Promise<boolean> => {
    const descriptor = lifecycle.project;
    const expectedProjectSessionId = descriptor?.projectSessionId;
    if (!descriptor || !expectedProjectSessionId) {
      throw new Error("cannot save without an active project session");
    }
    let filePath = forceSaveAs ? undefined : descriptor.filePath;
    if (!filePath) {
      const picked = await dialog.showSaveDialog(window, {
        title: "Salvar projeto Gridsmith",
        filters: PROJECT_FILTER,
        defaultPath: defaultProjectFileName(descriptor.name),
      });
      if (picked.canceled || !picked.filePath) return false;
      filePath = picked.filePath;
    }
    lifecycle.beginSave();
    try {
      await writeDocument(filePath, expectedProjectSessionId);
      lifecycle.saved(filePath);
      return true;
    } catch (error) {
      lifecycle.saveFailed();
      throw error;
    }
  };

  /**
   * Templates anunciados pelo middleware. Falha aqui NÃO impede criar projeto:
   * sem lista, o fluxo cai no projeto em branco (comportamento anterior).
   */
  const availableTemplates = async (): Promise<readonly ProjectTemplateOption[]> => {
    try {
      const { templates } = await client.listProjectTemplates();
      return templates;
    } catch {
      return [];
    }
  };

  /** Quatro saídas explícitas; fechar a janela do diálogo equivale a cancelar. */
  const chooseRecovery = async (autosaveModifiedAtMs: number): Promise<RecoveryDecision> => {
    const quando = new Date(autosaveModifiedAtMs).toLocaleString("pt-BR");
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      title: "Recuperação disponível",
      message: "Existe trabalho recuperado mais recente que o arquivo salvo.",
      detail:
        `Recuperação de ${quando}. "Restaurar" abre esse conteúdo no projeto original; ` +
        `"Abrir cópia" mantém o original intocado; "Ignorar" descarta a recuperação.`,
      buttons: ["Restaurar", "Abrir cópia", "Ignorar", "Cancelar"],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });
    return (["restore", "copy", "ignore", "cancel"] as const)[response] ?? "cancel";
  };

  const projectCommand = async (
    command: "new" | "open" | "openPath" | "save" | "saveAs" | "close",
    payload?: { filePath?: string; templateId?: string },
  ): Promise<ProjectStatusPayload> => {
    switch (command) {
      case "new": {
        // Passo 2 da jornada: escolher "Novo projeto de plataforma 2D". A
        // decisão é pura (core/newProjectChoice); aqui só há diálogo nativo.
        let templateId = payload?.templateId;
        if (templateId === undefined) {
          const templates = await availableTemplates();
          const prompt = buildNewProjectPrompt(templates);
          if (prompt) {
            const { response } = await dialog.showMessageBox(window, {
              type: "question",
              title: prompt.title,
              message: prompt.message,
              detail: prompt.detail,
              buttons: [...prompt.buttons],
              defaultId: prompt.defaultId,
              cancelId: prompt.cancelId,
            });
            const choice = resolveNewProjectChoice(templates, response);
            // Cancelar não toca na máquina de estados nem na sessão ativa.
            if (choice.kind === "cancel") break;
            if (choice.kind === "template") templateId = choice.templateId;
          }
        }
        lifecycle.beginOpen();
        try {
          const result = await client.createProject(templateId);
          lifecycle.opened(
            descriptorFromStatus(result.status, result.name ?? "Projeto sem título"),
          );
        } catch (error) {
          lifecycle.openFailed();
          throw error;
        }
        break;
      }
      case "open":
      case "openPath": {
        let filePath = payload?.filePath;
        if (command === "open") {
          const picked = await dialog.showOpenDialog(window, {
            title: "Abrir projeto Gridsmith",
            filters: PROJECT_FILTER,
            properties: ["openFile"],
          });
          if (picked.canceled || picked.filePaths.length === 0) break;
          filePath = picked.filePaths[0]!;
        }
        if (!filePath) break;
        // Recuperação: um sidecar mais novo que o arquivo salvo significa que o
        // editor caiu entre dois saves. O usuário decide; nada é apagado sem
        // ordem explícita dele.
        const candidate = await projectFiles.detectRecovery(filePath);
        const plan = candidate
          ? planRecovery(await chooseRecovery(candidate.autosaveModifiedAtMs))
          : planWithoutRecovery();
        if (!plan.proceed) break;
        if (plan.discardAutosave) await projectFiles.discardAutosave(filePath);

        // Parse local acontece antes da transação; JSON inválido sequer altera
        // a máquina de estados e a sessão A continua íntegra.
        const document: unknown =
          plan.source === "autosave"
            ? await projectFiles.readAutosave(filePath)
            : await projectFiles.readDocument(filePath);
        lifecycle.beginOpen();
        try {
          const result = await client.openProjectDocument(document);
          const nome = projectNameFromPath(filePath);
          lifecycle.opened(
            plan.bindToFile
              ? descriptorFromStatus(result.status, nome, filePath)
              : descriptorFromStatus(result.status, `${nome} (recuperado)`),
          );
          // conteúdo recuperado nunca esteve no arquivo: abrir limpo faria o
          // usuário fechar sem salvar e perder o mesmo trabalho de novo
          if (plan.openDirty) lifecycle.commandApplied();
          if (plan.notice) recoveryNotice = plan.notice;
        } catch (err) {
          lifecycle.openFailed();
          throw err;
        }
        break;
      }
      case "save":
      case "saveAs": {
        await saveCurrentProject(command === "saveAs");
        break;
      }
      case "close": {
        if (!lifecycle.project) {
          await client.closeProject();
          break;
        }
        const decision = lifecycle.requestClose();
        if (decision === "confirm-discard") {
          const { response } = await dialog.showMessageBox(window, {
            type: "warning",
            title: "Alterações não salvas",
            message: `"${lifecycle.project?.name}" tem alterações não salvas.`,
            buttons: ["Salvar", "Descartar", "Cancelar"],
            defaultId: 0,
            cancelId: 2,
          });
          if (response === 2) {
            lifecycle.cancelClose();
            break;
          }
          if (response === 0) {
            // Save usa sua própria transação; só depois voltamos a closing.
            lifecycle.cancelClose();
            if (!(await saveCurrentProject(false))) break;
            lifecycle.requestClose();
          }
        }
        const expectedProjectSessionId = lifecycle.project?.projectSessionId;
        try {
          const status = await client.closeProject(expectedProjectSessionId);
          if (status.active) throw new Error("middleware kept the project session active");
          lifecycle.confirmClose();
        } catch (error) {
          lifecycle.cancelClose();
          throw error;
        }
        break;
      }
    }
    return statusOf(lifecycle, client.activeProjectStatus?.runtimeState);
  };

  // Conexão idempotente: com supervisão, o próprio waitReady da engine já
  // conecta o cliente — reconectar criaria uma segunda sessão de editor.
  let session: { sessionId: string } | undefined;
  ipcMain.handle("gridsmith:connect", async () => {
    if (client.isConnected && session) return session;
    if (supervisionStarted) {
      // espera o middleware subir (ou falhar) antes da primeira tentativa
      await Promise.race([supervisionStarted, new Promise((r) => setTimeout(r, 20_000))]);
    }
    try {
      session = await client.connect();
      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/protocol.*mismatch/i.test(message)) {
        // P0.1: versão incompatível com mensagem orientada à solução
        throw new Error(
          `As versões do editor e dos serviços Gridsmith são incompatíveis (${message}). ` +
            `Atualize a instalação inteira do Gridsmith e abra o aplicativo novamente.`,
        );
      }
      throw err;
    }
  });
  ipcMain.handle("gridsmith:service-status", () => serviceStatusPayload());
  ipcMain.handle("gridsmith:technical-diagnostics", () => client.technicalDiagnostics);
  ipcMain.handle("gridsmith:service-restart", async (_event, serviceId: string) => {
    if (!supervisor) return false;
    const ok = await supervisor.restart(serviceId);
    // engine nova = sessão nova: o middleware reidrata o Blueprint sozinho
    return ok;
  });
  ipcMain.handle("gridsmith:dispatch", (_event, kind: string, payload: Record<string, unknown>) =>
    client.dispatch(kind, payload),
  );
  ipcMain.handle("gridsmith:query", (_event, projection: string) => client.query(projection));
  ipcMain.handle("gridsmith:experience", (_event, family?: string, version?: string) =>
    client.resolveExperience(family, version),
  );
  ipcMain.handle("gridsmith:project-command", (_event, command, payload) =>
    projectCommand(command, payload),
  );

  // A partir daqui o ciclo de projeto existe: liga o roteador e drena o que
  // chegou antes (argumento de inicialização ou segunda instância precoce).
  routeOpenPath = (filePath: string): void => {
    void projectCommand("openPath", { filePath })
      .then((status) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("gridsmith:project-status", status);
        }
      })
      .catch((error: unknown) => {
        console.error(`[gridsmith] falha ao abrir ${filePath}: ${String(error)}`);
      });
  };
  requestExternalOpen(projectPathFromArgs(process.argv));
  while (pendingOpenPaths.length > 0) routeOpenPath(pendingOpenPaths.shift()!);
  // a tela inicial oferece os templates como cards; sem este handler ela só
  // conseguiria reabrir o diálogo nativo que o menu já usa
  // Histórico global: a capacidade fica exposta ao renderer aqui. Trocar o
  // Ctrl+Z do editor local por este caminho canônico é da frente F6/E10 — a
  // vista ainda guarda estado no closure, e mover o atalho antes disso faria
  // o desfazer global brigar com o desfazer local do IntGrid.
  ipcMain.handle("gridsmith:history-status", (_event, limit?: number) => client.historyStatus(limit));
  ipcMain.handle("gridsmith:history-undo", (_event, historyCursor?: string) =>
    client.undo(historyCursor),
  );
  ipcMain.handle("gridsmith:history-redo", (_event, historyCursor?: string) =>
    client.redo(historyCursor),
  );
  ipcMain.handle("gridsmith:project-templates", async () => ({
    templates: await availableTemplates(),
  }));
  ipcMain.handle("gridsmith:project-status", () =>
    statusOf(lifecycle, client.activeProjectStatus?.runtimeState),
  );

  // Configuração refinada do Electron (appConfig.ts): janela endurecida
  // (sandbox, navegação bloqueada), estado persistido entre sessões
  window = new BrowserWindow(hardenedWindowOptions(path.join(dirname, "preload.js")));
  mainWindow = window;
  if (loadWindowState().maximized) window.maximize();
  trackWindowState(window);
  hardenNavigation(window);

  // Menu nativo com atalhos (ALPHA-0.1 P0.3): projeto no main, edição no renderer
  const sendMenuAction = (action: "undo" | "redo") => (): void => {
    if (!window.isDestroyed()) window.webContents.send("gridsmith:menu-action", action);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Arquivo",
        submenu: [
          { label: "Novo projeto", accelerator: "CmdOrCtrl+N", click: () => void projectCommand("new") },
          { label: "Abrir projeto…", accelerator: "CmdOrCtrl+O", click: () => void projectCommand("open") },
          { type: "separator" },
          { label: "Salvar", accelerator: "CmdOrCtrl+S", click: () => void projectCommand("save") },
          { label: "Salvar como…", accelerator: "CmdOrCtrl+Shift+S", click: () => void projectCommand("saveAs") },
          { type: "separator" },
          { label: "Fechar projeto", accelerator: "CmdOrCtrl+W", click: () => void projectCommand("close") },
          { role: "quit", label: "Sair" },
        ],
      },
      {
        label: "Editar",
        submenu: [
          { label: "Desfazer", accelerator: "CmdOrCtrl+Z", click: sendMenuAction("undo") },
          { label: "Refazer", accelerator: "CmdOrCtrl+Shift+Z", click: sendMenuAction("redo") },
        ],
      },
      {
        label: "Exibir",
        submenu: [
          { role: "reload", label: "Recarregar" },
          { role: "toggleDevTools", label: "Ferramentas de desenvolvimento" },
          { type: "separator" },
          { role: "resetZoom", label: "Zoom padrão" },
          { role: "zoomIn", label: "Aumentar zoom" },
          { role: "zoomOut", label: "Diminuir zoom" },
        ],
      },
    ]),
  );

  let projectReconciliationGeneration = 0;
  client.onBlueprintEvent((event, projection) => {
    // Um callback atrasado de A nunca suja nem chega ao renderer de B.
    if (event.projectSessionId !== lifecycle.project?.projectSessionId) return;
    if (lifecycle.commandApplied()) void autosave();
    if (!window.isDestroyed()) {
      // A projeção acompanha o evento: o renderer precisa dela para saber se
      // o comando chegou ao runtime ou ficou pendente com razão.
      window.webContents.send("gridsmith:blueprint-event", event, projection);
      broadcast();
    }
  });
  client.onResynchronized((snapshot, record) => {
    const generation = ++projectReconciliationGeneration;
    const reconcileProjectSession = (): void => {
      if (generation !== projectReconciliationGeneration) return;
      if (
        lifecycle.currentState === "opening" ||
        lifecycle.currentState === "saving" ||
        lifecycle.currentState === "closing"
      ) {
        const retry = setTimeout(reconcileProjectSession, 25);
        retry.unref();
        return;
      }
      const remote = snapshot.status;
      const localSessionId = lifecycle.project?.projectSessionId;
      if (remote.active && remote.projectSessionId && remote.projectId) {
        if (remote.projectSessionId !== localSessionId) {
          lifecycle.beginOpen();
          lifecycle.opened(
            descriptorFromStatus(remote, `Projeto ${remote.projectId}`),
          );
        }
      } else if (lifecycle.project) {
        lifecycle.requestClose();
        lifecycle.confirmClose();
      }
    };
    reconcileProjectSession();
    if (!window.isDestroyed()) {
      window.webContents.send("gridsmith:projection-resync", { snapshot, record });
    }
  });

  await window.loadFile(path.join(dirname, "../renderer/index.html"));
  broadcast();
  window.webContents.send("gridsmith:service-status", serviceStatusPayload());

  app.on("window-all-closed", () => {
    client.close();
    // encerramento coordenado, ordem inversa da subida (engine → middleware)
    const finish = (): void => app.quit();
    if (supervisor) void supervisor.shutdown().then(finish, finish);
    else finish();
  });
});
