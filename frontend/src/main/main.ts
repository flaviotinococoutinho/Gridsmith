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
import { ProjectLifecycle, type ProjectDescriptor } from "../core/projectLifecycle.js";
import {
  ProcessSupervisor,
  type ManagedProcess,
  type ServiceReadiness,
  type ServiceStatus,
} from "./ProcessSupervisor.js";
import { EditorClient } from "./EditorClient.js";
import {
  ensureSingleInstance,
  hardenNavigation,
  hardenedWindowOptions,
  loadWindowState,
  trackWindowState,
} from "./appConfig.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_FILTER = [{ name: "Projeto P7M", extensions: ["p7m.json"] }];

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

function loadRecents(): [] {
  try {
    return JSON.parse(fs.readFileSync(recentsFile(), "utf8"));
  } catch {
    return [];
  }
}

interface ProjectStatusPayload {
  state: string;
  windowTitle: string;
  isDirty: boolean;
  project?: { filePath?: string; name: string };
  recents: readonly unknown[];
}

function statusOf(lifecycle: ProjectLifecycle): ProjectStatusPayload {
  return {
    state: lifecycle.currentState,
    windowTitle: lifecycle.windowTitle,
    isDirty: lifecycle.isDirty,
    ...(lifecycle.project !== undefined ? { project: lifecycle.project } : {}),
    recents: lifecycle.recentProjects,
  };
}

let mainWindow: BrowserWindow | undefined;

void app.whenReady().then(async () => {
  // instância única: a segunda sai; a primeira ganha foco (appConfig.ts)
  if (!ensureSingleInstance(() => mainWindow)) return;

  const pipeName = pipeNameFromArgs();
  const externalServices = process.argv.includes("--external-services");
  // Em produção, o segredo vive somente no main e no ambiente do filho. No
  // modo externo, o operador fornece a mesma credencial por env/arquivo.
  const authToken = externalServices
    ? loadTransportAuthToken()
    : generateTransportAuthToken();
  const client = new EditorClient(pipeName, { authToken });
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
      window.webContents.send("p7m:service-status", serviceStatusPayload());
    }
  });

  const broadcast = (): void => {
    if (window && !window.isDestroyed()) {
      window.setTitle(lifecycle.windowTitle);
      window.webContents.send("p7m:project-status", statusOf(lifecycle));
    }
    fs.writeFileSync(recentsFile(), JSON.stringify(lifecycle.recentProjects));
  };
  lifecycle.onEvent(() => broadcast());

  const writeDocument = async (filePath: string): Promise<void> => {
    const document = await client.saveDocument();
    fs.writeFileSync(filePath, JSON.stringify(document, null, 2));
  };

  // Autosave: limiar de comandos (via commandApplied) + intervalo (tick)
  const autosave = async (): Promise<void> => {
    const filePath = lifecycle.project?.filePath;
    if (!filePath) return; // projeto ainda sem arquivo: autosave aguarda Save As
    try {
      const document = await client.saveDocument();
      fs.writeFileSync(`${filePath}.autosave`, JSON.stringify(document));
    } catch {
      // autosave é best-effort; o save explícito reporta erros
    }
  };
  setInterval(() => {
    if (lifecycle.autosaveTick()) void autosave();
  }, 5_000).unref();

  const projectCommand = async (
    command: "new" | "open" | "openPath" | "save" | "saveAs" | "close",
    payload?: { filePath?: string },
  ): Promise<ProjectStatusPayload> => {
    switch (command) {
      case "new": {
        lifecycle.beginOpen();
        lifecycle.opened({ name: "Projeto sem título" });
        break;
      }
      case "open":
      case "openPath": {
        let filePath = payload?.filePath;
        if (command === "open") {
          const picked = await dialog.showOpenDialog(window, {
            title: "Abrir projeto P7M",
            filters: PROJECT_FILTER,
            properties: ["openFile"],
          });
          if (picked.canceled || picked.filePaths.length === 0) break;
          filePath = picked.filePaths[0]!;
        }
        if (!filePath) break;
        lifecycle.beginOpen();
        try {
          const document: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
          await client.loadDocument(document);
          const descriptor: ProjectDescriptor = {
            filePath,
            name: path.basename(filePath).replace(/\.p7m\.json$/, ""),
          };
          lifecycle.opened(descriptor);
        } catch (err) {
          lifecycle.openFailed();
          throw err;
        }
        break;
      }
      case "save":
      case "saveAs": {
        let filePath = command === "save" ? lifecycle.project?.filePath : undefined;
        if (!filePath) {
          const picked = await dialog.showSaveDialog(window, {
            title: "Salvar projeto P7M",
            filters: PROJECT_FILTER,
            defaultPath: `${lifecycle.project?.name ?? "projeto"}.p7m.json`,
          });
          if (picked.canceled || !picked.filePath) break;
          filePath = picked.filePath;
        }
        lifecycle.beginSave();
        try {
          await writeDocument(filePath);
          lifecycle.saved(filePath);
        } catch (err) {
          lifecycle.saveFailed();
          throw err;
        }
        break;
      }
      case "close": {
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
          } else {
            if (response === 0) {
              const filePath = lifecycle.project?.filePath;
              if (filePath) await writeDocument(filePath);
            }
            lifecycle.confirmClose();
          }
        }
        break;
      }
    }
    return statusOf(lifecycle);
  };

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
  ipcMain.handle("p7m:dispatch", (_event, kind: string, payload: Record<string, unknown>) =>
    client.dispatch(kind, payload),
  );
  ipcMain.handle("p7m:query", (_event, projection: string) => client.query(projection));
  ipcMain.handle("p7m:experience", (_event, family?: string, version?: string) =>
    client.resolveExperience(family, version),
  );
  ipcMain.handle("p7m:project-command", (_event, command, payload) =>
    projectCommand(command, payload),
  );
  ipcMain.handle("p7m:project-status", () => statusOf(lifecycle));

  // Configuração refinada do Electron (appConfig.ts): janela endurecida
  // (sandbox, navegação bloqueada), estado persistido entre sessões
  window = new BrowserWindow(hardenedWindowOptions(path.join(dirname, "preload.js")));
  mainWindow = window;
  if (loadWindowState().maximized) window.maximize();
  trackWindowState(window);
  hardenNavigation(window);

  // Menu nativo com atalhos (ALPHA-0.1 P0.3): projeto no main, edição no renderer
  const sendMenuAction = (action: "undo" | "redo") => (): void => {
    if (!window.isDestroyed()) window.webContents.send("p7m:menu-action", action);
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

  client.onBlueprintEvent((event) => {
    // dirty tracking: todo evento do Blueprint suja o documento aberto
    if (lifecycle.commandApplied()) void autosave();
    if (!window.isDestroyed()) {
      window.webContents.send("p7m:blueprint-event", event);
    }
  });
  client.onResynchronized((snapshot, record) => {
    if (!window.isDestroyed()) {
      window.webContents.send("p7m:projection-resync", { snapshot, record });
    }
  });

  await window.loadFile(path.join(dirname, "../renderer/index.html"));
  broadcast();
  window.webContents.send("p7m:service-status", serviceStatusPayload());

  app.on("window-all-closed", () => {
    client.close();
    // encerramento coordenado, ordem inversa da subida (engine → middleware)
    const finish = (): void => app.quit();
    if (supervisor) void supervisor.shutdown().then(finish, finish);
    else finish();
  });
});
