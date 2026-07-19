/**
 * Liga a identidade efetiva da engine à sessão de projeto ativa.
 *
 * `EnginePipeServer` já filtra fechamentos de engines supersedidas; portanto
 * cada evento recebido aqui representa uma mudança real do destino das
 * projeções. O manager captura `current` dentro de sua própria fila, evitando
 * reidratar uma referência de projeto que já foi substituída.
 */

import type { ProjectSessionManager, ProjectStatus } from "../canonical/ProjectSessionManager.js";
import type {
  CurrentEngineSessionChangedEvent,
  EnginePipeServer,
} from "../ipc/EnginePipeServer.js";

export interface EngineProjectSessionLifecycleHandlers {
  readonly onRehydrated?: (
    status: ProjectStatus,
    change: CurrentEngineSessionChangedEvent,
  ) => void;
  readonly onError?: (
    error: Error,
    change: CurrentEngineSessionChangedEvent,
  ) => void;
}

/**
 * Retorna um unbind idempotente para que o shutdown não agende trabalho novo.
 */
export function bindEngineProjectSessionLifecycle(
  server: EnginePipeServer,
  sessions: Pick<ProjectSessionManager, "rehydrateCurrent">,
  handlers: EngineProjectSessionLifecycleHandlers = {},
): () => void {
  const onChange = (change: CurrentEngineSessionChangedEvent): void => {
    void sessions.rehydrateCurrent().then(
      (status) => handlers.onRehydrated?.(status, change),
      (error: unknown) => handlers.onError?.(toError(error), change),
    );
  };
  server.on("currentSessionChanged", onChange);

  let bound = true;
  return (): void => {
    if (!bound) return;
    bound = false;
    server.removeListener("currentSessionChanged", onChange);
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
