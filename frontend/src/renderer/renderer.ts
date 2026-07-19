/**
 * Composition root do renderer: cria a aplicação, registra contribuições
 * internas e encaminha eventos globais. Painéis, comandos e ferramentas vivem
 * em módulos próprios.
 */

import type { P7mEditorApi } from "../main/preload.js";
import { registerBuiltinContributions } from "./builtinContributions.js";
import {
  EditorWorkbenchApplication,
  routeGlobalEditorEvents,
} from "./workbenchApplication.js";

declare global {
  interface Window {
    p7m: P7mEditorApi;
  }
}

const application = new EditorWorkbenchApplication({
  api: window.p7m,
  document,
  hostWindow: window,
});

registerBuiltinContributions(application);
routeGlobalEditorEvents(application);
void application.boot();
