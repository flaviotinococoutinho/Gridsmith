/** Boundary seguro entre descritores do renderer e Menu.buildFromTemplate. */

import type { MenuItemConstructorOptions } from "electron";
import type {
  NativeMenuCommandDescriptor,
  ProjectCommandInvocation,
} from "../core/projectApi.js";

export const NATIVE_MENU_LIMITS = Object.freeze({
  commands: 128,
  idLength: 128,
  labelLength: 96,
  reasonLength: 240,
  pathDepth: 5,
  pathSegmentLength: 48,
  acceleratorLength: 64,
  aggregateTextLength: 32_768,
  minimumOrder: -10_000,
  maximumOrder: 10_000,
});

const ALLOWED_DESCRIPTOR_KEYS = new Set([
  "id",
  "label",
  "menuPath",
  "order",
  "accelerator",
  "enabled",
  "reason",
]);
const REQUIRED_DESCRIPTOR_KEYS = ["id", "label", "menuPath", "enabled"] as const;
const SAFE_COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const FILE_MENU = "Arquivo";
const EDIT_MENU = "Editar";
const VIEW_MENU = "Exibir";
const RECENTS_MENU = "Recentes";
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = Object.freeze({
  plus: "Plus",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  return: "Return",
  enter: "Enter",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  escape: "Escape",
  esc: "Escape",
  volumeup: "VolumeUp",
  volumedown: "VolumeDown",
  volumemute: "VolumeMute",
  medianexttrack: "MediaNextTrack",
  mediaprevioustrack: "MediaPreviousTrack",
  mediastop: "MediaStop",
  mediaplaypause: "MediaPlayPause",
  printscreen: "PrintScreen",
});

export class NativeMenuProjectionValidationError extends TypeError {
  constructor(message: string) {
    super(`Invalid native menu projection: ${message}`);
    this.name = "NativeMenuProjectionValidationError";
  }
}

/**
 * Valida e copia a projeção inteira antes de substituir a versão ativa. Uma
 * entrada inválida rejeita o lote completo; o caller pode manter o último menu
 * válido sem expor estado parcialmente aceito.
 */
export function validateNativeMenuCommandDescriptors(
  value: unknown,
): readonly NativeMenuCommandDescriptor[] {
  if (!Array.isArray(value)) fail("payload must be an array");
  if (value.length > NATIVE_MENU_LIMITS.commands) {
    fail(`command count exceeds ${NATIVE_MENU_LIMITS.commands}`);
  }

  const ids = new Set<string>();
  const locations = new Set<string>();
  const accelerators = new Set<string>();
  const result: NativeMenuCommandDescriptor[] = [];
  let aggregateTextLength = 0;

  for (let index = 0; index < value.length; index++) {
    const candidate = value[index];
    if (!isPlainRecord(candidate)) fail(`command[${index}] must be a plain object`);
    const ownKeys = Reflect.ownKeys(candidate);
    if (ownKeys.some((key) => typeof key !== "string" || !ALLOWED_DESCRIPTOR_KEYS.has(key))) {
      fail(`command[${index}] contains a non-allowlisted field`);
    }
    for (const key of REQUIRED_DESCRIPTOR_KEYS) {
      if (!Object.hasOwn(candidate, key)) fail(`command[${index}].${key} is required`);
    }

    const id = validatedText(candidate["id"], `command[${index}].id`, NATIVE_MENU_LIMITS.idLength);
    if (!SAFE_COMMAND_ID.test(id)) {
      fail(`command[${index}].id contains unsupported characters`);
    }
    if (ids.has(id)) fail(`command id "${id}" is duplicated`);
    ids.add(id);

    const label = validatedText(
      candidate["label"],
      `command[${index}].label`,
      NATIVE_MENU_LIMITS.labelLength,
    );
    const menuPath = validatedMenuPath(candidate["menuPath"], index);
    if (
      menuPath.length > 2 &&
      menuPath[0] === FILE_MENU &&
      menuPath[1] === RECENTS_MENU
    ) {
      fail(`command[${index}] targets the reserved native Recentes submenu`);
    }
    const enabled = candidate["enabled"];
    if (typeof enabled !== "boolean") fail(`command[${index}].enabled must be boolean`);

    const orderValue = candidate["order"];
    const order = orderValue === undefined ? 0 : orderValue;
    if (
      !Number.isInteger(order) ||
      (order as number) < NATIVE_MENU_LIMITS.minimumOrder ||
      (order as number) > NATIVE_MENU_LIMITS.maximumOrder
    ) {
      fail(
        `command[${index}].order must be an integer between ` +
        `${NATIVE_MENU_LIMITS.minimumOrder} and ${NATIVE_MENU_LIMITS.maximumOrder}`,
      );
    }

    const acceleratorValue = candidate["accelerator"];
    const accelerator = acceleratorValue === undefined
      ? undefined
      : validatedAccelerator(acceleratorValue, index);
    if (accelerator && accelerators.has(accelerator)) {
      fail(`accelerator "${accelerator}" is duplicated`);
    }
    if (accelerator) accelerators.add(accelerator);

    const reasonValue = candidate["reason"];
    const reason = reasonValue === undefined
      ? undefined
      : validatedText(
          reasonValue,
          `command[${index}].reason`,
          NATIVE_MENU_LIMITS.reasonLength,
        );
    const location = JSON.stringify(menuPath);
    if (locations.has(location)) fail(`menu item location ${location} is duplicated`);
    locations.add(location);

    aggregateTextLength += id.length + label.length + menuPath.join("").length +
      (accelerator?.length ?? 0) + (reason?.length ?? 0);
    if (aggregateTextLength > NATIVE_MENU_LIMITS.aggregateTextLength) {
      fail(`aggregate text exceeds ${NATIVE_MENU_LIMITS.aggregateTextLength} characters`);
    }

    result.push(Object.freeze({
      id,
      label,
      menuPath,
      order: order as number,
      ...(accelerator ? { accelerator } : {}),
      enabled,
      ...(reason ? { reason } : {}),
    }));
  }
  return Object.freeze(result);
}

export interface NativeMenuRecentProject {
  readonly name: string;
  readonly filePath: string;
}

export interface NativeMenuTemplateOptions {
  readonly commands: readonly NativeMenuCommandDescriptor[];
  readonly recentProjects: readonly NativeMenuRecentProject[];
  readonly recentCommandId: string;
  /** Injetável para manter a política de accelerators testável fora do Electron. */
  readonly platform?: NodeJS.Platform;
  readonly invoke: (invocation: ProjectCommandInvocation) => void;
  readonly openRecent: (filePath: string) => void;
  readonly requestClose: () => void;
}

/** Materializa somente items normais; roles e Recentes são sempre do main. */
export function buildNativeMenuTemplate(
  options: NativeMenuTemplateOptions,
): MenuItemConstructorOptions[] {
  const commands = validateNativeMenuCommandDescriptors(options.commands);
  const recentCommand = commands.find(({ id }) => id === options.recentCommandId);
  const reservedConflict = commands.find((descriptor) =>
    descriptor.id !== options.recentCommandId &&
    descriptor.menuPath[0] === FILE_MENU &&
    descriptor.menuPath[1] === RECENTS_MENU);
  if (reservedConflict) {
    fail(`command "${reservedConflict.id}" targets the reserved native Recentes submenu`);
  }
  if (recentCommand && (
    recentCommand.menuPath.length !== 2 ||
    recentCommand.menuPath[0] !== FILE_MENU ||
    recentCommand.menuPath[1] !== RECENTS_MENU
  )) {
    fail(`native Recentes command must use the path ["${FILE_MENU}", "${RECENTS_MENU}"]`);
  }
  const roots = buildMenuTree(commands.filter(({ id }) => id !== options.recentCommandId));
  const platform = options.platform ?? process.platform;

  const fileItems = materializeBranch(roots.get(FILE_MENU), options.invoke, platform);
  if (fileItems.length > 0) fileItems.push({ type: "separator" });
  fileItems.push(recentMenu(options, recentCommand));
  fileItems.push({ type: "separator" });
  fileItems.push({ label: "Sair", click: options.requestClose });

  const editItems = materializeBranch(roots.get(EDIT_MENU), options.invoke, platform);
  const viewItems = materializeBranch(roots.get(VIEW_MENU), options.invoke, platform);
  if (viewItems.length > 0) viewItems.push({ type: "separator" });
  viewItems.push(
    { role: "toggleDevTools", label: "Ferramentas de desenvolvimento" },
    { type: "separator" },
    { role: "resetZoom", label: "Zoom padrão" },
    { role: "zoomIn", label: "Aumentar zoom" },
    { role: "zoomOut", label: "Diminuir zoom" },
  );

  roots.delete(FILE_MENU);
  roots.delete(EDIT_MENU);
  roots.delete(VIEW_MENU);
  const extraRoots = [...roots.values()]
    .sort(compareBranches)
    .map((branch) => ({
      label: branch.label,
      submenu: materializeBranch(branch, options.invoke, platform),
    } satisfies MenuItemConstructorOptions));

  return [
    { label: FILE_MENU, submenu: fileItems },
    { label: EDIT_MENU, submenu: editItems },
    { label: VIEW_MENU, submenu: viewItems },
    ...extraRoots,
  ];
}

export interface DefaultNativeMenuCommandIds {
  readonly new: string;
  readonly open: string;
  readonly openExample: string;
  readonly openRecent: string;
  readonly save: string;
  readonly saveAs: string;
  readonly close: string;
  readonly undo: string;
  readonly redo: string;
}

/** Menu funcional antes de o renderer publicar sua primeira projeção. */
export function defaultNativeMenuCommands(
  ids: DefaultNativeMenuCommandIds,
): readonly NativeMenuCommandDescriptor[] {
  return validateNativeMenuCommandDescriptors([
    command(ids.new, "Novo projeto…", FILE_MENU, 0, "CmdOrCtrl+N"),
    command(ids.open, "Abrir projeto…", FILE_MENU, 10, "CmdOrCtrl+O"),
    command(ids.openExample, "Abrir exemplo", FILE_MENU, 20),
    command(ids.openRecent, RECENTS_MENU, FILE_MENU, 30),
    command(ids.save, "Salvar", FILE_MENU, 40, "CmdOrCtrl+S"),
    command(ids.saveAs, "Salvar como…", FILE_MENU, 50, "CmdOrCtrl+Shift+S"),
    command(ids.close, "Fechar projeto", FILE_MENU, 60, "CmdOrCtrl+W"),
    command(ids.undo, "Desfazer", EDIT_MENU, 0, "CmdOrCtrl+Z"),
    command(ids.redo, "Refazer", EDIT_MENU, 10, "CmdOrCtrl+Shift+Z"),
  ]);
}

interface MenuBranch {
  readonly label: string;
  readonly commands: NativeMenuCommandDescriptor[];
  readonly children: Map<string, MenuBranch>;
}

function buildMenuTree(
  commands: readonly NativeMenuCommandDescriptor[],
): Map<string, MenuBranch> {
  const roots = new Map<string, MenuBranch>();
  for (const command of commands) {
    let siblings = roots;
    let branch: MenuBranch | undefined;
    for (const segment of command.menuPath.slice(0, -1)) {
      branch = siblings.get(segment);
      if (!branch) {
        branch = { label: segment, commands: [], children: new Map() };
        siblings.set(segment, branch);
      }
      siblings = branch.children;
    }
    branch!.commands.push(command);
  }
  return roots;
}

function materializeBranch(
  branch: MenuBranch | undefined,
  invoke: (invocation: ProjectCommandInvocation) => void,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] {
  if (!branch) return [];
  const entries: Array<{
    readonly order: number;
    readonly label: string;
    readonly id: string;
    readonly item: MenuItemConstructorOptions;
  }> = branch.commands.map((descriptor) => ({
    order: descriptor.order ?? 0,
    label: descriptor.label,
    id: descriptor.id,
    item: {
      id: descriptor.id,
      label: descriptor.label,
      enabled: descriptor.enabled,
      ...(descriptor.accelerator && !mustLeaveTextUndoToRenderer(descriptor.accelerator, platform)
        ? { accelerator: descriptor.accelerator }
        : {}),
      // O renderer possui o shortcut registry e sabe se o foco está em um
      // editor textual. Electron apenas exibe o accelerator no menu; registrá-lo
      // aqui capturaria Ctrl/Cmd+Z antes do input receber o evento nativo.
      registerAccelerator: false,
      ...(!descriptor.enabled && descriptor.reason
        ? { toolTip: descriptor.reason, sublabel: descriptor.reason }
        : {}),
      acceleratorWorksWhenHidden: false,
      click: () => invoke({ commandId: descriptor.id }),
    },
  }));
  for (const child of branch.children.values()) {
    entries.push({
      order: branchOrder(child),
      label: child.label,
      id: `submenu:${child.label}`,
      item: {
        label: child.label,
        submenu: materializeBranch(child, invoke, platform),
      },
    });
  }
  return entries
    .sort((left, right) => left.order - right.order ||
      left.label.localeCompare(right.label, "pt-BR") || left.id.localeCompare(right.id))
    .map(({ item }) => item);
}

/**
 * `registerAccelerator: false` não impede captura no macOS. Cmd+Z precisa
 * chegar primeiro ao renderer, que distingue inputs do histórico canônico.
 */
function mustLeaveTextUndoToRenderer(
  accelerator: string,
  platform: NodeJS.Platform,
): boolean {
  return platform === "darwin" && (
    accelerator === "CmdOrCtrl+Z" || accelerator === "CmdOrCtrl+Shift+Z"
  );
}

function recentMenu(
  options: NativeMenuTemplateOptions,
  descriptor: NativeMenuCommandDescriptor | undefined,
): MenuItemConstructorOptions {
  const enabled = descriptor?.enabled ?? false;
  const reason = !enabled ? descriptor?.reason ?? "Comando de recentes indisponível." : undefined;
  const submenu: MenuItemConstructorOptions[] = options.recentProjects.length === 0
    ? [{ label: "Nenhum projeto recente", enabled: false }]
    : options.recentProjects.map((recent) => ({
        label: recent.name,
        sublabel: recent.filePath,
        enabled,
        ...(reason ? { toolTip: reason } : {}),
        click: () => options.openRecent(recent.filePath),
      }));
  return {
    label: RECENTS_MENU,
    submenu,
    ...(reason ? { toolTip: reason } : {}),
  };
}

function branchOrder(branch: MenuBranch): number {
  let order = Number.POSITIVE_INFINITY;
  for (const command of branch.commands) order = Math.min(order, command.order ?? 0);
  for (const child of branch.children.values()) order = Math.min(order, branchOrder(child));
  return Number.isFinite(order) ? order : 0;
}

function compareBranches(left: MenuBranch, right: MenuBranch): number {
  return branchOrder(left) - branchOrder(right) || left.label.localeCompare(right.label, "pt-BR");
}

function command(
  id: string,
  label: string,
  menu: string,
  order: number,
  accelerator?: string,
): NativeMenuCommandDescriptor {
  return {
    id,
    label,
    menuPath: [menu, label],
    order,
    ...(accelerator ? { accelerator } : {}),
    enabled: true,
  };
}

function validatedMenuPath(value: unknown, index: number): readonly string[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > NATIVE_MENU_LIMITS.pathDepth) {
    fail(
      `command[${index}].menuPath must contain 2..${NATIVE_MENU_LIMITS.pathDepth} segments`,
    );
  }
  return Object.freeze(value.map((segment, pathIndex) => validatedText(
    segment,
    `command[${index}].menuPath[${pathIndex}]`,
    NATIVE_MENU_LIMITS.pathSegmentLength,
  )));
}

function validatedText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value.length === 0 || value.length > maximumLength || value !== value.trim()) {
    fail(`${field} must contain 1..${maximumLength} trimmed characters`);
  }
  if (CONTROL_CHARACTER.test(value)) fail(`${field} contains a control character`);
  return value;
}

function validatedAccelerator(value: unknown, index: number): string {
  const accelerator = validatedText(
    value,
    `command[${index}].accelerator`,
    NATIVE_MENU_LIMITS.acceleratorLength,
  );
  const parts = accelerator.split("+");
  if (parts.some((part) => part.length === 0) || parts.length > 6) {
    fail(`command[${index}].accelerator has an invalid chord shape`);
  }
  const modifiers = new Set<string>();
  let key: string | undefined;
  for (const part of parts) {
    const modifier = acceleratorModifier(part);
    if (modifier) {
      if (modifiers.has(modifier)) fail(`command[${index}].accelerator repeats ${modifier}`);
      modifiers.add(modifier);
      continue;
    }
    if (key !== undefined) fail(`command[${index}].accelerator must contain exactly one key`);
    key = acceleratorKey(part);
    if (!key) fail(`command[${index}].accelerator key "${part}" is not allowlisted`);
  }
  if (!key) fail(`command[${index}].accelerator requires a key`);
  if (modifiers.has("CmdOrCtrl") && (modifiers.has("Cmd") || modifiers.has("Ctrl"))) {
    fail(`command[${index}].accelerator mixes CmdOrCtrl with Cmd/Ctrl`);
  }
  const modifierOrder = ["CmdOrCtrl", "Cmd", "Ctrl", "Alt", "Shift", "Super"];
  return [...modifierOrder.filter((modifier) => modifiers.has(modifier)), key].join("+");
}

function acceleratorModifier(value: string): string | undefined {
  const normalized = value.toLocaleLowerCase("en-US");
  if (["cmdorctrl", "commandorcontrol", "ctrlormeta"].includes(normalized)) return "CmdOrCtrl";
  if (["cmd", "command", "meta"].includes(normalized)) return "Cmd";
  if (["ctrl", "control"].includes(normalized)) return "Ctrl";
  if (["alt", "option"].includes(normalized)) return "Alt";
  if (normalized === "shift") return "Shift";
  if (normalized === "super") return "Super";
  return undefined;
}

function acceleratorKey(value: string): string | undefined {
  if (/^[A-Za-z0-9]$/u.test(value)) return value.toLocaleUpperCase("en-US");
  const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/iu.exec(value);
  if (functionKey) return functionKey[0].toLocaleUpperCase("en-US");
  return ACCELERATOR_KEYS[value.toLocaleLowerCase("en-US")];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message: string): never {
  throw new NativeMenuProjectionValidationError(message);
}
