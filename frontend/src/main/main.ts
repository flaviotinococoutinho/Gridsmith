/**
 * Processo main do editor Electron.
 *
 * Papel: shell fina + dono do CICLO DE VIDA DO PROJETO (ALPHA-0.1 P0.2) —
 * New/Open/Save/Save As/Close com diálogos nativos, dirty tracking por
 * eventos do Blueprint, autosave e recentes. NENHUMA lógica de domínio vive
 * aqui: comandos são despachados pelo caminho canônico do middleware
 * (EditorClient) e a verdade do documento vive na ProjectLifecycle (pura).
 *
 * Uso: npm run app -- [--pipe <nome>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, dialog, ipcMain } from "electron";
import { ProjectLifecycle, type ProjectDescriptor } from "../core/projectLifecycle.js";
import { EditorClient } from "./EditorClient.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_FILTER = [{ name: "Projeto P7M", extensions: ["p7m.json"] }];

function pipeNameFromArgs(): string {
  const index = process.argv.indexOf("--pipe");
  return index >= 0 ? process.argv[index + 1]! : "p7m-engine";
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

void app.whenReady().then(async () => {
  const client = new EditorClient(pipeNameFromArgs());
  const lifecycle = new ProjectLifecycle(Date.now, {}, loadRecents());
  let window: BrowserWindow;

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

  ipcMain.handle("p7m:connect", async () => client.connect());
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

  window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "P7M",
    webPreferences: {
      preload: path.join(dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  client.onBlueprintEvent((event) => {
    // dirty tracking: todo evento do Blueprint suja o documento aberto
    if (lifecycle.commandApplied()) void autosave();
    if (!window.isDestroyed()) {
      window.webContents.send("p7m:blueprint-event", event);
    }
  });

  await window.loadFile(path.join(dirname, "../renderer/index.html"));
  broadcast();

  app.on("window-all-closed", () => {
    client.close();
    app.quit();
  });
});
