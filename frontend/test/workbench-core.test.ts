import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENT_LABELS,
  eventLabel,
  humanize,
  projectionLabel,
} from "../src/core/vocabulary.js";
import { EventLog, subjectOf } from "../src/core/eventLog.js";
import { WorkbenchModel } from "../src/core/workbenchModel.js";
import { PanelRegistry } from "../src/core/panelRegistry.js";
import { SelectionService } from "../src/core/selectionService.js";
import { denyUnknownCapabilities } from "../src/core/capabilityRegistry.js";
import { EditorModeService } from "../src/core/editorModeService.js";
import { WorkbenchMetrics } from "../src/core/workbenchMetrics.js";
import type { ContributionContext } from "../src/core/contributionContext.js";

// ---------- Vocabulário (P0.3: IDs internos nunca aparecem) ----------

test("painel carrega o próprio rótulo humano sem catálogo central", () => {
  const panels = new PanelRegistry();
  panels.register({
    id: "future.scene-statistics",
    label: "Estatísticas da cena",
    defaultRegion: "bottom",
    requiredCapabilities: [],
    mount: () => ({ dispose: () => undefined }),
  });
  const context = workbenchContext({});
  const model = new WorkbenchModel(panels, context);
  assert.equal(model.navigation()[0]?.label, "Estatísticas da cena");
  assert.equal(model.navigation()[0]?.panelId, "future.scene-statistics");
});

test("todo kind de evento do Blueprint tem rótulo humano", () => {
  // kinds vêm do union BlueprintEvent do middleware
  const kinds = [
    "skeletonDefined", "meshBound", "cameraConfigured", "lightAdded", "lightRemoved",
    "entityDefDefined", "entityPlaced", "entityMoved", "entityRemoved",
    "levelDefined", "levelUpdated", "levelRemoved",
    "worldLevelPlaced", "worldLevelUnplaced",
  ];
  for (const kind of kinds) {
    assert.ok(EVENT_LABELS[kind], `evento "${kind}" sem tradução`);
  }
});

test("fallback humanize é legível e status de projeção são traduzidos", () => {
  assert.equal(humanize("preview.embedded"), "Preview embedded");
  assert.equal(humanize("level-editor"), "Level editor");
  assert.equal(projectionLabel("deferred"), "Pendente (runtime desconectado)");
  assert.equal(eventLabel("algoNovo"), "AlgoNovo"); // desconhecido não quebra
});

// ---------- EventLog (P0.3: log estruturado) ----------

test("entrada carrega rótulo, objeto afetado e razão da projeção", () => {
  let now = 1_000;
  const log = new EventLog(10, () => now++);
  const entry = log.record(
    { kind: "entityPlaced", entity: { entityId: "goblin-1" } },
    { status: "skipped", reason: "sem spawn table para 'Goblin'" },
  );

  assert.equal(entry.label, "Entidade posicionada");
  assert.equal(entry.subject, "goblin-1");
  assert.equal(entry.summary, "Entidade posicionada: goblin-1");
  assert.equal(entry.projectionLabel, "Não aplicado (sem suporte)");
  assert.equal(entry.projectionReason, "sem spawn table para 'Goblin'");
});

test("subjectOf extrai o id dos shapes conhecidos", () => {
  assert.equal(subjectOf({ light: { lightId: "sun" } }), "sun");
  assert.equal(subjectOf({ lightId: "sun" }), "sun");
  assert.equal(subjectOf({ level: { levelId: "l1" } }), "l1");
  assert.equal(subjectOf({ placement: { levelId: "l2" } }), "l2");
  assert.equal(subjectOf({ settings: { frequency: 2 } }), undefined);
});

test("filtro por texto e status; problemCount conta skipped/deferred; capacidade limitada", () => {
  const log = new EventLog(3, () => 0);
  log.record({ kind: "lightAdded", light: { lightId: "sun" } }, { status: "projected" });
  log.record({ kind: "entityPlaced", entity: { entityId: "e1" } }, { status: "skipped", reason: "x" });
  log.record({ kind: "levelDefined", level: { levelId: "forest" } }, { status: "deferred", reason: "y" });
  log.record({ kind: "lightRemoved", lightId: "sun" }, { status: "projected" });

  assert.equal(log.size, 3); // capacidade: o mais antigo caiu
  assert.equal(log.list({ status: "skipped" }).length, 1);
  assert.equal(log.list({ text: "forest" })[0]?.subject, "forest");
  assert.equal(log.list({ text: "FOREST" }).length, 1); // case-insensitive
  assert.equal(log.problemCount, 2);
  // mais recente primeiro
  assert.equal(log.list()[0]?.kind, "lightRemoved");
});

test("ack e eco do journal da mesma sessão convergem em uma única entrada com diagnóstico", () => {
  const log = new EventLog(10, () => 42);
  const event = {
    kind: "entityMoved",
    entityId: "Player",
    projectSessionId: "session-a",
    projectId: "project-a",
    commandSequence: "17",
  };
  log.record(event);
  log.record(event, { status: "deferred", reason: "engine desconectada" });

  assert.equal(log.size, 1);
  assert.equal(log.problemCount, 1);
  assert.equal(log.list()[0]?.commandSequence, "17");
  assert.equal(log.list()[0]?.projectionReason, "engine desconectada");
});

// ---------- WorkbenchModel: foco derivado das contribuições ----------

function workbenchContext(
  capabilities: Readonly<Record<string, { readonly enabled: boolean; readonly reason: string }>>,
): ContributionContext {
  return {
    selection: new SelectionService(),
    capabilities: denyUnknownCapabilities(capabilities),
    mode: "edit",
  };
}

function workbenchPanels(): PanelRegistry {
  const panels = new PanelRegistry();
  panels.register({
    id: "level.editor",
    label: "Editor de nível",
    defaultRegion: "center",
    requiredCapabilities: [],
    order: 0,
    mount: () => ({ dispose: () => undefined }),
  });
  panels.register({
    id: "runtime.preview",
    label: "Preview",
    defaultRegion: "center",
    requiredCapabilities: ["preview.embedded"],
    order: 10,
    mount: () => ({ dispose: () => undefined }),
  });
  panels.register({
    id: "diagnostics.problems",
    label: "Problemas",
    defaultRegion: "bottom",
    requiredCapabilities: [],
    mount: () => ({ dispose: () => undefined }),
  });
  panels.register({
    id: "diagnostics.performance",
    label: "Performance",
    defaultRegion: "bottom",
    requiredCapabilities: [],
    order: 10,
    mount: () => ({ dispose: () => undefined }),
  });
  return panels;
}

test("sem capability: contribuição afetada é bloqueada com razão, editor offline permanece", () => {
  const model = new WorkbenchModel(workbenchPanels(), workbenchContext({}));
  const editor = model.navigation().find(({ panelId }) => panelId === "level.editor")!;
  const preview = model.navigation().find(({ panelId }) => panelId === "runtime.preview")!;
  assert.equal(editor.enabled, true);
  assert.equal(model.currentPanel, "level.editor");
  assert.equal(preview.enabled, false);
  assert.match(preview.reason ?? "", /não está disponível/);
});

test("ativar painel bloqueado é recusado; mudança de capability realoca foco", () => {
  const panels = workbenchPanels();
  const model = new WorkbenchModel(panels, workbenchContext({
    "preview.embedded": { enabled: true, reason: "Preview disponível" },
  }));
  assert.equal(model.activatePanel("runtime.preview"), true);
  assert.equal(model.currentPanel, "runtime.preview");
  model.updateContext(workbenchContext({
    "preview.embedded": { enabled: false, reason: "Runtime desconectado" },
  }));
  assert.equal(model.currentPanel, "level.editor");
  assert.equal(model.activatePanel("runtime.preview"), false);
});

test("notificações e aba inferior usam IDs contribuídos, sem union fixa", () => {
  const model = new WorkbenchModel(workbenchPanels(), workbenchContext({}));
  let changes = 0;
  model.onChange(() => changes++);
  assert.equal(model.selectBottomTab("diagnostics.performance"), true);
  assert.equal(model.currentBottomTab, "diagnostics.performance");
  assert.equal(model.activatePanel("level.editor"), true);
  assert.equal(changes, 1);
});

test("modo do editor notifica transições sem iniciar runtime ou duplicar no-op", () => {
  const mode = new EditorModeService();
  const changes: unknown[] = [];
  mode.subscribe((change) => changes.push(change));
  assert.equal(mode.set("playing", "toolbar"), true);
  assert.equal(mode.set("playing", "duplicado"), false);
  assert.equal(mode.set("paused", "toolbar"), true);
  assert.deepEqual(changes, [
    { previous: "edit", current: "playing", source: "toolbar" },
    { previous: "playing", current: "paused", source: "toolbar" },
  ]);
});

test("métricas do Performance panel são determinísticas e notificam cada amostra", () => {
  const metrics = new WorkbenchMetrics(() => 1234);
  let notifications = 0;
  metrics.subscribe(() => notifications++);
  metrics.record("blueprint-event");
  metrics.record("projection-resync");
  metrics.record("command");
  metrics.record("panel-activation");
  assert.deepEqual(metrics.snapshot, {
    startedAt: 1234,
    blueprintEvents: 1,
    projectionResyncs: 1,
    commandsExecuted: 1,
    panelActivations: 1,
  });
  assert.equal(notifications, 4);
});
