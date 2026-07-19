/**
 * Reconstrução de comandos canônicos a partir do par (kind, payload) usado
 * nas bordas de transporte (MCP, gateway do editor). A validação de conteúdo
 * é do BlueprintStore — aqui só se restaura o shape.
 */

import type { BlueprintCommand, CommandContext } from "../domain/BlueprintStore.js";

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

export function reshapeCommand(
  kind: BlueprintCommand["kind"],
  payload: Record<string, unknown>,
): BlueprintCommand {
  const context = commandContext(payload);
  const domain = domainPayload(payload);
  switch (kind) {
    case "skeleton/define":
      return { kind, skeleton: domain as never, ...context };
    case "mesh/bind":
      return { kind, binding: domain as never, ...context };
    case "camera/configure": {
      const nested = payload["settings"];
      const settings = nested && typeof nested === "object" && !Array.isArray(nested)
        ? nested
        : domainPayload(payload, ["replace"]);
      return {
        kind,
        settings: settings as never,
        ...(payload["replace"] === true ? { replace: true } : {}),
        ...context,
      };
    }
    case "light/add":
      return { kind, light: domain as never, ...context };
    case "light/update":
      return { kind, light: domain as never, ...context };
    case "light/remove":
      return { kind, lightId: payload["lightId"] as string, ...context };
    case "entitydef/define":
      return { kind, definition: domain as never, ...context };
    case "entitydef/update":
      return { kind, definition: domain as never, ...context };
    case "entitydef/remove":
      return { kind, entityDefId: payload["entityDefId"] as string, ...context };
    case "entity/place":
      return { kind, entity: domain as never, ...context };
    case "entity/move":
      return { kind, entityId: payload["entityId"] as string, position: payload["position"] as never, ...context };
    case "entity/properties":
      return {
        kind,
        entityId: payload["entityId"] as string,
        changes: payload["changes"] as never,
        ...context,
      };
    case "entity/remove":
      return { kind, entityId: payload["entityId"] as string, ...context };
    case "level/define":
      return { kind, level: domain as never, ...context };
    case "level/update":
      return { kind, level: domain as never, ...context };
    case "level/patch":
      return {
        kind,
        levelId: payload["levelId"] as string,
        changes: payload["changes"] as never,
        transactionId: payload["transactionId"] as string,
        metadata: payload["metadata"] as never,
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
      return { kind, placement: domain as never, ...context };
    case "world/unplace":
      return { kind, levelId: payload["levelId"] as string, ...context };
  }
}

function commandContext(payload: Record<string, unknown>): CommandContext {
  return {
    ...(typeof payload["transactionId"] === "string"
      ? { transactionId: payload["transactionId"] }
      : {}),
    ...(payload["metadata"] && typeof payload["metadata"] === "object" && !Array.isArray(payload["metadata"])
      ? { metadata: payload["metadata"] as never }
      : {}),
  };
}

function domainPayload(
  payload: Record<string, unknown>,
  extraControlKeys: readonly string[] = [],
): Record<string, unknown> {
  const control = new Set(["transactionId", "metadata", ...extraControlKeys]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !control.has(key)));
}
