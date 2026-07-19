import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformer2DDocument } from "@p7m/middleware/dist/canonical/ProjectTemplates.js";
import { selectLevelEditorProjection } from "../src/core/levelEditorProjection.js";

const FRONTEND_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relativePath: string): string =>
  fs.readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");

test("projeto de exemplo versionado é o resultado exato do factory real", () => {
  const versioned = JSON.parse(source("examples/platformer-2d-example.p7m.json")) as unknown;
  const generated = createPlatformer2DDocument({
    projectId: "example-platformer-2d",
    name: "Exemplo Plataforma 2D",
  });

  assert.deepEqual(versioned, generated);
});

test("projeção do renderer preserva IDs, tile size e dimensões do documento", () => {
  const level = {
    levelId: "level-from-document-97",
    width: 37,
    height: 23,
    tileSize: 48,
    seed: 91,
    intGrid: new Array<number>(37 * 23).fill(0),
    rules: [{ patternSize: 1 as const, pattern: [1], tileIds: [7] }],
  };
  const entity = {
    entityId: "hero-instance-from-document",
    entityDefId: "hero-definition-from-document",
    position: [120, 216] as const,
  };

  const otherLevel = { ...level, levelId: "other-level" };
  const selected = selectLevelEditorProjection({
    levels: [otherLevel, level],
    entities: [entity],
    entityDefs: [{
      entityDefId: "hero-definition-from-document",
      archetypeId: "player",
    }],
  }, "level-from-document-97");

  assert.strictEqual(selected.level, level, "não recria nem normaliza o nível no renderer");
  assert.equal(selected.level?.levelId, "level-from-document-97");
  assert.equal(selected.level?.width, 37);
  assert.equal(selected.level?.height, 23);
  assert.equal(selected.level?.tileSize, 48);
  assert.strictEqual(selected.entities[0], entity, "mantém o ID e a posição da instância real");
  assert.equal(selected.playerEntityDefinitionId, "hero-definition-from-document");

  const rendererSource = source("src/renderer/levelEditorView.ts");
  assert.match(
    rendererSource,
    /store\.select\(ctx\.preferredLevelId\)/,
  );
  assert.match(rendererSource, /kind: "level\/patch"/);
  assert.match(rendererSource, /"Recalcular arte"/);
  assert.doesNotMatch(rendererSource, /"Publicar nível"|toLevelPayload/);
  assert.doesNotMatch(
    rendererSource,
    /["'](?:nivel-1|level-1|jogador)["']/,
    "o renderer não pode inventar IDs de nível ou jogador",
  );
});

test("preload expõe o ciclo de vida somente por operações nomeadas e tipadas", () => {
  const preload = source("src/main/preload.ts");
  const required = [
    "listProjectTemplates",
    "createProjectFromTemplate",
    "openProject",
    "saveProject",
    "saveProjectAs",
    "closeProject",
    "restoreAutosave",
    "discardAutosave",
    "openRecent",
  ];

  const interfaceStart = preload.indexOf("// ---- ciclo de vida do projeto");
  const interfaceEnd = preload.indexOf("  projectStatus()", interfaceStart);
  assert.ok(interfaceStart >= 0 && interfaceEnd > interfaceStart);
  const interfaceMethods = [
    ...preload.slice(interfaceStart, interfaceEnd).matchAll(/^  (\w+)\(/gm),
  ].map((match) => match[1]);
  assert.deepEqual(interfaceMethods, required);

  const apiStart = preload.indexOf("  listProjectTemplates:");
  const apiEnd = preload.indexOf("  projectStatus:", apiStart);
  assert.ok(apiStart >= 0 && apiEnd > apiStart);
  const apiMethods = [
    ...preload.slice(apiStart, apiEnd).matchAll(/^  (\w+):/gm),
  ].map((match) => match[1]);
  assert.deepEqual(apiMethods, required);

  assert.doesNotMatch(preload, /projectCommand/);
  for (const typeName of [
    "CreateProjectFromTemplateRequest",
    "OpenProjectRequest",
    "RestoreAutosaveRequest",
    "DiscardAutosaveRequest",
    "ProjectActionResult",
  ]) {
    assert.match(preload, new RegExp(`\\b${typeName}\\b`));
  }
});

test("Save As preserva exatamente o caminho confirmado pelo diálogo nativo", () => {
  const dialogs = source("src/main/project/ElectronProjectDialogs.ts");
  assert.match(dialogs, /return result\.filePath;/);
  assert.doesNotMatch(dialogs, /extname|ensureProjectExtension/);
});

test("edição canônica: undo global, paleta e limpeza de gestos estão ligados ao shell", () => {
  const renderer = source("src/renderer/renderer.ts");
  const levelEditor = source("src/renderer/levelEditorView.ts");
  const main = source("src/main/main.ts");
  const commands = source("src/core/editorCommands.ts");

  assert.match(renderer, /window\.addEventListener\("keydown"/);
  assert.match(renderer, /window\.p7m\.undo\(\)/);
  assert.match(renderer, /HISTORY_ACTOR_LABELS\[entry\.actor\]/);
  assert.doesNotMatch(renderer, /activeEditor.*undo|doc\.undo/);

  assert.match(levelEditor, /"level\/palette"/);
  assert.match(levelEditor, /"Editar paleta…"/);
  assert.match(levelEditor, /if \(!confirmationUncertain\) window\.p7m\.endEditGesture/);
  assert.match(levelEditor, /window\.removeEventListener\("mouseup", onMouseUp\)/);
  assert.doesNotMatch(commands, /coalesce/);
  assert.match(main, /"render-process-gone".*clearEditGestures/);
  assert.match(main, /event\.transactionId.*endEditGesture/s);
  assert.match(main, /onResynchronized[\s\S]*clearEditGestures/);
  const editorClient = source("src/main/EditorClient.ts");
  assert.match(editorClient, /requestResync\("dispatch_confirmation_uncertain"\)/);
});
