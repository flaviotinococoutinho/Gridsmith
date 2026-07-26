import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENT_LABELS,
  PANEL_LABELS,
  eventLabel,
  humanize,
  panelLabel,
  projectionLabel,
} from "../src/core/vocabulary.js";
import { PANEL_REQUIREMENTS } from "../src/core/experienceGate.js";
import { EventLog, subjectOf } from "../src/core/eventLog.js";
import { WorkbenchModel } from "../src/core/workbenchModel.js";
import type { ResolvedExperienceLike } from "../src/core/experienceGate.js";

// ---------- Vocabulário (P0.3: IDs internos nunca aparecem) ----------

test("todo painel do gate tem rótulo humano em pt-BR (cobertura total)", () => {
  for (const panelId of Object.keys(PANEL_REQUIREMENTS)) {
    assert.ok(PANEL_LABELS[panelId], `painel "${panelId}" sem tradução`);
    assert.notEqual(panelLabel(panelId), panelId, "rótulo não pode ser o ID cru");
  }
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

// ---------- WorkbenchModel (P0.3: navegação governada) ----------

const EXPERIENCE: ResolvedExperienceLike = {
  family: "monogame",
  profileVersion: "3.8.2",
  displayName: "MonoGame 3.8.2 (DesktopGL)",
  constraints: {},
  decisions: [
    { feature: "level.intgrid-editor", enabled: true, source: "live-manifest", reason: "ok" },
    { feature: "lighting.deferred-pipeline", enabled: true, source: "live-manifest", reason: "ok" },
    { feature: "shaders.hlsl-editing", enabled: true, source: "profile-rule", reason: "ok" },
    { feature: "assets.mgcb-compile", enabled: true, source: "profile-rule", reason: "ok" },
    { feature: "preview.embedded", enabled: false, source: "profile-rule", reason: "chega no 3.8.2" },
    { feature: "debug.overlay", enabled: false, source: "live-manifest", reason: "sem engine" },
  ],
};

test("sem experiência: tudo desabilitado com razão de aguardo (fail-safe)", () => {
  const model = new WorkbenchModel();
  const items = model.navigation();
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => !i.enabled));
  assert.match(items[0]?.reason ?? "", /Aguardando conexão/);
  assert.equal(model.runtimeLabel, "Runtime desconectado");
});

test("experiência aplicada: rótulos humanos, foco automático no primeiro habilitado", () => {
  const model = new WorkbenchModel();
  model.applyExperience(EXPERIENCE);
  // habilitar painel exige DOIS eixos: governança de runtime E projeto aberto
  model.applyProjectState("open-clean");

  const items = model.navigation();
  const level = items.find((i) => i.panelId === "level-editor")!;
  assert.equal(level.label, "Editor de níveis");
  assert.equal(level.enabled, true);
  assert.equal(level.active, true); // primeiro habilitado ganha o foco
  assert.equal(model.currentPanel, "level-editor");

  const preview = items.find((i) => i.panelId === "embedded-preview")!;
  assert.equal(preview.enabled, false);
  assert.equal(preview.reason, "chega no 3.8.2"); // razão da governança no tooltip
});

test("ativar painel desabilitado é recusado; re-resolução tira o foco de painel que sumiu", () => {
  const model = new WorkbenchModel();
  model.applyExperience(EXPERIENCE);
  model.applyProjectState("open-clean");
  assert.equal(model.activatePanel("embedded-preview"), false);
  assert.equal(model.currentPanel, "level-editor");

  assert.equal(model.activatePanel("lighting-pipeline"), true);
  assert.equal(model.currentPanel, "lighting-pipeline");

  // a engine caiu: lighting exige subsistema vivo → desabilitado
  model.applyExperience({
    ...EXPERIENCE,
    decisions: EXPERIENCE.decisions.map((d) =>
      d.feature === "lighting.deferred-pipeline" ? { ...d, enabled: false, reason: "engine caiu" } : d,
    ),
  });
  assert.notEqual(model.currentPanel, "lighting-pipeline"); // foco realocado
});

test("notificações de mudança e aba inferior", () => {
  const model = new WorkbenchModel();
  let changes = 0;
  model.onChange(() => changes++);
  model.applyExperience(EXPERIENCE);
  model.selectBottomTab("problems");
  assert.equal(model.currentBottomTab, "problems");
  assert.ok(changes >= 2);
});

// ------------------------------------------- gating por projeto aberto (F8)

test("sem projeto aberto nenhum painel de edição habilita, mesmo com a governança OK", () => {
  const model = new WorkbenchModel();
  model.applyExperience(EXPERIENCE);
  // default fail-safe: o model nasce em "no-project"
  for (const item of model.navigation()) {
    assert.equal(item.enabled, false, `${item.panelId} não deveria habilitar sem projeto`);
    assert.ok((item.reason ?? "").length > 0, `${item.panelId} sem razão exibível`);
  }
  assert.equal(model.currentPanel, undefined);
});

test("a governança tem precedência: sua razão nunca é mascarada pela de projeto", () => {
  const model = new WorkbenchModel();
  model.applyExperience(EXPERIENCE);

  // sem projeto, o painel que a governança JÁ negava mantém a razão do perfil
  const semProjeto = model.navigation().find((i) => i.panelId === "embedded-preview")!;
  assert.equal(semProjeto.reason, "chega no 3.8.2");

  // e o painel que a governança permite recebe a razão do eixo de projeto
  const level = model.navigation().find((i) => i.panelId === "level-editor")!;
  assert.match(level.reason ?? "", /projeto/i);
});

test("abrir projeto foca o primeiro painel habilitado; fechar desfoca", () => {
  const model = new WorkbenchModel();
  model.applyExperience(EXPERIENCE);
  assert.equal(model.currentPanel, undefined);

  model.applyProjectState("open-clean");
  assert.equal(model.currentPanel, "level-editor");

  // fechar o projeto não pode deixar o editor montado sobre nada
  model.applyProjectState("no-project");
  assert.equal(model.currentPanel, undefined);
  assert.equal(model.navigation().every((i) => !i.enabled), true);
});

test("estado de projeto repetido não notifica à toa", () => {
  const model = new WorkbenchModel();
  model.applyExperience(EXPERIENCE);
  model.applyProjectState("open-clean");
  let changes = 0;
  model.onChange(() => changes++);
  model.applyProjectState("open-clean");
  assert.equal(changes, 0);
  model.applyProjectState("open-dirty");
  assert.equal(changes, 1);
});
