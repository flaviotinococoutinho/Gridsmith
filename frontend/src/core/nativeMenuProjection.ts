/** Projeção serializável do CommandRegistry para o boundary Electron. */

import type {
  PlacedCommand,
  ShortcutCommandPlacement,
} from "./commandRegistry.js";
import type { NativeMenuCommandDescriptor } from "./projectApi.js";

/**
 * Converte contribuições já resolvidas pelo renderer em dados sem callbacks.
 *
 * Wiring esperado no composition root do renderer (depois de registrar as
 * contribuições e sempre que contexto/enablement mudar):
 *
 * ```ts
 * const context = application.contributionContext();
 * await application.api.updateNativeMenu(projectNativeMenuCommands(
 *   application.commands.list("menu", context, { includeDisabled: true }),
 *   application.commands.list("shortcut", context, { includeDisabled: true }),
 * ));
 * ```
 *
 * `MenuCommandPlacement.path` já é o path semântico completo esperado pelo
 * host. Atalhos continuam sendo resolvidos pelo CommandRegistry; o primeiro
 * placement de shortcut do mesmo comando vira o accelerator nativo.
 */
export function projectNativeMenuCommands(
  menuCommands: readonly PlacedCommand[],
  shortcutCommands: readonly PlacedCommand[] = [],
): readonly NativeMenuCommandDescriptor[] {
  const acceleratorByCommand = new Map<string, string>();
  for (const placed of shortcutCommands) {
    if (placed.placement.surface !== "shortcut") continue;
    if (acceleratorByCommand.has(placed.contribution.id)) continue;
    acceleratorByCommand.set(
      placed.contribution.id,
      electronAccelerator(placed.placement),
    );
  }

  const seen = new Set<string>();
  return Object.freeze(menuCommands.map((placed) => {
    if (placed.placement.surface !== "menu") {
      throw new TypeError(`Command "${placed.contribution.id}" is not a menu placement`);
    }
    if (seen.has(placed.contribution.id)) {
      throw new TypeError(
        `Command "${placed.contribution.id}" has more than one native menu placement`,
      );
    }
    seen.add(placed.contribution.id);
    if (placed.placement.path.length < 2) {
      throw new TypeError(
        `Native menu path for "${placed.contribution.id}" requires a parent and an item`,
      );
    }
    const accelerator = acceleratorByCommand.get(placed.contribution.id);
    return Object.freeze({
      id: placed.contribution.id,
      label: placed.contribution.label,
      menuPath: Object.freeze([...placed.placement.path]),
      order: placed.placement.order ?? 0,
      ...(accelerator ? { accelerator } : {}),
      enabled: placed.enabled,
      ...(!placed.enabled && placed.reason ? { reason: placed.reason } : {}),
    });
  }));
}

function electronAccelerator(placement: ShortcutCommandPlacement): string {
  return placement.chord
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const normalized = part.toLocaleLowerCase("en-US");
      if (["ctrlormeta", "cmdorctrl", "commandorcontrol"].includes(normalized)) {
        return "CmdOrCtrl";
      }
      if (normalized === "meta" || normalized === "command" || normalized === "cmd") {
        return "Cmd";
      }
      if (normalized === "control" || normalized === "ctrl") return "Ctrl";
      if (normalized === "option" || normalized === "alt") return "Alt";
      if (normalized === "shift") return "Shift";
      return part.length === 1 ? part.toLocaleUpperCase("en-US") : part;
    })
    .join("+");
}
