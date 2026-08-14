import path from "node:path";
import { isProjectPath } from "../../core/projectExtensions.js";

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
  // aceita também o sufixo herdado: um `.p7m.json` arrastado para o executável
  // tem de abrir, e não sumir sem mensagem nenhuma
  const candidate = argv.find((argument) => isProjectPath(argument));
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
