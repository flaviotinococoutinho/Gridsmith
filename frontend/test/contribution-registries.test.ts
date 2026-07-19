import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContributionUnavailableError,
  denyUnknownCapabilities,
  type CapabilityDecision,
} from "../src/core/capabilityRegistry.js";
import { CommandRegistry, normalizeShortcut } from "../src/core/commandRegistry.js";
import type { ContributionContext } from "../src/core/contributionContext.js";
import {
  InspectorRegistry,
  type InspectorContext,
  type InspectorFieldSchema,
} from "../src/core/inspectorRegistry.js";
import { PanelRegistry } from "../src/core/panelRegistry.js";
import { SelectionService, type EntityInstanceSelection } from "../src/core/selectionService.js";
import { ToolRegistry } from "../src/core/toolRegistry.js";
import { registerBuiltinInspectors } from "../src/renderer/builtinInspectors.js";
import type { EditorWorkbenchApplication } from "../src/renderer/workbenchApplication.js";

function mutableCapabilities(initial: Readonly<Record<string, CapabilityDecision>>): {
  readonly decisions: Record<string, CapabilityDecision>;
  readonly resolve: ReturnType<typeof denyUnknownCapabilities>;
} {
  const decisions = { ...initial };
  return { decisions, resolve: denyUnknownCapabilities(decisions) };
}

function contributionContext(
  selection: SelectionService,
  capabilities: ContributionContext["capabilities"],
  mode = "edit",
): ContributionContext {
  return { selection, capabilities, mode };
}

test("registries puros: painel arbitrário é contribuído sem switch central e respeita seleção/modo/capability", () => {
  const registry = new PanelRegistry<{ readonly slot: string }>();
  const selection = new SelectionService("session-a");
  const capabilities = mutableCapabilities({
    "level.edit": { enabled: true, reason: "Edição de nível disponível" },
  });
  let mountedAt = "";
  let disposed = false;
  const unregister = registry.register({
    id: "internal.future.tile-statistics",
    label: "Estatísticas de tiles",
    defaultRegion: "right",
    requiredCapabilities: ["level.edit"],
    supportedSelections: ["level", "cell"],
    order: 70,
    visibleWhen: ({ mode }) => mode === "edit",
    mount: ({ mountTarget }) => {
      mountedAt = mountTarget.slot;
      return { dispose: () => { disposed = true; } };
    },
  });

  assert.deepEqual(registry.list(contributionContext(selection, capabilities.resolve)), []);
  selection.select({
    kind: "level", projectSessionId: "session-a", projectId: "p1", levelId: "level-1",
  }, "canvas");
  assert.equal(registry.list(contributionContext(selection, capabilities.resolve))[0]?.contribution.id,
    "internal.future.tile-statistics");
  assert.deepEqual(registry.list(contributionContext(selection, capabilities.resolve, "play")), []);

  const context = {
    ...contributionContext(selection, capabilities.resolve),
    mountTarget: { slot: "right-stack" },
  };
  const instance = registry.mount("internal.future.tile-statistics", context);
  assert.equal(mountedAt, "right-stack");
  instance.dispose();
  assert.equal(disposed, true);

  capabilities.decisions["level.edit"] = { enabled: false, reason: "Editor somente leitura neste perfil" };
  const blocked = registry.list(contributionContext(selection, capabilities.resolve))[0]!;
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.reason, "Editor somente leitura neste perfil");
  assert.throws(
    () => registry.mount("internal.future.tile-statistics", context),
    (error) => error instanceof ContributionUnavailableError
      && error.message === "Editor somente leitura neste perfil",
  );

  unregister();
  assert.equal(registry.get("internal.future.tile-statistics"), undefined);
});

test("registries puros: command palette encontra e executa; todas as superfícies compartilham um comando", async () => {
  const registry = new CommandRegistry();
  const selection = new SelectionService("session-a");
  selection.select({
    kind: "level", projectSessionId: "session-a", projectId: "p1", levelId: "level-1",
  }, "tree");
  const capabilities = mutableCapabilities({
    "level.validate": { enabled: true, reason: "Validação disponível" },
  });
  const context = contributionContext(selection, capabilities.resolve);
  let executions = 0;
  const observedExecutions: string[] = [];
  registry.onDidExecute(({ commandId }) => observedExecutions.push(commandId));

  registry.register({
    id: "level.validate",
    label: "Validar nível",
    description: "Verifica colisões e referências",
    category: "Nível",
    keywords: ["problemas", "diagnóstico"],
    requiredCapabilities: ["level.validate"],
    supportedSelections: ["level", "cell"],
    placements: [
      { surface: "menu", path: ["Nível", "Validar"], order: 20 },
      { surface: "toolbar", group: "level", order: 20 },
      { surface: "context-menu", group: "level" },
      { surface: "command-palette" },
      { surface: "shortcut", chord: "CtrlOrMeta+Shift+V" },
      { surface: "corrective-action", problemKind: "invalid-reference" },
    ],
    execute: () => ++executions,
  });

  for (const surface of ["menu", "toolbar", "context-menu", "command-palette", "shortcut", "corrective-action"] as const) {
    assert.equal(registry.list(surface, context).length, 1, `surface ${surface}`);
  }
  const match = registry.search("diagnostico", context)[0]!;
  assert.equal(match.contribution.id, "level.validate");
  assert.ok(match.score >= 0);
  assert.equal(await registry.executePalette<number>(match.contribution.id, context), 1);

  const shortcut = await registry.executeShortcut<number>("Shift+CtrlOrMeta+v", context);
  assert.deepEqual(shortcut, { handled: true, commandId: "level.validate", result: 2 });
  assert.equal(normalizeShortcut("CommandOrControl+shift+v"), "CtrlOrMeta+Shift+V");

  capabilities.decisions["level.validate"] = { enabled: false, reason: "Runtime desconectado" };
  const disabled = registry.search("validar", context)[0]!;
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.reason, "Runtime desconectado");
  assert.deepEqual(await registry.executeShortcut("CtrlOrMeta+Shift+V", context), {
    handled: true,
    commandId: "level.validate",
    reason: "Runtime desconectado",
  });
  assert.equal(executions, 2);
  assert.deepEqual(observedExecutions, ["level.validate", "level.validate"]);
});

test("registries puros: SelectionService sincroniza canvas, árvore e inspector sem notificações duplicadas", () => {
  const selection = new SelectionService("session-a");
  const tree: string[] = [];
  const inspector: string[] = [];
  selection.subscribe(({ current, source }) => tree.push(`${source}:${current?.kind ?? "none"}`));
  selection.subscribe(({ current }) => inspector.push(current?.kind ?? "none"));

  const canvasSelection = {
    kind: "entity-instance",
    projectSessionId: "session-a",
    projectId: "p1",
    levelId: "level-1",
    entityId: "Player",
  } as const;
  assert.equal(selection.select(canvasSelection, "canvas"), true);
  assert.equal(selection.is("entity-instance"), true);
  assert.equal(selection.current.entityId, "Player");
  assert.equal(selection.select({ ...canvasSelection }, "tree"), false);
  assert.deepEqual(tree, ["canvas:entity-instance"]);
  assert.deepEqual(inspector, ["entity-instance"]);

  assert.equal(selection.clear("project-close"), true);
  assert.deepEqual(tree, ["canvas:entity-instance", "project-close:none"]);
  assert.deepEqual(inspector, ["entity-instance", "none"]);
});

test("registries puros: seleção múltipla tem primária e troca de sessão rejeita evento atrasado", () => {
  const selection = new SelectionService("session-a");
  const player: EntityInstanceSelection = {
    kind: "entity-instance", projectSessionId: "session-a", projectId: "project-a", entityId: "Player",
  };
  const enemy: EntityInstanceSelection = {
    kind: "entity-instance", projectSessionId: "session-a", projectId: "project-a", entityId: "Enemy",
  };
  assert.equal(selection.selectMany([player, enemy], 1, "canvas-marquee"), true);
  assert.equal(selection.primary, enemy);
  assert.deepEqual(selection.selections, [enemy, player]);

  assert.equal(selection.switchSession("session-b"), true);
  assert.equal(selection.primary, undefined);
  assert.deepEqual(selection.selections, []);
  assert.equal(selection.select(player, "late-canvas-event"), false);
  assert.equal(selection.primary, undefined);

  assert.equal(selection.select({
    kind: "project", projectSessionId: "session-b", projectId: "project-b",
  }, "project-open"), true);
  assert.equal(selection.current?.projectId, "project-b");
});

test("registries puros: ferramenta bloqueada é removível da toolbar e perde ativação ao perder capability", () => {
  const registry = new ToolRegistry();
  const selection = new SelectionService("session-a");
  selection.select({
    kind: "cell", projectSessionId: "session-a", projectId: "p1", levelId: "level-1",
    cells: [{ x: 1, y: 2 }],
  }, "canvas");
  const capabilities = mutableCapabilities({
    "level.paint": { enabled: false, reason: "Pintura indisponível durante Play" },
  });
  const context = contributionContext(selection, capabilities.resolve);
  const lifecycle: string[] = [];
  registry.register({
    id: "level.paint.primary",
    kind: "pencil",
    label: "Pincel",
    requiredCapabilities: ["level.paint"],
    supportedSelections: ["level", "cell"],
    activate: () => ({
      cancel: (reason) => lifecycle.push(`cancel:${reason}`),
      dispose: () => lifecycle.push("dispose"),
    }),
  });

  assert.equal(registry.list(context)[0]?.enabled, false);
  assert.equal(registry.list(context, { includeDisabled: false }).length, 0);
  assert.throws(
    () => registry.activate("level.paint.primary", context),
    (error) => error instanceof ContributionUnavailableError
      && error.message === "Pintura indisponível durante Play",
  );

  capabilities.decisions["level.paint"] = { enabled: true, reason: "Edição habilitada" };
  registry.activate("level.paint.primary", context);
  assert.equal(registry.activeId, "level.paint.primary");
  capabilities.decisions["level.paint"] = { enabled: false, reason: "Preview em execução" };
  assert.equal(registry.refresh(context), true);
  assert.equal(registry.activeId, undefined);
  assert.deepEqual(lifecycle, ["cancel:unavailable", "dispose"]);
});

test("registries puros: InspectorRegistry valida inline, representa mixed/read-only e aplica/reset por schema", async () => {
  const registry = new InspectorRegistry();
  const selection = new SelectionService("session-a");
  const first: EntityInstanceSelection = {
    kind: "entity-instance", projectSessionId: "session-a", projectId: "p1",
    levelId: "level-1", entityId: "Player",
  };
  const second: EntityInstanceSelection = {
    kind: "entity-instance", projectSessionId: "session-a", projectId: "p1",
    levelId: "level-1", entityId: "Companion",
  };
  selection.selectMany([first, second], 0, "canvas-marquee");
  const capabilities = mutableCapabilities({
    "entity.edit": { enabled: true, reason: "Entidades editáveis" },
    "assets.reference": { enabled: false, reason: "Catálogo de assets desconectado" },
  });
  const state: Record<string, Record<string, unknown>> = {
    Player: {
      count: 1, speed: 4.5, visible: true, state: "idle", name: "Player",
      tint: "#ff00ffff", position: [10, 20], sprite: "hero.png", target: null,
    },
    Companion: {
      count: 2, speed: 4.5, visible: true, state: "idle", name: "Companion",
      tint: "#ffffffff", position: [30, 20], sprite: "companion.png", target: "Player",
    },
  };
  const fields: readonly InspectorFieldSchema[] = [
    {
      id: "count", path: "count", kind: "int", label: "Quantidade", applyMode: "immediate",
      range: { min: 0, max: 5, step: 1 }, unit: { symbol: "un", label: "unidades" },
      defaultValue: 1, reset: true, multiEdit: true,
    },
    {
      id: "speed", path: "speed", kind: "float", label: "Velocidade", applyMode: "immediate",
      range: { min: 0, max: 20 }, unit: { symbol: "wu/s", label: "unidades de mundo por segundo", system: "world" },
      defaultValue: 3, reset: true, multiEdit: true,
    },
    { id: "visible", path: "visible", kind: "bool", label: "Visível", applyMode: "immediate", multiEdit: true },
    {
      id: "state", path: "state", kind: "enum", label: "Estado", applyMode: "immediate", multiEdit: true,
      options: [{ value: "idle", label: "Parado" }, { value: "run", label: "Correndo" }],
    },
    { id: "name", path: "name", kind: "string", label: "Nome", applyMode: "restart", readOnly: true },
    { id: "tint", path: "tint", kind: "color", label: "Cor", applyMode: "immediate", alpha: true },
    {
      id: "position", path: "position", kind: "vector", label: "Posição", applyMode: "restart",
      dimensions: 2, componentLabels: ["X", "Y"], range: { min: -100, max: 100 }, multiEdit: true,
    },
    {
      id: "sprite", path: "sprite", kind: "asset-reference", label: "Sprite", applyMode: "immediate",
      assetTypes: ["sprite"], requiredCapabilities: ["assets.reference"],
    },
    {
      id: "target", path: "target", kind: "entity-reference", label: "Alvo", applyMode: "immediate",
      allowNone: true, multiEdit: true,
    },
  ];
  registry.register({
    id: "entity.transform-and-properties",
    label: "Entidade",
    requiredCapabilities: ["entity.edit"],
    supportedSelections: ["entity-instance"],
    fields,
    read: (target, field) => state[(target as EntityInstanceSelection).entityId]![field.path],
    apply: ({ selections, path, value }) => {
      for (const target of selections as readonly EntityInstanceSelection[]) {
        state[target.entityId]![path] = value;
      }
    },
  });
  const context: InspectorContext = {
    ...contributionContext(selection, capabilities.resolve),
  };

  const section = registry.resolve(context)[0]!;
  const count = section.fields.find(({ schema }) => schema.id === "count")!;
  assert.equal(count.mixed, true);
  assert.equal(count.enabled, true);
  assert.equal(count.schema.unit?.symbol, "un");
  const name = section.fields.find(({ schema }) => schema.id === "name")!;
  assert.equal(name.readOnly, true);
  assert.equal(name.enabled, false);
  assert.equal(name.reason, "Campo somente leitura.");
  const sprite = section.fields.find(({ schema }) => schema.id === "sprite")!;
  assert.equal(sprite.enabled, false);
  assert.equal(sprite.reason, "Catálogo de assets desconectado");

  const invalid = await registry.edit("entity.transform-and-properties", "count", 8, context);
  assert.equal(invalid.applied, false);
  assert.equal(invalid.issues[0]?.code, "range-max");
  assert.equal(state.Player!["count"], 1);

  const applied = await registry.edit("entity.transform-and-properties", "count", 4, context);
  assert.deepEqual(applied, { applied: true, issues: [], applyMode: "immediate", restartRequired: false });
  assert.equal(state.Player!["count"], 4);
  assert.equal(state.Companion!["count"], 4);

  const restart = await registry.edit("entity.transform-and-properties", "position", [5, 6], context);
  assert.equal(restart.applied, true);
  assert.equal(restart.restartRequired, true);
  assert.deepEqual(state.Player!["position"], [5, 6]);

  const reset = await registry.reset("entity.transform-and-properties", "speed", context);
  assert.equal(reset.applied, true);
  assert.equal(state.Player!["speed"], 3);
  assert.equal(state.Companion!["speed"], 3);
});

test("registries puros: catálogo built-in cobre todas as seleções sem switch central", () => {
  const inspector = new InspectorRegistry();
  registerBuiltinInspectors({ inspector } as unknown as EditorWorkbenchApplication);
  for (const id of [
    "project.properties",
    "level.properties",
    "level.cell",
    "entity.definition",
    "entity.instance",
    "camera.settings",
    "light.properties",
    "asset.summary",
    "problem.summary",
  ]) {
    assert.ok(inspector.get(id), `Inspector built-in ausente: ${id}`);
  }
});
