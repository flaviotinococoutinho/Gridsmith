/**
 * Passo 2 da jornada de aceite (ALPHA-0.1, P0.2): "Novo projeto de plataforma
 * 2D". A decisão de qual template usar é pura e testada aqui; o `main` só
 * traduz o prompt para o diálogo nativo.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BLANK_PROJECT_LABEL,
  CANCEL_LABEL,
  buildNewProjectPrompt,
  resolveNewProjectChoice,
  usableTemplates,
  type ProjectTemplateOption,
} from "../src/core/newProjectChoice.js";

const PLATFORMER: ProjectTemplateOption = {
  id: "platformer-2d",
  label: "Plataforma 2D",
  description: "Nível com chão e paredes, câmera, luz e Player posicionado",
};

const TOP_DOWN: ProjectTemplateOption = {
  id: "top-down",
  label: "Visão de topo",
  description: "Cena vazia com câmera fixa",
};

test("prompt oferece os templates na ordem do middleware, depois branco e cancelar", () => {
  const prompt = buildNewProjectPrompt([PLATFORMER, TOP_DOWN]);
  assert.ok(prompt);
  assert.deepEqual(prompt.buttons, [
    "Plataforma 2D",
    "Visão de topo",
    BLANK_PROJECT_LABEL,
    CANCEL_LABEL,
  ]);
  // caminho feliz da jornada em foco; Esc/X cancela
  assert.equal(prompt.defaultId, 0);
  assert.equal(prompt.cancelId, 3);
  assert.match(prompt.detail, /Plataforma 2D — Nível com chão/);
  // vocabulário humano: nenhum id interno vaza para a UI
  assert.ok(!prompt.buttons.some((button) => button.includes("-")));
  assert.ok(!prompt.detail.includes("platformer-2d"));
});

test("cada botão resolve para a decisão correspondente", () => {
  const templates = [PLATFORMER, TOP_DOWN];
  assert.deepEqual(resolveNewProjectChoice(templates, 0), {
    kind: "template",
    templateId: "platformer-2d",
  });
  assert.deepEqual(resolveNewProjectChoice(templates, 1), {
    kind: "template",
    templateId: "top-down",
  });
  assert.deepEqual(resolveNewProjectChoice(templates, 2), { kind: "blank" });
  assert.deepEqual(resolveNewProjectChoice(templates, 3), { kind: "cancel" });
});

test("resposta inesperada do diálogo nunca substitui a sessão ativa (fail-safe)", () => {
  const templates = [PLATFORMER];
  for (const response of [-1, 99, 1.5, Number.NaN]) {
    assert.deepEqual(
      resolveNewProjectChoice(templates, response),
      { kind: "cancel" },
      `resposta ${String(response)} deve cancelar`,
    );
  }
});

test("sem template utilizável não há prompt: o fluxo cai no projeto em branco", () => {
  assert.equal(buildNewProjectPrompt([]), undefined);
  assert.equal(
    buildNewProjectPrompt([{ id: "  ", label: "Sem id", description: "" }]),
    undefined,
  );
  assert.equal(
    buildNewProjectPrompt([{ id: "sem-rotulo", label: "   ", description: "" }]),
    undefined,
  );
  // sem template, a única decisão possível é branco/cancelar
  assert.deepEqual(resolveNewProjectChoice([], 0), { kind: "blank" });
  assert.deepEqual(resolveNewProjectChoice([], 1), { kind: "cancel" });
});

test("templates inválidos e duplicados são filtrados antes de virar botão", () => {
  const templates: ProjectTemplateOption[] = [
    PLATFORMER,
    { id: "platformer-2d", label: "Duplicado", description: "" },
    { id: "", label: "Sem id", description: "" },
    TOP_DOWN,
  ];
  assert.deepEqual(
    usableTemplates(templates).map((template) => template.id),
    ["platformer-2d", "top-down"],
  );
  const prompt = buildNewProjectPrompt(templates);
  assert.ok(prompt);
  assert.deepEqual(prompt.buttons, [
    "Plataforma 2D",
    "Visão de topo",
    BLANK_PROJECT_LABEL,
    CANCEL_LABEL,
  ]);
  // os índices continuam alinhados com a lista FILTRADA
  assert.deepEqual(resolveNewProjectChoice(templates, 1), {
    kind: "template",
    templateId: "top-down",
  });
});

test("template sem descrição ainda aparece; o detalhe não fica com traço solto", () => {
  const prompt = buildNewProjectPrompt([{ id: "vazio", label: "Cena vazia", description: "  " }]);
  assert.ok(prompt);
  assert.equal(prompt.detail, "Cena vazia");
});
