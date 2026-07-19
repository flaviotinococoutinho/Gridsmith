import type { CommandRegistry } from "../core/commandRegistry.js";
import type { ContributionContext } from "../core/contributionContext.js";
import type { PanelInstance } from "../core/panelRegistry.js";
import { PROJECT_COMMAND_IDS, type ProjectStatusPayload } from "../core/projectApi.js";

export interface ProjectStartPanelOptions {
  readonly host: HTMLElement;
  readonly commands: CommandRegistry;
  readonly context: () => ContributionContext;
  readonly status: () => ProjectStatusPayload | undefined;
  readonly onError?: (error: unknown) => void;
}

export function mountProjectStart(options: ProjectStartPanelOptions): PanelInstance {
  const render = (): void => {
    const view = document.createElement("div");
    view.className = "project-start";
    const title = document.createElement("h1");
    title.textContent = "Comece por um projeto";
    const description = document.createElement("p");
    description.textContent = "Crie um Plataforma 2D, abra um arquivo existente ou explore uma cópia do exemplo.";
    const actions = document.createElement("div");
    actions.className = "project-start-actions";
    actions.append(
      commandButton("Novo projeto", PROJECT_COMMAND_IDS.new, options, true),
      commandButton("Abrir projeto…", PROJECT_COMMAND_IDS.open, options),
      commandButton("Abrir exemplo", PROJECT_COMMAND_IDS.openExample, options),
    );
    view.append(title, description, actions);

    const recents = options.status()?.recents ?? [];
    if (recents.length > 0) {
      const heading = document.createElement("h2");
      heading.textContent = "Recentes";
      const list = document.createElement("div");
      list.className = "recent-list";
      for (const recent of recents) {
        const button = commandButton(
          recent.name,
          PROJECT_COMMAND_IDS.openRecent,
          options,
          false,
          { filePath: recent.filePath },
        );
        button.title = recent.filePath;
        const timestamp = document.createElement("small");
        timestamp.textContent = new Date(recent.lastOpenedUnixMs).toLocaleString();
        button.append(timestamp);
        list.append(button);
      }
      view.append(heading, list);
    }
    options.host.replaceChildren(view);
  };
  render();
  return {
    activate: render,
    focus: () => options.host.querySelector<HTMLButtonElement>("button")?.focus(),
    dispose: () => options.host.replaceChildren(),
  };
}

function commandButton(
  label: string,
  commandId: string,
  options: ProjectStartPanelOptions,
  primary = false,
  args?: unknown,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (primary) button.className = "primary";
  const availability = options.commands.availability(commandId, options.context());
  button.setAttribute("aria-disabled", String(!availability?.enabled));
  if (!availability?.enabled && availability?.reason) button.title = availability.reason;
  button.addEventListener("click", () => {
    if (!availability?.enabled) return;
    void options.commands.execute(commandId, options.context(), args).catch(options.onError);
  });
  return button;
}
