/**
 * Perfis da família MonoGame — dados declarativos versionados
 * (docs/CANONICAL-MODEL.md §3). Perfis publicados são imutáveis: mudanças
 * entram como nova versão.
 */

import type { RuntimeProfile } from "../RuntimeProfile.js";

export const MONOGAME_3_8: RuntimeProfile = {
  family: "monogame",
  version: "3.8.0",
  displayName: "MonoGame 3.8 (DesktopGL)",
  capabilities: [
    "content-pipeline.mgcb",
    "render.spritebatch",
    "render.mrt",
    "render.custom-shaders.hlsl",
    "ipc.named-pipes",
    "ipc.shared-memory",
  ],
  editorRules: [
    {
      feature: "assets.mgcb-compile",
      effect: "enable",
      requiresCapability: "content-pipeline.mgcb",
      reason: "MGCB compila .fx/.png para .xnb nesta família",
    },
    {
      feature: "shaders.hlsl-editing",
      effect: "enable",
      requiresCapability: "render.custom-shaders.hlsl",
      reason: "Efeitos HLSL customizados são suportados",
    },
    {
      feature: "lighting.deferred-pipeline",
      effect: "enable",
      requiresCapability: "render.mrt",
      requiresSubsystem: "lighting",
      reason: "MRT disponível e subsistema de iluminação ativo na engine",
    },
    {
      feature: "level.intgrid-editor",
      effect: "enable",
      requiresSubsystem: "level",
      reason: "Engine conectada expõe o subsistema de níveis",
    },
    {
      feature: "preview.embedded",
      effect: "disable",
      reason: "Preview embutido chega no perfil 3.8.2 (host gráfico acoplável)",
    },
    {
      feature: "debug.overlay",
      effect: "disable",
      reason: "Overlay de debug chega no perfil 3.8.2",
    },
  ],
  constraints: {
    maxTextureSize: 4096,
    maxVertexShaderRegisters: 256,
  },
};

export const MONOGAME_3_8_2: RuntimeProfile = {
  family: "monogame",
  version: "3.8.2",
  displayName: "MonoGame 3.8.2 (DesktopGL)",
  capabilities: [...MONOGAME_3_8.capabilities, "preview.embedded-host", "debug.frame-overlay"],
  editorRules: [
    // regras herdadas que permanecem válidas
    ...MONOGAME_3_8.editorRules.filter(
      (rule) => rule.feature !== "preview.embedded" && rule.feature !== "debug.overlay",
    ),
    {
      feature: "preview.embedded",
      effect: "enable",
      requiresCapability: "preview.embedded-host",
      reason: "Host gráfico DesktopGL acoplável ao painel do editor",
    },
    {
      feature: "debug.overlay",
      effect: "enable",
      requiresCapability: "debug.frame-overlay",
      requiresSubsystem: "camera",
      reason: "Overlay de frame pacing/câmera disponível com o subsistema de câmera",
    },
  ],
  constraints: {
    maxTextureSize: 8192,
    maxVertexShaderRegisters: 256,
  },
};

export const MONOGAME_PROFILES: readonly RuntimeProfile[] = [MONOGAME_3_8, MONOGAME_3_8_2];
