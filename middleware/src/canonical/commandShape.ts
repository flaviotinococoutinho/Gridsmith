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
  "light/update",
  "light/remove",
  "entitydef/define",
  "entitydef/update",
  "entitydef/remove",
  "tileset/define",
  "tileset/remove",
  "entity/place",
  "entity/move",
  "entity/properties",
  "entity/remove",
  "level/define",
  "level/update",
  "level/patch",
  "level/palette",
  "level/remove",
  "world/place",
  "world/unplace",
] as const satisfies readonly BlueprintCommand["kind"][];

/**
 * Contexto que a BORDA aceita do payload.
 *
 * Só o `transactionId` entra por aqui: agrupar comandos num gesto é escolha
 * legítima do cliente. A PROVENIÊNCIA (`metadata.actor`) NÃO entra — quem
 * define quem originou o comando é a borda confiável, no dispatch. Aceitar
 * actor do payload deixaria qualquer cliente se declarar "human" e sujar a
 * trilha de auditoria.
 */
function contextOf(payload: Record<string, unknown>): { readonly transactionId?: string } {
  const transactionId = payload["transactionId"];
  return typeof transactionId === "string" && transactionId.length > 0 ? { transactionId } : {};
}

export function reshapeCommand(
  kind: BlueprintCommand["kind"],
  payload: Record<string, unknown>,
): BlueprintCommand {
  const context = contextOf(payload);
  switch (kind) {
    case "skeleton/define":
      return { kind, skeleton: payload as never, ...context };
    case "mesh/bind":
      return { kind, binding: payload as never, ...context };
    case "camera/configure":
      return {
        kind,
        settings: payload as never,
        ...(payload["replace"] === true ? { replace: true } : {}),
        ...context,
      };
    case "light/add":
      return { kind, light: payload as never, ...context };
    case "light/update":
      return { kind, light: payload as never, ...context };
    case "light/remove":
      return { kind, lightId: payload["lightId"] as string, ...context };
    case "entitydef/define":
      return { kind, definition: payload as never, ...context };
    case "entitydef/update":
      return { kind, definition: payload as never, ...context };
    case "entitydef/remove":
      return { kind, entityDefId: payload["entityDefId"] as string, ...context };
    case "entity/place":
      return { kind, entity: payload as never, ...context };
    case "entity/move":
      return {
        kind,
        entityId: payload["entityId"] as string,
        position: payload["position"] as never,
        ...context,
      };
    case "entity/properties":
      return {
        kind,
        entityId: payload["entityId"] as string,
        changes: payload["changes"] as never,
        ...context,
      };
    case "entity/remove":
      return { kind, entityId: payload["entityId"] as string, ...context };
    case "tileset/define":
      return { kind, tileset: payload as never, ...context };
    case "tileset/remove":
      return { kind, tilesetId: payload["tilesetId"] as string, ...context };
    case "level/define":
      return { kind, level: payload as never, ...context };
    case "level/update":
      return { kind, level: payload as never, ...context };
    case "level/patch":
      return {
        kind,
        levelId: payload["levelId"] as string,
        changes: payload["changes"] as never,
        ...context,
      };
    case "level/palette":
      return {
        kind,
        levelId: payload["levelId"] as string,
        changes: payload["changes"] as never,
        ...context,
      };
    case "level/remove":
      return { kind, levelId: payload["levelId"] as string, ...context };
    case "world/place":
      return { kind, placement: payload as never, ...context };
    case "world/unplace":
      return { kind, levelId: payload["levelId"] as string, ...context };
  }
}
