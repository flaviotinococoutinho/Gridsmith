import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExperienceGate,
  localizeCapabilityReason,
  type ResolvedExperienceLike,
} from "../src/core/experienceGate.js";

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

test("capabilities habilitadas preservam a decisão do perfil", () => {
  const gate = new ExperienceGate(EXPERIENCE);
  assert.equal(gate.feature("level.intgrid-editor").enabled, true);
  assert.equal(gate.feature("lighting.deferred-pipeline").enabled, true);
  assert.equal(gate.feature("assets.mgcb-compile").enabled, true);
});

test("capability desabilitada carrega a RAZÃO da governança", () => {
  const gate = new ExperienceGate(EXPERIENCE);
  const preview = gate.feature("preview.embedded");
  assert.equal(preview.enabled, false);
  assert.equal(preview.reason, "chega no perfil 3.8.2");

  const overlay = gate.feature("debug.overlay");
  assert.equal(overlay.enabled, false);
  assert.match(overlay.reason, /sem engine conectada/);
});

test("recurso não governado é fail-safe (desabilitado com explicação)", () => {
  const gate = new ExperienceGate(EXPERIENCE);
  const unknown = gate.feature("teleport.quantum");
  assert.equal(unknown.enabled, false);
  assert.match(unknown.reason, /não está disponível/);
  assert.match(unknown.reason, /Teleport quantum/);
});

test("razões técnicas do governor são apresentadas em português", () => {
  assert.equal(
    localizeCapabilityReason('no engine connected to confirm subsystem "camera" (fail-safe: disabled)'),
    "Nenhuma engine está conectada para confirmar o subsistema “camera”; recurso desabilitado por segurança.",
  );
  assert.equal(
    localizeCapabilityReason('subsystem "lighting" is absent in the connected engine'),
    "O subsistema “lighting” está ausente na engine conectada.",
  );
});

test("gate não conhece painéis e mantém metadata do runtime", () => {
  const gate = new ExperienceGate(EXPERIENCE);
  assert.equal("panel" in gate, false);
  assert.equal("allPanels" in gate, false);
  assert.equal(gate.runtimeLabel, "MonoGame 3.8.2 (DesktopGL) (perfil 3.8.2)");
  assert.equal(gate.constraints["maxTextureSize"], 8192);
});
