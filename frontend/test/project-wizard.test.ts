import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectWizardModel } from "../src/core/projectWizardModel.js";
import { platformerTemplateDescriptor } from "./project-test-fakes.js";

test("wizard seleciona Plataforma 2D real e produz request tipado", () => {
  const model = new ProjectWizardModel([platformerTemplateDescriptor()]);
  assert.equal(model.selectedTemplate?.id, "platformer-2d");
  assert.equal(model.referenceWidth, 1280);
  assert.equal(model.referenceHeight, 720);
  assert.equal(model.tileSize, 16);

  model.update({ name: "Jogo", width: 1920, height: 1080, tileSize: 32 });
  assert.deepEqual(model.buildRequest(), {
    templateId: "platformer-2d",
    name: "Jogo",
    referenceResolution: { width: 1920, height: 1080 },
    tileSize: 32,
  });
});

test("wizard recusa nome, resolução e tile inválidos", () => {
  const model = new ProjectWizardModel([platformerTemplateDescriptor()]);
  model.update({ name: " ", width: 0, tileSize: 0 });
  assert.throws(() => model.buildRequest());

  model.update({ name: "Limite", width: 1280, tileSize: 256 });
  assert.equal(model.buildRequest().tileSize, 256);
  model.update({ tileSize: 257 });
  assert.throws(() => model.buildRequest(), /entre 1 e 256/);
});
