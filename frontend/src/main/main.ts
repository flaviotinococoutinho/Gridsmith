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
} from "@p7m/middleware/dist/transport/auth.js";
import { ProjectLifecycle, type RecentProject } from "../core/projectLifecycle.js";
import type {
  CreateProjectFromTemplateRequest,
  DiscardAutosaveRequest,
  NativeMenuCommandDescriptor,
  OpenProjectRequest,
  ProjectCommandInvocation,
  RestoreAutosaveRequest,
} from "../core/projectApi.js";
import {
  PROJECT_CLOSE_PREFLIGHT_CHANNELS,
  PROJECT_COMMAND_IDS,
} from "../core/projectApi.js";
import {
  ProcessSupervisor,
  type ManagedProcess,
  type ServiceReadiness,
  type ServiceStatus,
} from "./ProcessSupervisor.js";
import { EditorClient } from "./EditorClient.js";
import { ElectronProjectDialogs } from "./project/ElectronProjectDialogs.js";
import { NodeProjectFileSystem } from "./project/NodeProjectFileSystem.js";
import { ProjectFileService } from "./project/ProjectFileService.js";
import {
  focusExistingProjectWindow,
  projectPathFromArgs,
} from "./project/ProjectLaunchRouting.js";
import {
  ProjectController,
  SingleInstanceProjectLeaseRegistry,
  statusOf,
} from "./project/ProjectController.js";
import {
  ensureSingleInstance,
  hardenNavigation,
  hardenedWindowOptions,
  loadWindowState,
  trackWindowState,
} from "./appConfig.js";
import {
  buildNativeMenuTemplate,
  defaultNativeMenuCommands,
  validateNativeMenuCommandDescriptors,
} from "./nativeMenuHost.js";
import { ProjectClosePreflight } from "./projectClosePreflight.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

function pipeNameFromArgs(): string {
  const index = process.argv.indexOf("--pipe");
  return index >= 0 ? process.argv[index + 1]! : "p7m-engine";
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
  const middlewareEntry = path.join(dirname, "../../node_modules/@p7m/middleware/dist/index.js");
  const engineDll = path.join(
    repoRoot,
    "engine/src/P7m.Engine.Runtime/bin/Debug/net8.0/P7m.Engine.Runtime.dll",
  );

  return new ProcessSupervisor([
    {
      id: "middleware",
      displayName: "Serviços P7M",
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
      displayName: "Runtime MonoGame",
      optional: true, // editor segue editável com a engine caída (modo degradado)
      launch: () => {
        if (!fs.existsSync(engineDll)) {
          return {
            exited: Promise.resolve({
              code: null,
              error: `runtime não compilado (${engineDll}); execute "dotnet build" em engine/`,
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

async function loadRecents(files: ProjectFileService): Promise<RecentProject[]> {
  try {
    const parsed = await files.readDocument(recentsFile());
    return Array.isArray(parsed) ? parsed as RecentProject[] : [];
  } catch {
    return [];
  }
}

let mainWindow: BrowserWindow | undefined;
const pendingOpenPaths: string[] = [];
let routeOpenPath: ((filePath: string) => void) | undefined;

// O lock precisa existir antes de `ready`: duas instâncias iniciadas juntas
// não podem criar janelas/sessões concorrentes antes de o handler ser ligado.
const isPrimaryInstance = ensureSingleInstance(
  () => mainWindow,
  (argv, workingDirectory) => {
    const filePath = projectPathFromArgs(argv, workingDirectory);
    if (!filePath) return;
    if (routeOpenPath) routeOpenPath(filePath);
    else pendingOpenPaths.push(filePath);
  },
);

if (isPrimaryInstance) void app.whenReady().then(async () => {

  const pipeName = pipeNameFromArgs();
  const externalServices = process.argv.includes("--external-services");
  // Em produção, o segredo vive somente no main e no ambiente do filho. No
  // modo externo, o operador fornece a mesma credencial por env/arquivo.
  const authToken = externalServices
    ? loadTransportAuthToken()
    : generateTransportAuthToken();
  const client = new EditorClient(pipeName, { authToken });
  const nodeFiles = new NodeProjectFileSystem();
  const projectFiles = new ProjectFileService(nodeFiles, randomUUID);
  const lifecycle = new ProjectLifecycle(Date.now, {}, await loadRecents(projectFiles));
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
      window.webContents.send("p7m:service-status", serviceStatusPayload());
    }
  });

  const projectDialogs = new ElectronProjectDialogs(() => window);
  const controller = new ProjectController({
    lifecycle,
    editor: client,
    files: projectFiles,
    dialogs: projectDialogs,
    leases: new SingleInstanceProjectLeaseRegistry(),
    exampleProjectPath: path.join(dirname, "../examples/platformer-2d-example.p7m.json"),
    createId: randomUUID,
  });

  let rebuildMenu = (): void => undefined;
  let projectedNativeMenuCommands: readonly NativeMenuCommandDescriptor[] | undefined;
  let recentsWrite = Promise.resolve();
  const broadcast = (): void => {
    if (window && !window.isDestroyed()) {
      window.setTitle(lifecycle.windowTitle);
      window.webContents.send("p7m:project-status", statusOf(lifecycle));
    }
    rebuildMenu();
  };
  lifecycle.onEvent((event) => {
    broadcast();
    if (event.kind === "recentsChanged") {
      // Persistência auxiliar nunca participa da transação de sessão.
      recentsWrite = recentsWrite
        .then(() => projectFiles.writeJsonFile(recentsFile(), lifecycle.recentProjects))
        .catch((error) => console.error("[project-recents]", error));
    }
  });

  // Autosave: limiar de comandos (via commandApplied) + intervalo (tick)
  setInterval(() => {
    if (lifecycle.autosaveTick()) {
      void controller.autosave().catch((error) => console.error("[project-autosave]", error));
    }
  }, 5_000).unref();

  // Conexão idempotente: com supervisão, o próprio waitReady da engine já
  // conecta o cliente — reconectar criaria uma segunda sessão de editor.
  let session: { sessionId: string } | undefined;
  ipcMain.handle("p7m:connect", async () => {
    if (client.isConnected && session) return session;
    if (supervisionStarted) {
      // espera o middleware subir (ou falhar) antes da primeira tentativa
      await Promise.race([supervisionStarted, new Promise((r) => setTimeout(r, 20_000))]);
    }
    try {
      session = await client.connect();
      if (routeOpenPath) {
        for (const filePath of pendingOpenPaths.splice(0)) routeOpenPath(filePath);
      }
      return session;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/protocol.*mismatch/i.test(message)) {
        // P0.1: versão incompatível com mensagem orientada à solução
        throw new Error(
          `As versões do editor e dos serviços P7M são incompatíveis (${message}). ` +
            `Atualize a instalação inteira do P7M e abra o aplicativo novamente.`,
        );
      }
      throw err;
    }
  });
  ipcMain.handle("p7m:service-status", () => serviceStatusPayload());
  ipcMain.handle("p7m:technical-diagnostics", () => client.technicalDiagnostics);
  ipcMain.handle("p7m:service-restart", async (_event, serviceId: string) => {
    if (!supervisor) return false;
    const ok = await supervisor.restart(serviceId);
    // engine nova = sessão nova: o middleware reidrata o Blueprint sozinho
    return ok;
  });
  ipcMain.handle("p7m:dispatch", async (_event, kind: string, payload: Record<string, unknown>) => {
    const result = await controller.dispatch(kind, payload);
    if (result.autosaveDue) {
      void controller.autosave().catch((error) => console.error("[project-autosave]", error));
    }
    return result.outcome;
  });
  ipcMain.handle("p7m:query", (_event, projection: string) => client.query(projection));
  ipcMain.handle("p7m:capture-project-snapshot", (_event, expectedProjectSessionId: string) =>
    client.captureProjectSnapshot(expectedProjectSessionId));
  ipcMain.handle("p7m:history-undo", () => controller.undo());
  ipcMain.handle("p7m:history-redo", () => controller.redo());
  ipcMain.handle("p7m:history-status", (_event, limit?: number) =>
    controller.historyStatus(limit));
  ipcMain.on("p7m:gesture-begin", (_event, transactionId: string) => {
    controller.beginEditGesture(transactionId);
  });
  ipcMain.on("p7m:gesture-end", (_event, transactionId: string) => {
    controller.endEditGesture(transactionId);
  });
  ipcMain.handle("p7m:experience", (_event, family?: string, version?: string) =>
    client.resolveExperience(family, version),
  );
  ipcMain.handle("p7m:list-project-templates", () => controller.listProjectTemplates());
  ipcMain.handle(
    "p7m:create-project-from-template",
    (_event, request: CreateProjectFromTemplateRequest) =>
      controller.createProjectFromTemplate(request),
  );
  ipcMain.handle("p7m:open-project", (_event, request?: OpenProjectRequest) =>
    controller.openProject(request),
  );
  ipcMain.handle("p7m:save-project", () => controller.saveProject());
  ipcMain.handle("p7m:save-project-as", () => controller.saveProjectAs());
  ipcMain.handle("p7m:restore-autosave", (_event, request: RestoreAutosaveRequest) =>
    controller.restoreAutosave(request),
  );
  ipcMain.handle("p7m:discard-autosave", (_event, request: DiscardAutosaveRequest) =>
    controller.discardAutosave(request),
  );
  ipcMain.handle("p7m:open-recent", (_event, filePath: string) =>
    controller.openRecent(filePath),
  );
  ipcMain.handle("p7m:project-status", () => statusOf(lifecycle));

  // Configuração refinada do Electron (appConfig.ts): janela endurecida
  // (sandbox, navegação bloqueada), estado persistido entre sessões
  window = new BrowserWindow(hardenedWindowOptions(path.join(dirname, "preload.js")));
  mainWindow = window;
  const closePreflight = new ProjectClosePreflight({
    createId: randomUUID,
    send: (request) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error("renderer indisponível");
      }
      window.webContents.send(PROJECT_CLOSE_PREFLIGHT_CHANNELS.request, request);
    },
  });
  ipcMain.on(PROJECT_CLOSE_PREFLIGHT_CHANNELS.response, (event, response: unknown) => {
    if (event.sender.id === window.webContents.id) closePreflight.accept(response);
  });
  ipcMain.handle("p7m:close-project", async (event) => {
    if (event.sender.id !== window.webContents.id) {
      throw new Error("Project close rejected for an unknown renderer");
    }
    if (lifecycle.project) await closePreflight.request("project-close");
    return controller.closeProject();
  });
  window.webContents.on("render-process-gone", () => {
    controller.clearEditGestures();
    closePreflight.cancelAll();
  });
  if (loadWindowState().maximized) window.maximize();
  trackWindowState(window);
  hardenNavigation(window);

  const reportProjectError = (error: unknown): void => {
    dialog.showErrorBox(
      "Não foi possível concluir a operação",
      error instanceof Error ? error.message : String(error),
    );
  };
  // Menu nativo é só mais uma superfície do CommandRegistry. O renderer
  // resolve a contribuição e chama a API preload correspondente; IO e gates
  // transacionais continuam no ProjectController, nunca no registro.
  const emitCommandInvocation = (invocation: ProjectCommandInvocation): void => {
    if (!window.isDestroyed()) window.webContents.send("p7m:menu-action", invocation);
  };
  rebuildMenu = (): void => {
    const commands = projectedNativeMenuCommands ?? defaultNativeMenuCommands({
      new: PROJECT_COMMAND_IDS.new,
      open: PROJECT_COMMAND_IDS.open,
      openExample: PROJECT_COMMAND_IDS.openExample,
      openRecent: PROJECT_COMMAND_IDS.openRecent,
      save: PROJECT_COMMAND_IDS.save,
      saveAs: PROJECT_COMMAND_IDS.saveAs,
      close: PROJECT_COMMAND_IDS.close,
      undo: PROJECT_COMMAND_IDS.undo,
      redo: PROJECT_COMMAND_IDS.redo,
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildNativeMenuTemplate({
      commands,
      recentProjects: lifecycle.recentProjects,
      recentCommandId: PROJECT_COMMAND_IDS.openRecent,
      invoke: emitCommandInvocation,
      openRecent: (filePath) => {
        const recent = lifecycle.recentProjects.find((candidate) => candidate.filePath === filePath);
        if (!recent) return;
        emitCommandInvocation({
          commandId: PROJECT_COMMAND_IDS.openRecent,
          args: { filePath: recent.filePath },
        });
      },
      requestClose: () => window.close(),
    })));
  };
  ipcMain.handle("p7m:update-native-menu", (event, commands: unknown) => {
    if (event.sender.id !== window.webContents.id) {
      throw new Error("Native menu projection rejected for an unknown renderer");
    }
    const validated = validateNativeMenuCommandDescriptors(commands);
    const previous = projectedNativeMenuCommands;
    projectedNativeMenuCommands = validated;
    try {
      rebuildMenu();
    } catch (error) {
      projectedNativeMenuCommands = previous;
      rebuildMenu();
      throw error;
    }
    return { acceptedCommandCount: validated.length };
  });
  rebuildMenu();

  let allowWindowClose = false;
  let closeInFlight = false;
  window.on("close", (event) => {
    if (allowWindowClose || !lifecycle.project) return;
    event.preventDefault();
    if (closeInFlight) return;
    closeInFlight = true;
    void closePreflight.request("window-close").then(() => controller.closeProject()).then(
      (result) => {
        if (result.outcome === "completed" && !lifecycle.project) {
          allowWindowClose = true;
          window.close();
        }
      },
      reportProjectError,
    ).finally(() => {
      closeInFlight = false;
    });
  });

  client.onBlueprintEvent((event) => {
    // Um callback atrasado de A nunca suja nem chega ao renderer de B.
    if (event.projectSessionId !== lifecycle.project?.projectSessionId) return;
    const observation = controller.observeCommittedCommand(event);
    // Se a resposta do dispatch se perdeu, o evento é a confirmação que
    // encerra o gate sem permitir Save de uma projeção ainda incerta.
    if (event.transactionId) controller.endEditGesture(event.transactionId);
    void observation.then((autosaveDue) => {
      if (autosaveDue) {
        void controller.autosave().catch((error) => console.error("[project-autosave]", error));
      }
    }, (error) => console.error("[project-dirty-tracking]", error));
    if (!window.isDestroyed()) {
      window.webContents.send("p7m:blueprint-event", event);
    }
  });
  client.onResynchronized((snapshot, record) => {
    // O snapshot completo decide qualquer comando de entrega incerta. A
    // projeção do renderer será substituída abaixo antes de um Save enfileirado.
    controller.clearEditGestures();
    void controller.reconcileRemoteSnapshot(snapshot).then((outcome) => {
      // Um snapshot vazio que acaba de ser compensado nunca substitui a UI;
      // a reabertura emite em seguida o snapshot completo da nova sessão.
      if (outcome === "applied" && !window.isDestroyed()) {
        window.webContents.send("p7m:projection-resync", { snapshot, record });
      }
    }, (error) => console.error("[project-reconciliation]", error));
  });

  await window.loadFile(path.join(dirname, "../renderer/index.html"));
  await controller.pruneMissingRecents();
  broadcast();
  window.webContents.send("p7m:service-status", serviceStatusPayload());

  routeOpenPath = (filePath): void => {
    if (!client.isConnected) {
      pendingOpenPaths.push(filePath);
      return;
    }
    focusExistingProjectWindow(window);
    emitCommandInvocation({
      commandId: PROJECT_COMMAND_IDS.openRecent,
      args: { filePath },
      source: "external-open",
    });
  };
  const initialPath = projectPathFromArgs(process.argv);
  if (initialPath) pendingOpenPaths.unshift(initialPath);
  if (client.isConnected) {
    for (const filePath of pendingOpenPaths.splice(0)) routeOpenPath(filePath);
  }

  app.on("window-all-closed", () => {
    client.close();
    // encerramento coordenado, ordem inversa da subida (engine → middleware)
    void (async () => {
      await recentsWrite.catch(() => undefined);
      await supervisor?.shutdown().catch(() => undefined);
      app.quit();
    })();
  });
});
