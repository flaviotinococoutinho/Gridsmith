import assert from "node:assert/strict";
import { test } from "node:test";
import { ExperienceGate, type ResolvedExperienceLike } from "../src/core/experienceGate.js";

const EXPERIENCE: ResolvedExperienceLike = {
  family: "monogame",
  profileVersion: "3.8.2",
  displayName: "MonoGame 3.8.2 (DesktopGL)",
  constraints: { maxTextureSize: 8192 },
  decisions: [
    { feature: "level.intgrid-editor", enabled: true, source: "live-manifest", reason: "subsistema level ativo" },
    { feature: "lighting.deferred-pipeline", enabled: true, source: "live-manifest", reason: "MRT + lighting ativos" },
    { feature: "shaders.hlsl-editing", enabled: true, source: "profile-rule", reason: "HLSL suportado" },
    { feature: "assets.mgcb-compile", enabled: true, source: "profile-rule", reason: "MGCB presente" },
    { feature: "preview.embedded", enabled: false, source: "profile-rule", reason: "chega no perfil 3.8.2" },
    { feature: "debug.overlay", enabled: false, source: "live-manifest", reason: "sem engine conectada" },
  ],
};

test("painéis habilitam quando todos os requisitos estão habilitados", () => {
  const gate = new ExperienceGate(EXPERIENCE);
  assert.equal(gate.panel("level-editor").enabled, true);
  assert.equal(gate.panel("lighting-pipeline").enabled, true);
  assert.equal(gate.panel("asset-compiler").enabled, true);
});

test("painel desabilitado carrega a RAZÃO da governança", () => {
  const gate = new ExperienceGate(EXPERIENCE);
  const preview = gate.panel("embedded-preview");
  assert.equal(preview.enabled, false);
  assert.equal(preview.reason, "chega no perfil 3.8.2");

  const overlay = gate.panel("debug-overlay");
  assert.equal(overlay.enabled, false);
  assert.match(overlay.reason, /sem engine conectada/);
});

test("recurso não governado é fail-safe (desabilitado com explicação)", () => {
  const gate = new ExperienceGate(EXPERIENCE);
  const unknown = gate.feature("teleport.quantum");
  assert.equal(unknown.enabled, false);
  assert.match(unknown.reason, /not governed/);
  assert.equal(gate.panel("unknown-panel").enabled, false);
});

test("allPanels materializa a régua completa da UI e o label do runtime", () => {
  const gate = new ExperienceGate(EXPERIENCE);
  const panels = gate.allPanels();
  assert.deepEqual(
    Object.entries(panels).filter(([, a]) => a.enabled).map(([id]) => id).sort(),
    ["asset-compiler", "level-editor", "lighting-pipeline", "shader-editor"],
  );
  assert.equal(gate.runtimeLabel, "MonoGame 3.8.2 (DesktopGL) (perfil 3.8.2)");
  assert.equal(gate.constraints["maxTextureSize"], 8192);
});
