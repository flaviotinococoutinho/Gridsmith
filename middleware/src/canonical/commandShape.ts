/**
 * Reconstrução de comandos canônicos a partir do par (kind, payload) usado
 * nas bordas de transporte (MCP, gateway do editor). A validação de conteúdo
 * é do BlueprintStore — aqui só se restaura o shape.
 */

import type { BlueprintCommand } from "../domain/BlueprintStore.js";

export const COMMAND_KINDS = [
  "skeleton/define",
  "mesh/bind",
  "camera/configure",
  "light/add",
  "light/remove",
  "entitydef/define",
  "entity/place",
  "entity/remove",
] as const satisfies readonly BlueprintCommand["kind"][];

export function reshapeCommand(
  kind: BlueprintCommand["kind"],
  payload: Record<string, unknown>,
): BlueprintCommand {
  switch (kind) {
    case "skeleton/define":
      return { kind, skeleton: payload as never };
    case "mesh/bind":
      return { kind, binding: payload as never };
    case "camera/configure":
      return { kind, settings: payload as never };
    case "light/add":
      return { kind, light: payload as never };
    case "light/remove":
      return { kind, lightId: payload["lightId"] as string };
    case "entitydef/define":
      return { kind, definition: payload as never };
    case "entity/place":
      return { kind, entity: payload as never };
    case "entity/remove":
      return { kind, entityId: payload["entityId"] as string };
  }
}
