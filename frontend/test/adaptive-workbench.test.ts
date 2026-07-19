import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CommandRegistry } from "../src/core/commandRegistry.js";
import type { ContributionContext } from "../src/core/contributionContext.js";
import { SelectionService } from "../src/core/selectionService.js";
import {
  clampContextMenuPosition,
  CommandPaletteView,
  ContextCommandMenuView,
} from "../src/renderer/commandViews.js";
import { canReusePanelInstance } from "../src/renderer/panelHost.js";
import { treeItemReflectsSelection } from "../src/renderer/projectExplorerPanel.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("workbench adaptativo: renderer.ts é somente composition root", () => {
  const renderer = source("src/renderer/renderer.ts");
  assert.match(renderer, /new EditorWorkbenchApplication/);
  assert.match(renderer, /registerBuiltinContributions/);
  assert.match(renderer, /routeGlobalEditorEvents/);
  assert.doesNotMatch(renderer, /if\s*\(|switch\s*\(|level\.editor|diagnostics\.problems|pencil|eraser/);
  assert.ok(renderer.split(/\r?\n/).length < 45);
});

test("workbench adaptativo: todos os tools do MVP são contribuições internas", () => {
  const contributions = source("src/renderer/builtinContributions.ts");
  for (const kind of [
    "selection", "pencil", "eraser", "line", "rectangle", "flood", "picker",
    "entity", "camera", "light", "spawn", "trigger",
  ]) {
    assert.match(contributions, new RegExp(`(?:kind:\\s*"${kind}"|"${kind}"\\s*,)`), kind);
  }
  assert.match(contributions, /application\.tools\.register/);
  assert.doesNotMatch(source("src/renderer/renderer.ts"), /ToolRegistry|toolRegistry/);
});

test("workbench adaptativo: refresh contextual preserva painel; troca de sessão força instância nova", () => {
  assert.equal(canReusePanelInstance("level.editor", "session-a", "level.editor", "session-a", true), true);
  assert.equal(canReusePanelInstance("level.editor", "session-a", "level.editor", "session-b", true), false);
  assert.equal(canReusePanelInstance("level.editor", "session-a", "project.start", undefined, true), false);
  assert.equal(canReusePanelInstance("level.editor", "session-a", "level.editor", "session-a", false), false);
});

test("workbench adaptativo: canvas delega tools e comunica seleção/cores sem depender só de cor", () => {
  const levelView = source("src/renderer/levelEditorView.ts");
  assert.match(levelView, /toolRegistry\.list\(/);
  assert.match(levelView, /toolRegistry\.activeInstance/);
  assert.doesNotMatch(levelView, /if\s*\(tool\s*===|switch\s*\(tool/);
  assert.match(levelView, /selection\.select\(\{[\s\S]*kind:\s*"cell"/);
  assert.match(levelView, /selection\.select\(\{[\s\S]*kind:\s*"entity-instance"/);
  assert.match(levelView, /palette-value-label/);
  assert.match(levelView, /aria-label.*entry\.value|aria-label", `\$\{entry\.value\}/);
});

test("workbench adaptativo: estrutura e navegação por teclado cobrem todas as regiões", () => {
  const html = source("src/renderer/index.html");
  const shell = source("src/renderer/workbenchShell.ts");
  const commands = source("src/renderer/commandViews.ts");
  for (const region of ["left", "center", "right", "bottom"]) {
    assert.match(html, new RegExp(`data-workbench-region="${region}"`));
  }
  assert.match(html, /id="context-toolbar"[\s\S]*role="toolbar"/);
  assert.match(html, /id="status-bar"/);
  assert.match(shell, /ArrowLeft|ArrowRight/);
  assert.match(shell, /Home/);
  assert.match(shell, /End/);
  assert.match(shell, /Escape/);
  assert.match(commands, /Paleta de comandos/);
  assert.match(source("src/renderer/builtinContributions.ts"), /CtrlOrMeta\+Shift\+P/);
  assert.match(commands, /ArrowDown/);
  assert.match(shell, /event\.key !== "F6"/);
  assert.doesNotMatch(source("src/renderer/workbenchApplication.ts"), /event\.key === "F6"/);
  assert.match(
    source("src/renderer/workbenchApplication.ts"),
    /resolveWorkbenchShellElements\(this\.environment\.document\)/,
  );
});

test("workbench adaptativo: menu contextual permanece dentro do viewport", () => {
  assert.deepEqual(clampContextMenuPosition(990, 790, 240, 180, 1_000, 800), {
    left: 752,
    top: 612,
  });
  assert.deepEqual(clampContextMenuPosition(1, 2, 100, 80, 1_000, 800), {
    left: 8,
    top: 8,
  });
});

test("workbench adaptativo: árvore, inspector e bottom são montados pelo PanelRegistry", () => {
  const contributions = source("src/renderer/builtinContributions.ts");
  assert.match(contributions, /mountProjectExplorer/);
  assert.match(contributions, /mountSchemaInspector/);
  assert.match(contributions, /mountProblemsPanel/);
  assert.match(contributions, /mountOutputPanel/);
  assert.match(contributions, /mountHistoryPanel/);
  assert.match(contributions, /mountPerformancePanel/);
  assert.doesNotMatch(source("src/renderer/workbenchApplication.ts"), /if\s*\(panel|switch\s*\(panel/);
});

test("workbench adaptativo: seleção de célula mantém o nível ancestral ativo na árvore", () => {
  const scope = { projectSessionId: "session-a", projectId: "project-a" } as const;
  assert.equal(treeItemReflectsSelection({
    kind: "cell",
    ...scope,
    levelId: "level-1",
    cells: [{ x: 3, y: 4, index: 35 }],
  }, {
    kind: "level",
    ...scope,
    levelId: "level-1",
  }), true);
  assert.equal(treeItemReflectsSelection({
    kind: "cell",
    ...scope,
    levelId: "level-1",
    cells: [{ x: 3, y: 4 }],
  }, {
    kind: "level",
    ...scope,
    levelId: "level-2",
  }), false);
});

test("workbench adaptativo: menu nativo e Close drenam drafts pelo mesmo catálogo", () => {
  const application = source("src/renderer/workbenchApplication.ts");
  const contributions = source("src/renderer/builtinContributions.ts");
  assert.match(application, /projectNativeMenuCommands\(/);
  assert.match(application, /this\.api\.updateNativeMenu\(descriptors\)/);
  assert.match(application, /api\.onProjectClosePreflight\(\(\) => application\.prepareProjectClose\(\)\)/);
  assert.match(application, /activeElement\.blur\(\)[\s\S]*?pendingEdits\.flush\(\)/);
  for (const command of [
    "new", "open", "openExample", "openRecent", "save", "saveAs", "close", "undo", "redo",
  ]) {
    const registration = new RegExp(
      `id:\\s*PROJECT_COMMAND_IDS\\.${command},[\\s\\S]*?commitEditorDrafts:\\s*true,[\\s\\S]*?execute:`,
    );
    assert.match(contributions, registration, command);
  }
  assert.match(contributions, /workbench\.toggleProjectTree/);
  assert.match(contributions, /workbench\.toggleInspector/);
  assert.match(contributions, /workbench\.toggleBottom/);
  assert.match(contributions, /workbench\.restoreLayout/);
  assert.match(application, /host\.inert = busy/);
  assert.match(application, /ExternalOpenIntentQueue/);
  assert.match(application, /selectedLevelId\(this\.selection\.current\) \?\? this\.activeLevelId/);
  assert.match(application, /reconcileSelectionsWithLevelProjection\(selections, snapshot\)/);
  assert.match(application, /this\.externalOpenIntents\.enqueue\(filePath\)/);
  assert.match(application, /this\.externalOpenIntents\.retry\(\)/);
  assert.match(application, /trackPendingEdit<T>/);
});

test("workbench adaptativo: palette mantém aria-activedescendant durante busca e navegação", async () => {
  const dom = installFakeDom();
  try {
    const registry = commandRegistry([
      { id: "command.alpha", label: "Alpha", surface: "command-palette" },
      { id: "command.beta", label: "Beta", surface: "command-palette" },
    ]);
    const trigger = dom.document.createElement("button");
    dom.document.body.append(trigger);
    trigger.focus();

    const palette = new CommandPaletteView({ registry, context: contributionContext });
    palette.open();
    const input = dom.document.body.querySelector("input")!;
    const options = dom.document.body.querySelectorAll("[role='option']");

    assert.equal(dom.document.activeElement, input);
    assert.equal(input.getAttribute("role"), "combobox");
    assert.equal(input.getAttribute("aria-activedescendant"), options[0]?.id);
    assert.equal(options[0]?.getAttribute("aria-selected"), "true");

    input.dispatch("keydown", { key: "ArrowDown" });
    assert.equal(input.getAttribute("aria-activedescendant"), options[1]?.id);
    assert.equal(options[1]?.getAttribute("aria-selected"), "true");

    input.value = "sem resultado";
    input.dispatch("input");
    assert.equal(input.hasAttribute("aria-activedescendant"), false);

    palette.close();
    assert.equal(dom.document.activeElement, trigger);
    await Promise.resolve();
  } finally {
    dom.restore();
  }
});

test("workbench adaptativo: menu contextual persiste após item desabilitado e restaura foco", async () => {
  const dom = installFakeDom();
  try {
    const registry = commandRegistry([
      {
        id: "command.disabled",
        label: "Indisponível",
        surface: "context-menu",
        enabled: false,
      },
      { id: "command.enabled", label: "Disponível", surface: "context-menu" },
    ]);
    const trigger = dom.document.createElement("button");
    const outside = dom.document.createElement("button");
    dom.document.body.append(trigger, outside);
    trigger.focus();
    const menuView = new ContextCommandMenuView({ registry, context: contributionContext });

    assert.equal(menuView.open(mouseEvent()), true);
    await Promise.resolve();
    const menu = dom.document.body.querySelector("[role='menu']")!;
    const items = menu.querySelectorAll("button");
    assert.equal(dom.document.activeElement, items[0]);

    menu.dispatch("keydown", { key: "End" });
    assert.equal(dom.document.activeElement, items[1]);
    menu.dispatch("keydown", { key: "Home" });
    assert.equal(dom.document.activeElement, items[0]);
    menu.dispatch("keydown", { key: "ArrowUp" });
    assert.equal(dom.document.activeElement, items[1]);
    menu.dispatch("keydown", { key: "ArrowDown" });
    assert.equal(dom.document.activeElement, items[0]);

    const disabled = items.find((item) => item.getAttribute("aria-disabled") === "true")!;
    dom.document.dispatch("pointerdown", { target: disabled });
    disabled.click();
    assert.equal(dom.document.body.contains(menu), true);
    assert.equal(menu.querySelector("[role='status']")?.textContent, "Indisponível no teste.");
    assert.equal(dom.document.listenerCount("pointerdown"), 1);

    dom.document.dispatch("pointerdown", { target: outside });
    assert.equal(dom.document.body.contains(menu), false);
    assert.equal(dom.document.listenerCount("pointerdown"), 0);
    assert.equal(dom.document.activeElement, trigger);

    assert.equal(menuView.open(mouseEvent()), true);
    await Promise.resolve();
    const reopened = dom.document.body.querySelector("[role='menu']")!;
    reopened.dispatch("keydown", { key: "Escape" });
    assert.equal(dom.document.body.contains(reopened), false);
    assert.equal(dom.document.activeElement, trigger);

    assert.equal(menuView.open(mouseEvent()), true);
    await Promise.resolve();
    const tabbed = dom.document.body.querySelector("[role='menu']")!;
    tabbed.dispatch("keydown", { key: "Tab" });
    assert.equal(dom.document.body.contains(tabbed), false);
    assert.equal(dom.document.activeElement, trigger);
  } finally {
    dom.restore();
  }
});

interface TestCommand {
  readonly id: string;
  readonly label: string;
  readonly surface: "command-palette" | "context-menu";
  readonly enabled?: boolean;
}

function commandRegistry(commands: readonly TestCommand[]): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of commands) {
    registry.register({
      id: command.id,
      label: command.label,
      requiredCapabilities: [],
      placements: [{ surface: command.surface }],
      ...(command.enabled === false
        ? { enableWhen: () => ({ enabled: false, reason: "Indisponível no teste." }) }
        : {}),
      execute: () => undefined,
    });
  }
  return registry;
}

function contributionContext(): ContributionContext {
  const selection = new SelectionService("session-a");
  selection.select({
    kind: "project",
    projectSessionId: "session-a",
    projectId: "project-a",
  });
  return {
    selection,
    capabilities: () => ({ enabled: true }),
    mode: "edit",
  };
}

function mouseEvent(): MouseEvent {
  return {
    clientX: 12,
    clientY: 24,
    preventDefault: () => undefined,
  } as MouseEvent;
}

interface FakeDispatchInit {
  readonly key?: string;
  readonly target?: FakeNode;
}

class FakeEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    readonly target: FakeNode,
    readonly key?: string,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type FakeListener = (event: FakeEvent) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Array<{ listener: FakeListener; once: boolean }>>();

  addEventListener(
    type: string,
    listener: FakeListener,
    options?: boolean | { readonly once?: boolean },
  ): void {
    const once = typeof options === "object" && options.once === true;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, once });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    this.listeners.set(type, listeners.filter((entry) => entry.listener !== listener));
  }

  protected emit(type: string, target: FakeNode, init: FakeDispatchInit = {}): FakeEvent {
    const event = new FakeEvent(type, init.target ?? target, init.key);
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      entry.listener(event);
      if (entry.once) this.removeEventListener(type, entry.listener);
    }
    return event;
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

class FakeNode extends FakeEventTarget {
  parentElement: FakeElement | undefined;
}

class FakeElement extends FakeNode {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  id = "";
  role = "";
  className = "";
  textContent = "";
  title = "";
  type = "";
  value = "";
  placeholder = "";
  tabIndex = 0;
  open = false;

  constructor(readonly tagName: string, private readonly owner: FakeDocument) {
    super();
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.textContent += node;
        continue;
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parentElement = undefined;
    this.children.splice(0);
    this.append(...nodes);
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = undefined;
  }

  contains(node: FakeNode): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "role") this.role = value;
  }

  getAttribute(name: string): string | null {
    if (name === "role" && this.role) return this.role;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return name === "role" ? Boolean(this.role) : this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "role") this.role = "";
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]);
    return descendants.filter((candidate) => matchesSelector(candidate, selector));
  }

  focus(): void {
    this.owner.activeElement = this;
  }

  click(): void {
    this.dispatch("click");
  }

  dispatch(type: string, init: FakeDispatchInit = {}): FakeEvent {
    return this.emit(type, this, init);
  }

  scrollIntoView(): void {}

  showModal(): void {
    this.open = true;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }
}

class FakeDocument extends FakeNode {
  readonly body: FakeElement;
  activeElement: FakeElement;

  constructor() {
    super();
    this.body = new FakeElement("body", this);
    this.activeElement = this.body;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase(), this);
  }

  dispatch(type: string, init: FakeDispatchInit = {}): FakeEvent {
    return this.emit(type, this, init);
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector === "button" || selector === "input") return element.tagName === selector;
  const role = selector.match(/^\[role=['"](.+)['"]\]$/)?.[1];
  return role !== undefined && element.role === role;
}

function installFakeDom(): { readonly document: FakeDocument; restore(): void } {
  const fakeDocument = new FakeDocument();
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of [
    ["document", fakeDocument],
    ["Node", FakeNode],
    ["HTMLElement", FakeElement],
  ] as const) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return {
    document: fakeDocument,
    restore(): void {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
