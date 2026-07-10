/**
 * Processo main do editor Electron.
 *
 * Papel: shell fina — conecta ao gateway do middleware (EditorClient), expõe
 * a API do editor ao renderer via IPC (preload/contextBridge) e repassa o
 * broadcast de eventos do Blueprint. NENHUMA lógica de domínio vive aqui:
 * comandos são despachados pelo caminho canônico do middleware, e o gating
 * de painéis vem da matriz de governança (experience/resolve).
 *
 * Uso: npm run app -- [--pipe <nome>]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, ipcMain } from "electron";
import { EditorClient } from "./EditorClient.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

function pipeNameFromArgs(): string {
  const index = process.argv.indexOf("--pipe");
  return index >= 0 ? process.argv[index + 1]! : "p7m-engine";
}

async function createWindow(client: EditorClient): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "P7M Editor",
    webPreferences: {
      preload: path.join(dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  client.onBlueprintEvent((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send("p7m:blueprint-event", event);
    }
  });

  await window.loadFile(path.join(dirname, "../renderer/index.html"));
  return window;
}

void app.whenReady().then(async () => {
  const client = new EditorClient(pipeNameFromArgs());

  ipcMain.handle("p7m:connect", async () => client.connect());
  ipcMain.handle("p7m:dispatch", (_event, kind: string, payload: Record<string, unknown>) =>
    client.dispatch(kind, payload),
  );
  ipcMain.handle("p7m:query", (_event, projection: string) => client.query(projection));
  ipcMain.handle("p7m:experience", (_event, family?: string, version?: string) =>
    client.resolveExperience(family, version),
  );

  await createWindow(client);

  app.on("window-all-closed", () => {
    client.close();
    app.quit();
  });
});
