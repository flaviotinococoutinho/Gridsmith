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
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain } from "electron";
import { resolvePipePath } from "@p7m/middleware/dist/ipc/PipeEndpoint.js";
import { ProjectLifecycle, type ProjectDescriptor } from "../core/projectLifecycle.js";
import {
  ProcessSupervisor,
  type ManagedProcess,
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
  env?: Record<string, string>,
): ManagedProcess {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
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

/** Prontidão do middleware: o pipe do gateway aceita conexão. */
async function gatewayAccepts(pipeName: string, timeoutMs = 15_000): Promise<boolean> {
  const target = resolvePipePath(`${pipeName}-editor`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = net.connect(target);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function buildSupervisor(pipeName: string, client: EditorClient): ProcessSupervisor {
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
          { ELECTRON_RUN_AS_NODE: "1" },
        ),
      waitReady: () => gatewayAccepts(pipeName),
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
  const client = new EditorClient(pipeName);
  const lifecycle = new ProjectLifecycle(Date.now, {}, loadRecents());
  let window: BrowserWindow;

  // P0.1: por padrão o Electron é o supervisor do ecossistema (executável
  // único); --external-services preserva o modo dev com serviços próprios
  const externalServices = process.argv.includes("--external-services");
  const supervisor = externalServices ? undefined : buildSupervisor(pipeName, client);
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
