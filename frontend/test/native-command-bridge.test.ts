import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROJECT_COMMAND_IDS,
  type ProjectCommandInvocation,
} from "../src/core/projectApi.js";

const FRONTEND_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relativePath: string): string =>
  fs.readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");

test("menu nativo publica command ids estáveis e uma invocação extensível", () => {
  assert.deepEqual(PROJECT_COMMAND_IDS, {
    new: "project.new",
    open: "project.open",
    openExample: "project.openExample",
    openRecent: "project.openRecent",
    save: "project.save",
    saveAs: "project.saveAs",
    close: "project.close",
    undo: "history.undo",
    redo: "history.redo",
  });

  const extension: ProjectCommandInvocation<{ readonly source: string }> = {
    commandId: "future.internalCommand",
    args: { source: "native-shell" },
  };
  assert.equal(extension.commandId, "future.internalCommand");
});

test("menus de projeto, histórico e recentes só encaminham ao CommandRegistry", () => {
  const main = source("src/main/main.ts");
  const menuStart = main.indexOf("  rebuildMenu = (): void => {");
  const menuEnd = main.indexOf("\n  rebuildMenu();", menuStart);
  assert.ok(menuStart >= 0 && menuEnd > menuStart);
  const menu = main.slice(menuStart, menuEnd);

  for (const property of Object.keys(PROJECT_COMMAND_IDS)) {
    assert.match(menu, new RegExp(`PROJECT_COMMAND_IDS\\.${property}\\b`));
  }
  assert.doesNotMatch(menu, /click:\s*[^\n]*controller\./);
  assert.match(
    menu,
    /PROJECT_COMMAND_IDS\.openRecent,[\s\S]*?args:\s*\{\s*filePath:\s*recent\.filePath\s*\}/,
  );

  const routeStart = main.indexOf("  routeOpenPath = (filePath): void => {");
  const routeEnd = main.indexOf("\n  const initialPath", routeStart);
  const route = main.slice(routeStart, routeEnd);
  assert.match(route, /PROJECT_COMMAND_IDS\.openRecent/);
  assert.match(route, /args:\s*\{\s*filePath\s*\}/);
  assert.doesNotMatch(route, /controller\.openRecent/);
});

test("preload preserva a invocação tipada sem interpretar command ids", () => {
  const preload = source("src/main/preload.ts");
  assert.match(
    preload,
    /onMenuAction\(listener:\s*\(invocation:\s*ProjectCommandInvocation\)\s*=>\s*void\)/,
  );
  assert.match(
    preload,
    /ipcRenderer\.on\("p7m:menu-action",\s*\(_event, invocation\)\s*=>\s*listener\(invocation\)\)/,
  );
  assert.doesNotMatch(preload, /commandId\s*===|switch\s*\(.*commandId/);
});
