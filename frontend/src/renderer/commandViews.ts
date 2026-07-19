/** DOM adapters for the command catalog. Command semantics stay in CommandRegistry. */

import {
  CommandRegistry,
  type CommandSurface,
  type PlacedCommand,
} from "../core/commandRegistry.js";
import type { ContributionContext } from "../core/contributionContext.js";

export interface CommandSurfaceViewOptions {
  readonly host: HTMLElement;
  readonly surface: CommandSurface;
  readonly registry: CommandRegistry;
  readonly context: () => ContributionContext;
  readonly group?: string;
  readonly onError?: (error: unknown) => void;
}

export class CommandSurfaceView {
  private readonly release: () => void;

  constructor(private readonly options: CommandSurfaceViewOptions) {
    this.release = options.registry.onDidChange(() => this.render());
    this.render();
  }

  render(): void {
    const { host, registry, surface, group } = this.options;
    const hadFocus = host.contains(document.activeElement);
    const previousButtons = [...host.querySelectorAll<HTMLButtonElement>("[data-command-id]")];
    const focusedCommandId = hadFocus
      ? (document.activeElement as HTMLElement).dataset["commandId"]
      : undefined;
    const focusedIndex = hadFocus
      ? Math.max(0, previousButtons.indexOf(document.activeElement as HTMLButtonElement))
      : 0;
    const commands = registry.list(surface, this.options.context(), {
      includeDisabled: true,
      ...(group ? { group } : {}),
    });
    host.replaceChildren(...commands.map((command) => this.commandButton(command)));
    wireRovingToolbar(host);
    if (hadFocus) {
      const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-command-id]")];
      const focused = buttons
        .find((candidate) => candidate.dataset["commandId"] === focusedCommandId);
      const fallback = buttons[Math.min(focusedIndex, Math.max(0, buttons.length - 1))];
      const target = focused ?? fallback;
      if (target) {
        buttons.forEach((candidate) => { candidate.tabIndex = candidate === target ? 0 : -1; });
        target.focus();
      } else {
        if (host.tabIndex < 0) host.tabIndex = -1;
        host.focus();
      }
    }
  }

  dispose(): void {
    this.release();
    this.options.host.replaceChildren();
  }

  private commandButton(command: PlacedCommand): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset["commandId"] = command.contribution.id;
    const compact = command.placement.surface === "toolbar"
      ? command.placement.compactLabel
      : undefined;
    button.textContent = compact ?? command.contribution.label;
    button.setAttribute("aria-disabled", String(!command.enabled));
    if (command.contribution.description) button.title = command.contribution.description;
    if (!command.enabled && command.reason) {
      button.title = command.reason;
      button.setAttribute("aria-label", `${command.contribution.label}. Indisponível: ${command.reason}`);
      button.classList.add("command-disabled");
    }
    button.addEventListener("click", () => {
      if (!command.enabled) {
        announceUnavailable(button, command.reason);
        return;
      }
      void this.options.registry.execute(command.contribution.id, this.options.context())
        .catch((error) => this.options.onError?.(error));
    });
    return button;
  }
}

export interface CommandPaletteOptions {
  readonly registry: CommandRegistry;
  readonly context: () => ContributionContext;
  readonly onError?: (error: unknown) => void;
}

export class CommandPaletteView {
  private dialog: HTMLDialogElement | undefined;
  private restoreFocus: HTMLElement | undefined;

  constructor(private readonly options: CommandPaletteOptions) {}

  open(initialQuery = ""): void {
    if (this.dialog?.open) return;
    this.restoreFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const dialog = document.createElement("dialog");
    dialog.className = "command-palette";
    dialog.setAttribute("aria-label", "Paleta de comandos");
    const heading = document.createElement("h2");
    heading.textContent = "Executar comando";
    const input = document.createElement("input");
    input.type = "search";
    input.value = initialQuery;
    input.placeholder = "Digite uma ação…";
    input.role = "combobox";
    input.setAttribute("aria-label", "Buscar comando");
    input.setAttribute("aria-controls", "command-palette-results");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "true");
    const results = document.createElement("div");
    results.id = "command-palette-results";
    results.className = "command-palette-results";
    results.role = "listbox";
    const help = document.createElement("p");
    help.className = "command-palette-help";
    help.textContent = "↑↓ navegar · Enter executar · Esc fechar";
    dialog.append(heading, input, results, help);
    document.body.append(dialog);
    this.dialog = dialog;

    let activeIndex = 0;
    const render = (): void => {
      const matches = this.options.registry.search(input.value, this.options.context());
      activeIndex = Math.min(activeIndex, Math.max(0, matches.length - 1));
      results.replaceChildren(...matches.map((match, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.role = "option";
        option.id = paletteOptionId(match.contribution.id, index);
        option.tabIndex = -1;
        option.dataset["commandId"] = match.contribution.id;
        option.setAttribute("aria-selected", String(index === activeIndex));
        option.setAttribute("aria-disabled", String(!match.enabled));
        const label = document.createElement("strong");
        label.textContent = match.contribution.label;
        const detail = document.createElement("span");
        detail.textContent = match.enabled
          ? match.contribution.description ?? match.contribution.category ?? "Comando do editor"
          : match.reason ?? "Comando indisponível";
        option.append(label, detail);
        option.addEventListener("mouseenter", () => {
          activeIndex = index;
          updateActiveOption(results, activeIndex, input);
        });
        option.addEventListener("click", () => void execute(match.contribution.id, match.enabled, match.reason));
        return option;
      }));
      if (matches.length === 0) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "Nenhum comando encontrado.";
        results.append(empty);
      }
      updateActiveOption(results, activeIndex, input);
    };
    const execute = async (id: string, enabled: boolean, reason: string | undefined): Promise<void> => {
      if (!enabled) {
        help.textContent = reason ?? "Comando indisponível.";
        return;
      }
      try {
        await this.options.registry.executePalette(id, this.options.context());
        dialog.close();
      } catch (error) {
        help.textContent = error instanceof Error ? error.message : String(error);
        this.options.onError?.(error);
      }
    };
    input.addEventListener("input", render);
    input.addEventListener("keydown", (event) => {
      const options = [...results.querySelectorAll<HTMLButtonElement>("[role='option']")];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        activeIndex = (activeIndex + delta + options.length) % Math.max(1, options.length);
        updateActiveOption(results, activeIndex, input);
      } else if (event.key === "Enter") {
        event.preventDefault();
        options[activeIndex]?.click();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      this.dialog = undefined;
      restoreEditorFocus(this.restoreFocus);
      this.restoreFocus = undefined;
    }, { once: true });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dialog.close();
    });
    render();
    dialog.showModal();
    input.focus();
  }

  close(): void {
    this.dialog?.close();
  }
}

export class ContextCommandMenuView {
  private menu: HTMLElement | undefined;
  private restoreFocus: HTMLElement | undefined;
  private dismissListener: ((event: Event) => void) | undefined;

  constructor(private readonly options: CommandPaletteOptions) {}

  open(event: MouseEvent): boolean {
    this.close();
    const commands = this.options.registry.list("context-menu", this.options.context(), {
      includeDisabled: true,
    });
    if (commands.length === 0) return false;
    event.preventDefault();
    this.restoreFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const menu = document.createElement("div");
    menu.className = "context-command-menu";
    menu.role = "menu";
    menu.setAttribute("aria-label", "Ações da seleção");
    const announcement = document.createElement("span");
    announcement.className = "visually-hidden";
    announcement.role = "status";
    announcement.setAttribute("aria-live", "polite");
    menu.append(announcement);
    for (const command of commands) {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "menuitem";
      button.tabIndex = menu.querySelector("button") ? -1 : 0;
      button.textContent = command.contribution.label;
      button.setAttribute("aria-disabled", String(!command.enabled));
      if (command.reason) {
        button.title = command.reason;
        if (!command.enabled) {
          button.setAttribute(
            "aria-label",
            `${command.contribution.label}. Indisponível: ${command.reason}`,
          );
        }
      }
      button.addEventListener("click", () => {
        if (!command.enabled) {
          announcement.textContent = command.reason ?? "Comando indisponível.";
          return;
        }
        void this.options.registry.execute(command.contribution.id, this.options.context())
          .then(() => this.close())
          .catch((error) => this.options.onError?.(error));
      });
      menu.append(button);
    }
    document.body.append(menu);
    const rect = typeof menu.getBoundingClientRect === "function"
      ? menu.getBoundingClientRect()
      : { width: 0, height: 0 };
    const viewport = document.defaultView;
    const position = clampContextMenuPosition(
      event.clientX,
      event.clientY,
      rect.width,
      rect.height,
      viewport?.innerWidth ?? Number.POSITIVE_INFINITY,
      viewport?.innerHeight ?? Number.POSITIVE_INFINITY,
    );
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
    this.menu = menu;
    const dismiss = (dismissEvent: Event): void => {
      if (dismissEvent.target instanceof Node && menu.contains(dismissEvent.target)) return;
      this.close();
    };
    queueMicrotask(() => {
      if (this.menu !== menu) return;
      this.dismissListener = dismiss;
      document.addEventListener("pointerdown", dismiss);
      menu.querySelector<HTMLButtonElement>("button")?.focus();
    });
    menu.addEventListener("keydown", (keyEvent) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        this.close();
      } else if (keyEvent.key === "Tab") {
        keyEvent.preventDefault();
        this.close();
      } else if (keyEvent.key === "Home" || keyEvent.key === "End") {
        keyEvent.preventDefault();
        focusMenuItem(items, keyEvent.key === "Home" ? 0 : items.length - 1);
      } else if (keyEvent.key === "ArrowDown" || keyEvent.key === "ArrowUp") {
        keyEvent.preventDefault();
        const target = index < 0
          ? keyEvent.key === "ArrowDown" ? 0 : items.length - 1
          : (index + (keyEvent.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        focusMenuItem(items, target);
      }
    });
    menu.addEventListener("focusout", () => queueMicrotask(() => {
      if (this.menu === menu && !menu.contains(document.activeElement)) this.close();
    }));
    return true;
  }

  close(): void {
    if (this.dismissListener) {
      document.removeEventListener("pointerdown", this.dismissListener);
      this.dismissListener = undefined;
    }
    const restoreFocus = this.restoreFocus;
    this.restoreFocus = undefined;
    this.menu?.remove();
    this.menu = undefined;
    restoreEditorFocus(restoreFocus);
  }
}

function focusMenuItem(items: readonly HTMLButtonElement[], index: number): void {
  const target = items[index];
  if (!target) return;
  items.forEach((item) => { item.tabIndex = item === target ? 0 : -1; });
  target.focus();
}

export function clampContextMenuPosition(
  pointerX: number,
  pointerY: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 8,
): { readonly left: number; readonly top: number } {
  const maximumLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const maximumTop = Math.max(margin, viewportHeight - menuHeight - margin);
  return {
    left: Math.min(Math.max(margin, pointerX), maximumLeft),
    top: Math.min(Math.max(margin, pointerY), maximumTop),
  };
}

export function keyboardEventChord(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CtrlOrMeta");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key = event.key === " " ? "Space" : event.key;
  if (!["Control", "Meta", "Alt", "Shift"].includes(key)) parts.push(key);
  return parts.join("+");
}

function updateActiveOption(host: HTMLElement, activeIndex: number, owner: HTMLElement): void {
  const options = [...host.querySelectorAll<HTMLElement>("[role='option']")];
  options.forEach((option, index) => option.setAttribute("aria-selected", String(index === activeIndex)));
  const active = options[activeIndex];
  if (active) {
    owner.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  } else {
    owner.removeAttribute("aria-activedescendant");
  }
}

function paletteOptionId(commandId: string, index: number): string {
  return `command-palette-option-${index}-${commandId.replace(/[^a-z0-9_-]+/gi, "-")}`;
}

function wireRovingToolbar(host: HTMLElement): void {
  const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")];
  buttons.forEach((button, index) => {
    button.tabIndex = index === 0 ? 0 : -1;
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" &&
          event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      const target = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[target]?.focus();
    });
  });
}

function announceUnavailable(button: HTMLButtonElement, reason: string | undefined): void {
  const host = button.closest("[role='toolbar']") ?? button.parentElement;
  let announcement = host?.querySelector<HTMLElement>("[data-command-announcement]");
  if (!announcement && host) {
    announcement = document.createElement("span");
    announcement.className = "visually-hidden";
    announcement.dataset["commandAnnouncement"] = "true";
    announcement.setAttribute("aria-live", "polite");
    host.append(announcement);
  }
  if (announcement) announcement.textContent = reason ?? "Comando indisponível.";
}

function restoreEditorFocus(previous: HTMLElement | undefined): void {
  if (!previous) return;
  if (previous && document.body.contains(previous)) {
    previous.focus();
    return;
  }
  document.body.querySelector<HTMLElement>(
    "#context-toolbar button, #project-toolbar button, [data-workbench-region='center'] canvas, " +
    "[data-workbench-root]",
  )?.focus();
}
