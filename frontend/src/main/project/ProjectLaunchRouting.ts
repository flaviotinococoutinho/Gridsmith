import path from "node:path";

export interface FocusableProjectWindow {
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/** Resolve somente argumentos de projeto; flags do Electron são ignoradas. */
export function projectPathFromArgs(
  argv: readonly string[],
  workingDirectory = process.cwd(),
): string | undefined {
  const candidate = argv.find((argument) => argument.toLowerCase().endsWith(".p7m.json"));
  if (!candidate) return undefined;
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(workingDirectory, candidate);
}

/** Foco idempotente compartilhado pelo evento second-instance e pelo roteador. */
export function focusExistingProjectWindow(window: FocusableProjectWindow | undefined): boolean {
  if (!window) return false;
  if (window.isMinimized()) window.restore();
  window.focus();
  return true;
}
