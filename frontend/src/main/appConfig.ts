/**
 * Configuração refinada do Electron (concentrada em UM módulo):
 *
 *  - instância única (requestSingleInstanceLock): a segunda instância sai e a
 *    primeira ganha foco — pré-requisito do lock por arquivo (P0.2);
 *  - persistência do estado da janela (bounds/maximização em userData);
 *  - hardening: sandbox + contextIsolation no renderer, navegação externa
 *    bloqueada, window.open negado, webviews proibidas.
 *
 * main.ts consome estas funções; nenhuma política vive lá.
 */

import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, type BrowserWindowConstructorOptions } from "electron";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1440, height: 900 };

function windowStateFile(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

export function loadWindowState(): WindowState {
  try {
    const raw = JSON.parse(fs.readFileSync(windowStateFile(), "utf8")) as Partial<WindowState>;
    if (
      typeof raw.width === "number" &&
      raw.width >= 640 &&
      typeof raw.height === "number" &&
      raw.height >= 480
    ) {
      return { ...DEFAULT_STATE, ...raw } as WindowState;
    }
  } catch {
    // primeiro uso / arquivo corrompido: defaults
  }
  return DEFAULT_STATE;
}

/** Persiste bounds/maximização ao mover/redimensionar (debounce) e ao fechar. */
export function trackWindowState(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = (): void => {
    try {
      const maximized = window.isMaximized();
      const bounds = maximized ? window.getNormalBounds() : window.getBounds();
      const state: WindowState = { ...bounds, maximized };
      fs.writeFileSync(windowStateFile(), JSON.stringify(state));
    } catch {
      // persistência de janela é best-effort
    }
  };
  const debounced = (): void => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  window.on("resize", debounced);
  window.on("move", debounced);
  window.on("maximize", debounced);
  window.on("unmaximize", debounced);
  window.on("close", save);
}

/** Opções endurecidas da BrowserWindow (o preload continua sendo a única ponte). */
export function hardenedWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  const state = loadWindowState();
  return {
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    title: "Gridsmith",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
    },
  };
}

/** Bloqueia navegação para fora do app e criação de janelas arbitrárias. */
export function hardenNavigation(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/**
 * Instância única: retorna false quando ESTA instância deve sair (outra já
 * roda); registra o foco da janela principal quando uma segunda tentar abrir.
 */
export function ensureSingleInstance(
  getWindow: () => BrowserWindow | undefined,
  onSecondInstance?: (argv: readonly string[], workingDirectory: string) => void,
): boolean {
  const isPrimary = app.requestSingleInstanceLock();
  if (!isPrimary) {
    app.quit();
    return false;
  }
  app.on("second-instance", (_event, argv, workingDirectory) => {
    const window = getWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    // a segunda instância morre, mas o ARGUMENTO dela não: abrir um .gridsmith.json
    // pelo gerenciador de arquivos com o app já aberto tem de abrir o projeto,
    // não só piscar a janela
    onSecondInstance?.(argv, workingDirectory);
  });
  return true;
}
