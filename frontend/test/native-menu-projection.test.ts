import assert from "node:assert/strict";
import { test } from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import { ALL_CAPABILITIES } from "../src/core/capabilityRegistry.js";
import { CommandRegistry } from "../src/core/commandRegistry.js";
import { projectNativeMenuCommands } from "../src/core/nativeMenuProjection.js";
import { SelectionService } from "../src/core/selectionService.js";
import {
  buildNativeMenuTemplate,
  defaultNativeMenuCommands,
  validateNativeMenuCommandDescriptors,
} from "../src/main/nativeMenuHost.js";

test("projeção de menu converte placement/chord sem callbacks", () => {
  const registry = new CommandRegistry();
  registry.register({
    id: "project.save",
    label: "Salvar projeto",
    requiredCapabilities: [],
    placements: [
      { surface: "menu", path: ["Arquivo", "Salvar"], order: 20 },
      { surface: "shortcut", chord: "CtrlOrMeta+Shift+S" },
    ],
    enableWhen: () => ({ enabled: false, reason: "Aguarde o commit atual." }),
    execute: () => undefined,
  });
  const context = {
    selection: new SelectionService(),
    capabilities: ALL_CAPABILITIES,
    mode: "edit",
  };

  const projected = projectNativeMenuCommands(
    registry.list("menu", context, { includeDisabled: true }),
    registry.list("shortcut", context, { includeDisabled: true }),
  );
  assert.deepEqual(projected, [{
    id: "project.save",
    label: "Salvar projeto",
    menuPath: ["Arquivo", "Salvar"],
    order: 20,
    accelerator: "CmdOrCtrl+Shift+S",
    enabled: false,
    reason: "Aguarde o commit atual.",
  }]);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected[0]!.menuPath), true);
});

test("boundary de menu normaliza accelerator e rejeita shape não allowlisted atomicamente", () => {
  const validated = validateNativeMenuCommandDescriptors([{
    id: "history.undo",
    label: "Desfazer",
    menuPath: ["Editar", "Desfazer"],
    order: 5,
    accelerator: "CtrlOrMeta+z",
    enabled: true,
  }]);
  assert.equal(validated[0]?.accelerator, "CmdOrCtrl+Z");
  assert.equal(Object.isFrozen(validated), true);

  assert.throws(() => validateNativeMenuCommandDescriptors([{
    id: "history.undo",
    label: "Desfazer",
    menuPath: ["Editar", "Desfazer"],
    enabled: true,
    role: "quit",
  }]), /non-allowlisted field/);
  assert.throws(() => validateNativeMenuCommandDescriptors([{
    id: "unsafe",
    label: "Injetar",
    menuPath: ["Arquivo", "Recentes", "Injetar"],
    enabled: true,
  }]), /menuPath|Recentes/);
  assert.throws(() => validateNativeMenuCommandDescriptors([
    { id: "one", label: "Um", menuPath: ["Arquivo", "Um"], accelerator: "Ctrl+S", enabled: true },
    { id: "two", label: "Dois", menuPath: ["Arquivo", "Dois"], accelerator: "Ctrl+S", enabled: true },
  ]), /accelerator .* duplicated/);
});

test("main materializa hierarquia genérica, Recentes e roles sem executar domínio", () => {
  const invocations: unknown[] = [];
  const opened: string[] = [];
  let closeRequested = false;
  const commands = validateNativeMenuCommandDescriptors([
    {
      id: "project.new",
      label: "Novo projeto…",
      menuPath: ["Arquivo", "Novo projeto"],
      order: 0,
      accelerator: "CmdOrCtrl+N",
      enabled: true,
    },
    {
      id: "project.openRecent",
      label: "Recentes",
      menuPath: ["Arquivo", "Recentes"],
      order: 10,
      enabled: true,
    },
    {
      id: "history.undo",
      label: "Desfazer",
      menuPath: ["Editar", "Desfazer"],
      accelerator: "CmdOrCtrl+Z",
      enabled: true,
    },
    {
      id: "diagnostics.dump",
      label: "Copiar diagnóstico",
      menuPath: ["Ferramentas", "Diagnóstico", "Copiar diagnóstico"],
      order: 3,
      enabled: false,
      reason: "Serviço indisponível.",
    },
  ]);
  const template = buildNativeMenuTemplate({
    commands,
    recentProjects: [{ name: "Projeto A", filePath: "/tmp/a.p7m.json" }],
    recentCommandId: "project.openRecent",
    invoke: (invocation) => invocations.push(invocation),
    openRecent: (filePath) => opened.push(filePath),
    requestClose: () => { closeRequested = true; },
  });

  const file = root(template, "Arquivo");
  click(item(file, "Novo projeto…"));
  const recents = submenu(item(file, "Recentes"));
  click(item(recents, "Projeto A"));
  click(item(file, "Sair"));
  assert.deepEqual(invocations, [{ commandId: "project.new" }]);
  assert.deepEqual(opened, ["/tmp/a.p7m.json"]);
  assert.equal(closeRequested, true);

  const tools = root(template, "Ferramentas");
  const diagnostics = submenu(item(tools, "Diagnóstico"));
  const disabled = item(diagnostics, "Copiar diagnóstico");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.toolTip, "Serviço indisponível.");

  const view = root(template, "Exibir");
  assert.deepEqual(
    view.filter(({ role }) => role).map(({ role }) => role),
    ["toggleDevTools", "resetZoom", "zoomIn", "zoomOut"],
  );
  assert.equal(item(root(template, "Editar"), "Desfazer").registerAccelerator, false);
});

test("fallback nativo preserva todos os comandos antes do wiring do renderer", () => {
  const commands = defaultNativeMenuCommands({
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
  assert.equal(commands.length, 9);
  assert.equal(commands.find(({ id }) => id === "history.undo")?.accelerator, "CmdOrCtrl+Z");
});

test("macOS deixa undo/redo textual chegar ao renderer antes do histórico global", () => {
  const commands = defaultNativeMenuCommands({
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
  const template = buildNativeMenuTemplate({
    commands,
    recentProjects: [],
    recentCommandId: "project.openRecent",
    platform: "darwin",
    invoke: () => undefined,
    openRecent: () => undefined,
    requestClose: () => undefined,
  });

  assert.equal(item(root(template, "Editar"), "Desfazer").accelerator, undefined);
  assert.equal(item(root(template, "Editar"), "Refazer").accelerator, undefined);
  assert.equal(item(root(template, "Arquivo"), "Salvar").accelerator, "CmdOrCtrl+S");
});

function root(
  template: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  return submenu(item(template, label));
}

function item(
  items: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions {
  const found = items.find((candidate) => candidate.label === label);
  assert.ok(found, `missing menu item ${label}`);
  return found;
}

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  assert.ok(Array.isArray(item.submenu), `menu item ${item.label} has no array submenu`);
  return item.submenu;
}

function click(item: MenuItemConstructorOptions): void {
  assert.ok(item.click, `menu item ${item.label} has no click callback`);
  item.click(undefined as never, undefined, undefined as never);
}
