import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlatformer2DDocument } from "@p7m/middleware/dist/canonical/ProjectTemplates.js";
import { ProjectLifecycle } from "../src/core/projectLifecycle.js";
import {
  ProjectController,
  SingleInstanceProjectLeaseRegistry,
} from "../src/main/project/ProjectController.js";
import { ProjectFileService } from "../src/main/project/ProjectFileService.js";
import {
  FakeEditorProjectPort,
  FakeProjectDialogs,
  MemoryProjectFileSystem,
  platformerTemplateDescriptor,
} from "./project-test-fakes.js";

function harness(initialRecents: ConstructorParameters<typeof ProjectLifecycle>[2] = []) {
  let id = 0;
  const lifecycle = new ProjectLifecycle(() => 10_000 + id, {}, initialRecents);
  const fileSystem = new MemoryProjectFileSystem();
  const files = new ProjectFileService(fileSystem, () => `tmp-${++id}`);
  const dialogs = new FakeProjectDialogs();
  const editor = new FakeEditorProjectPort(
    (options) => createPlatformer2DDocument(options),
    [platformerTemplateDescriptor()],
  );
  const controller = new ProjectController({
    lifecycle,
    editor,
    files,
    dialogs,
    leases: new SingleInstanceProjectLeaseRegistry(),
    exampleProjectPath: "/app/examples/platformer.p7m.json",
    createId: () => `project-${++id}`,
  });
  return { lifecycle, fileSystem, files, dialogs, editor, controller };
}

async function openUnsavedProject(h: ReturnType<typeof harness>): Promise<void> {
  const document = createPlatformer2DDocument({ projectId: "unsaved", name: "Sem caminho" });
  const remote = await h.editor.openProjectDocument(document);
  h.lifecycle.beginOpen();
  h.lifecycle.opened({
    name: "Sem caminho",
    projectSessionId: remote.status.projectSessionId,
    projectId: remote.status.projectId,
  });
  const committed = h.editor.commitExternalCommand("camera/configure", {
    settings: { response: 3 },
  });
  h.lifecycle.commandApplied(committed.event.commandSequence);
}

test("Novo Plataforma 2D cria arquivo e sessão com level-1, Player, câmera e luz", async () => {
  const h = harness();
  h.dialogs.projectDirectory = "/projects";

  const result = await h.controller.createProjectFromTemplate({
    templateId: "platformer-2d",
    name: "Meu jogo",
    referenceResolution: { width: 1920, height: 1080 },
    tileSize: 32,
  });

  assert.equal(result.outcome, "completed");
  assert.equal(result.openedLevelId, "level-1");
  assert.equal(h.editor.materializeCalls[0]?.templateId, "platformer-2d");
  assert.equal(h.editor.openCalls, 1, "criação ativa uma sessão real pelo documento do template");
  const document = h.editor.currentDocument as ReturnType<typeof createPlatformer2DDocument>;
  assert.equal(document.levels[0]?.levelId, "level-1");
  assert.equal(document.levels[0]?.tileSize, 32);
  assert.equal(document.entityDefs[0]?.entityDefId, "player");
  assert.equal(document.entities[0]?.entityId, "player-1");
  assert.equal(document.lights[0]?.lightId, "key-light");
  assert.ok(Object.keys(document.camera).length > 0);
  assert.equal(document.metadata.name, "Meu jogo");
  assert.ok(h.fileSystem.content("/projects/Meu jogo.p7m.json"));
  assert.equal(h.lifecycle.project?.filePath, "/projects/Meu jogo.p7m.json");
});

test("resposta perdida após commit de New reconcilia sessão e preserva arquivo", async () => {
  const h = harness();
  h.dialogs.projectDirectory = "/projects";
  h.editor.failOpenAfterCommit = true;

  const result = await h.controller.createProjectFromTemplate({
    templateId: "platformer-2d",
    name: "Commit ambíguo",
    referenceResolution: { width: 1280, height: 720 },
    tileSize: 16,
  });

  assert.equal(result.outcome, "completed");
  assert.equal(h.lifecycle.project?.projectId, h.editor.currentDocument &&
    (h.editor.currentDocument as { projectId: string }).projectId);
  assert.ok(h.fileSystem.content("/projects/Commit ambíguo.p7m.json"));
});

test("Save no fechamento sem caminho abre Save As e só fecha após escrita confirmada", async () => {
  const h = harness();
  await openUnsavedProject(h);
  h.dialogs.unsavedDecision = "save";
  h.dialogs.savePath = "/projects/salvo.p7m.json";

  const result = await h.controller.closeProject();

  assert.equal(result.outcome, "completed");
  assert.equal(h.dialogs.chooseSaveCalls, 1);
  assert.ok(h.fileSystem.content("/projects/salvo.p7m.json"));
  assert.equal(h.editor.closeCalls, 1);
  assert.equal(h.lifecycle.currentState, "no-project");
});

test("cancelar Save As durante fechamento mantém projeto aberto e dirty", async () => {
  const h = harness();
  await openUnsavedProject(h);
  h.dialogs.unsavedDecision = "save";
  h.dialogs.savePath = undefined;

  const result = await h.controller.closeProject();

  assert.equal(result.outcome, "cancelled");
  assert.equal(h.editor.closeCalls, 0);
  assert.equal(h.lifecycle.currentState, "open-dirty");
  assert.equal(h.lifecycle.project?.name, "Sem caminho");
});

test("falha do diálogo de fechamento restaura a sessão dirty", async () => {
  const h = harness();
  await openUnsavedProject(h);
  h.dialogs.failUnsavedDialog = true;

  await assert.rejects(h.controller.closeProject(), /fault injected at unsaved dialog/);

  assert.equal(h.editor.closeCalls, 0);
  assert.equal(h.lifecycle.currentState, "open-dirty");
  assert.equal(h.lifecycle.project?.name, "Sem caminho");
});

test("falha de escrita cancela fechamento e nunca confirma close", async () => {
  const h = harness();
  await openUnsavedProject(h);
  h.dialogs.unsavedDecision = "save";
  h.dialogs.savePath = "/projects/falha.p7m.json";
  h.fileSystem.failReplaceDestination = "/projects/falha.p7m.json";

  await assert.rejects(h.controller.closeProject(), /fault injected at replace/);

  assert.equal(h.editor.closeCalls, 0);
  assert.equal(h.lifecycle.currentState, "open-dirty");
  assert.ok(h.lifecycle.project);
});

test("Descartar no fechamento remove o autosave somente depois do Close confirmado", async () => {
  const h = harness();
  const filePath = "/projects/discard-close.p7m.json";
  const document = createPlatformer2DDocument({
    projectId: "discard-close",
    name: "Descartar close",
  });
  h.fileSystem.seed(filePath, JSON.stringify(document));
  await h.controller.openRecent(filePath);
  await h.controller.dispatch("camera/configure", { settings: { response: 5 } });
  await h.controller.autosave();
  assert.equal(await h.files.exists(`${filePath}.autosave`), true);
  h.dialogs.unsavedDecision = "discard";

  await h.controller.closeProject();

  assert.equal(await h.files.exists(`${filePath}.autosave`), false);
  assert.equal(h.lifecycle.currentState, "no-project");
});

test("recovery após crash restaura autosave mais recente, marca dirty e remove após Save", async () => {
  const h = harness();
  const original = createPlatformer2DDocument({ projectId: "recover", name: "Recuperar" });
  const recovered = {
    ...original,
    metadata: { ...original.metadata, name: "Recuperado" },
  };
  h.fileSystem.seed("/projects/recover.p7m.json", JSON.stringify(original), 10);
  h.fileSystem.seed("/projects/recover.p7m.json.autosave", JSON.stringify(recovered), 20);
  h.dialogs.recoveryDecision = "restore";

  const opened = await h.controller.openProject({ filePath: "/projects/recover.p7m.json" });

  assert.equal(opened.outcome, "completed");
  assert.equal(h.dialogs.recoveryCandidates[0]?.autosaveModifiedAtMs, 20);
  assert.equal(h.lifecycle.currentState, "open-dirty");
  assert.equal((h.editor.currentDocument as typeof recovered).metadata.name, "Recuperado");
  await h.controller.saveProject();
  assert.equal(await h.files.exists("/projects/recover.p7m.json.autosave"), false);
  assert.equal(h.lifecycle.currentState, "open-clean");
});

test("Recovery permite abrir cópia sem alterar original nem sidecar", async () => {
  const h = harness();
  const original = createPlatformer2DDocument({ projectId: "original", name: "Original" });
  const recovered = createPlatformer2DDocument({ projectId: "autosave", name: "Recuperado" });
  const originalBytes = JSON.stringify(original);
  const autosaveBytes = JSON.stringify(recovered);
  h.fileSystem.seed("/projects/copy.p7m.json", originalBytes, 10);
  h.fileSystem.seed("/projects/copy.p7m.json.autosave", autosaveBytes, 20);
  h.dialogs.recoveryDecision = "copy";

  await h.controller.openRecent("/projects/copy.p7m.json");

  assert.equal(h.lifecycle.currentState, "open-dirty");
  assert.equal(h.lifecycle.project?.filePath, undefined);
  assert.notEqual(h.lifecycle.project?.projectId, "autosave");
  assert.equal(h.fileSystem.content("/projects/copy.p7m.json"), originalBytes);
  assert.equal(h.fileSystem.content("/projects/copy.p7m.json.autosave"), autosaveBytes);
});

test("trocar uma cópia recuperada pelo mesmo recovery preserva o sidecar", async (t) => {
  for (const mode of ["restore", "copy"] as const) {
    await t.test(mode, async () => {
      const h = harness();
      const filePath = `/projects/reopen-${mode}.p7m.json`;
      const original = createPlatformer2DDocument({
        projectId: `original-${mode}`,
        name: "Original",
      });
      const recovered = createPlatformer2DDocument({
        projectId: `autosave-${mode}`,
        name: "Recuperado",
      });
      h.fileSystem.seed(filePath, JSON.stringify(original), 10);
      h.fileSystem.seed(`${filePath}.autosave`, JSON.stringify(recovered), 20);
      h.dialogs.recoveryDecision = "copy";
      await h.controller.openRecent(filePath);

      h.dialogs.unsavedDecision = "discard";
      await h.controller.restoreAutosave({ filePath, mode });

      assert.equal(h.lifecycle.currentState, "open-dirty");
      assert.equal(h.lifecycle.project?.recoverySourceFilePath, filePath);
      assert.equal(
        await h.files.exists(`${filePath}.autosave`),
        true,
        "o recovery da nova sessão não pode ser descartado com a sessão anterior",
      );
    });
  }
});

test("Ignorar Recovery descarta explicitamente o autosave e abre o documento salvo", async () => {
  const h = harness();
  const original = createPlatformer2DDocument({ projectId: "saved", name: "Salvo" });
  const recovered = createPlatformer2DDocument({ projectId: "recovery", name: "Recovery" });
  h.fileSystem.seed("/projects/ignore.p7m.json", JSON.stringify(original), 10);
  h.fileSystem.seed("/projects/ignore.p7m.json.autosave", JSON.stringify(recovered), 20);
  h.dialogs.recoveryDecision = "ignore";

  await h.controller.openRecent("/projects/ignore.p7m.json");

  assert.equal(h.lifecycle.project?.projectId, "saved");
  assert.equal(await h.files.exists("/projects/ignore.p7m.json.autosave"), false);
});

test("falha ao descartar após Ignore preserva autosave sem desfazer Open confirmado", async () => {
  const h = harness();
  await openUnsavedProject(h);
  const original = createPlatformer2DDocument({ projectId: "saved", name: "Salvo" });
  const recovered = createPlatformer2DDocument({ projectId: "recovery", name: "Recovery" });
  h.fileSystem.seed("/projects/fail-ignore.p7m.json", JSON.stringify(original), 10);
  h.fileSystem.seed("/projects/fail-ignore.p7m.json.autosave", JSON.stringify(recovered), 20);
  h.fileSystem.failRemovePath = "/projects/fail-ignore.p7m.json.autosave";
  h.dialogs.recoveryDecision = "ignore";

  await h.controller.openRecent("/projects/fail-ignore.p7m.json");

  assert.equal(h.lifecycle.project?.projectId, "saved");
  assert.equal(h.lifecycle.currentState, "open-clean");
  assert.equal(await h.files.exists("/projects/fail-ignore.p7m.json.autosave"), true);
});

test("Ignore nunca apaga autosave antes de validar e ativar o original", async () => {
  const h = harness();
  const recovered = createPlatformer2DDocument({ projectId: "safe-recovery", name: "Recovery" });
  h.fileSystem.seed("/projects/invalid-original.p7m.json", "{ invalid", 10);
  h.fileSystem.seed(
    "/projects/invalid-original.p7m.json.autosave",
    JSON.stringify(recovered),
    20,
  );
  h.dialogs.recoveryDecision = "ignore";

  await assert.rejects(
    h.controller.openRecent("/projects/invalid-original.p7m.json"),
    /Projeto inválido/,
  );

  assert.equal(await h.files.exists("/projects/invalid-original.p7m.json.autosave"), true);
  assert.equal(h.lifecycle.currentState, "no-project");
});

test("Recentes abre o arquivo correto e remove entrada inexistente", async () => {
  const recent = { filePath: "/projects/B.p7m.json", name: "B", lastOpenedUnixMs: 1 };
  const h = harness([recent]);
  const documentB = createPlatformer2DDocument({ projectId: "project-b", name: "B" });
  h.fileSystem.seed(recent.filePath, JSON.stringify(documentB));

  await h.controller.openRecent(recent.filePath);
  assert.equal(h.lifecycle.project?.projectId, "project-b");
  assert.equal(h.lifecycle.project?.filePath, recent.filePath);

  const missing = "/projects/missing.p7m.json";
  const h2 = harness([{ filePath: missing, name: "Missing", lastOpenedUnixMs: 1 }]);
  await assert.rejects(h2.controller.openRecent(missing), /não existe/);
  assert.equal(h2.lifecycle.recentProjects.length, 0);
});

test("Abrir exemplo usa cópia editável e nunca altera o arquivo distribuído", async () => {
  const h = harness();
  const example = createPlatformer2DDocument({
    projectId: "distributed-example",
    name: "Exemplo Plataforma 2D",
  });
  const originalBytes = `${JSON.stringify(example, null, 2)}\n`;
  h.fileSystem.seed("/app/examples/platformer.p7m.json", originalBytes);

  const result = await h.controller.openProject({ source: "example" });

  assert.equal(result.outcome, "completed");
  assert.equal(h.lifecycle.project?.filePath, undefined);
  assert.notEqual(h.lifecycle.project?.projectId, "distributed-example");
  assert.equal(h.fileSystem.content("/app/examples/platformer.p7m.json"), originalBytes);
});

test("abrir novamente o mesmo caminho não cria edição/sessão concorrente", async () => {
  const h = harness();
  const document = createPlatformer2DDocument({ projectId: "only-one", name: "Único" });
  h.fileSystem.seed("/projects/one.p7m.json", JSON.stringify(document));

  await h.controller.openProject({ filePath: "/projects/one.p7m.json" });
  const second = await h.controller.openProject({ filePath: "/projects/one.p7m.json" });

  assert.equal(second.outcome, "already-open");
  assert.equal(h.editor.openCalls, 1);
});

test("edição canônica: pintar marca dirty e Close alerta antes do evento atrasado do journal", async () => {
  const h = harness();
  const document = createPlatformer2DDocument({ projectId: "dirty-now", name: "Dirty agora" });
  h.fileSystem.seed("/projects/dirty-now.p7m.json", JSON.stringify(document));
  await h.controller.openRecent("/projects/dirty-now.p7m.json");

  const committed = await h.controller.dispatch("level/patch", {
    levelId: "level-1",
    changes: [{ index: 1, before: 0, after: 1 }],
    transactionId: "paint-dirty",
    metadata: { label: "Pintar células" },
  });

  assert.equal(committed.outcome.event.commandSequence, "1");
  assert.equal(h.lifecycle.currentState, "open-dirty");
  h.dialogs.unsavedDecision = "cancel";
  const close = await h.controller.closeProject();
  assert.equal(close.outcome, "cancelled");
  assert.equal(h.editor.closeCalls, 0);
});

test("edição canônica: Save e autosave não capturam no meio do gesto", async () => {
  const h = harness();
  const filePath = "/projects/gesture-save.p7m.json";
  const document = createPlatformer2DDocument({ projectId: "gesture-save", name: "Gesture" });
  h.fileSystem.seed(filePath, JSON.stringify(document));
  await h.controller.openRecent(filePath);

  h.controller.beginEditGesture("paint-gesture");
  assert.equal(await h.controller.autosave(), false);
  let saved = false;
  const pendingSave = h.controller.saveProject().then((result) => {
    saved = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(saved, false);

  await h.controller.dispatch("level/patch", {
    levelId: "level-1",
    changes: [{ index: 1, before: 0, after: 2 }],
    transactionId: "paint-gesture",
    metadata: { label: "Pintar linha" },
  });
  h.controller.endEditGesture("paint-gesture");
  await pendingSave;

  assert.equal(saved, true);
  assert.equal(h.lifecycle.currentState, "open-clean");
  const persisted = JSON.parse(h.fileSystem.content(filePath)!) as {
    levels: Array<{ intGrid: number[] }>;
  };
  assert.equal(persisted.levels[0]?.intGrid[1], 2);
});

test("edição canônica: resync/queda do renderer libera Save aguardando gesture-end", async () => {
  const h = harness();
  const filePath = "/projects/renderer-crash.p7m.json";
  const document = createPlatformer2DDocument({ projectId: "renderer-crash", name: "Crash" });
  h.fileSystem.seed(filePath, JSON.stringify(document));
  await h.controller.openRecent(filePath);

  h.controller.beginEditGesture("orphan-gesture");
  let settled = false;
  const pendingSave = h.controller.saveProject().finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  h.controller.clearEditGestures();
  await pendingSave;
  assert.equal(settled, true);
});

test("edição canônica: Save aguarda confirmação incerta até o evento do journal", async () => {
  const h = harness();
  const filePath = "/projects/uncertain-event.p7m.json";
  const document = createPlatformer2DDocument({ projectId: "uncertain", name: "Incerto" });
  h.fileSystem.seed(filePath, JSON.stringify(document));
  await h.controller.openRecent(filePath);

  const transactionId = "uncertain-paint";
  h.controller.beginEditGesture(transactionId);
  const committed = h.editor.commitExternalCommand("level/patch", {
    levelId: "level-1",
    changes: [{ index: 1, before: 0, after: 3 }],
    transactionId,
    metadata: { label: "Pintar células" },
  });

  let saved = false;
  const pendingSave = h.controller.saveProject().then((result) => {
    saved = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(saved, false, "snapshot não pode ultrapassar confirmação pendente");

  const observation = h.controller.observeCommittedCommand(committed.event);
  h.controller.endEditGesture(committed.event.transactionId!);
  await observation;
  await pendingSave;

  const persisted = JSON.parse(h.fileSystem.content(filePath)!) as {
    levels: Array<{ intGrid: number[] }>;
  };
  assert.equal(persisted.levels[0]?.intGrid[1], 3);
  assert.equal(h.lifecycle.currentState, "open-clean");
});

test("edição canônica: Save revalida gesto iniciado ao encerrar o anterior", async () => {
  const h = harness();
  const filePath = "/projects/consecutive-gestures.p7m.json";
  const document = createPlatformer2DDocument({ projectId: "consecutive", name: "Gestos" });
  h.fileSystem.seed(filePath, JSON.stringify(document));
  await h.controller.openRecent(filePath);

  h.controller.beginEditGesture("gesture-a");
  let saved = false;
  const pendingSave = h.controller.saveProject().finally(() => { saved = true; });
  h.controller.endEditGesture("gesture-a");
  h.controller.beginEditGesture("gesture-b");
  await Promise.resolve();
  assert.equal(saved, false);

  h.controller.endEditGesture("gesture-b");
  await pendingSave;
  assert.equal(saved, true);
});

test("edição canônica: Open aguarda o brush canônico antes de substituir a sessão", async () => {
  const h = harness();
  const documentA = createPlatformer2DDocument({ projectId: "brush-a", name: "A" });
  const documentB = createPlatformer2DDocument({ projectId: "brush-b", name: "B" });
  h.fileSystem.seed("/projects/brush-a.p7m.json", JSON.stringify(documentA));
  h.fileSystem.seed("/projects/brush-b.p7m.json", JSON.stringify(documentB));
  await h.controller.openRecent("/projects/brush-a.p7m.json");

  const transactionId = "brush-before-open";
  h.controller.beginEditGesture(transactionId);
  let opened = false;
  const pendingOpen = h.controller.openRecent("/projects/brush-b.p7m.json").then((result) => {
    opened = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(opened, false);
  assert.equal(h.lifecycle.project?.projectId, "brush-a");

  const committed = h.editor.commitExternalCommand("level/patch", {
    levelId: "level-1",
    changes: [{ index: 1, before: 0, after: 2 }],
    transactionId,
    metadata: { label: "Pintar células" },
  });
  const observation = h.controller.observeCommittedCommand(committed.event);
  h.controller.endEditGesture(transactionId);
  await observation;
  await pendingOpen;

  assert.equal(opened, true);
  assert.equal(h.lifecycle.project?.projectId, "brush-b");
});

test("evento entre snapshot e rename mantém projeto dirty depois do Save", async () => {
  const h = harness();
  const document = createPlatformer2DDocument({ projectId: "save-race", name: "Save race" });
  h.fileSystem.seed("/projects/save-race.p7m.json", JSON.stringify(document));
  await h.controller.openRecent("/projects/save-race.p7m.json");
  await h.controller.dispatch("camera/configure", { settings: { response: 1 } });

  let observation: Promise<boolean> | undefined;
  h.editor.afterNextCapture = () => {
    const later = h.editor.commitExternalCommand("camera/configure", {
      settings: { response: 2 },
    });
    observation = h.controller.observeCommittedCommand(later.event);
  };
  await h.controller.saveProject();
  await observation;

  assert.equal(h.lifecycle.currentState, "open-dirty");
  assert.equal(h.lifecycle.commandSequence, "2");
});

test("comando concorrente entre Save e Close recusa o fechamento por revisão", async () => {
  const h = harness();
  const filePath = "/projects/close-cas.p7m.json";
  const document = createPlatformer2DDocument({ projectId: "close-cas", name: "Close CAS" });
  h.fileSystem.seed(filePath, JSON.stringify(document));
  await h.controller.openRecent(filePath);
  await h.controller.dispatch("camera/configure", { settings: { response: 1 } });
  h.dialogs.unsavedDecision = "save";

  let observation: Promise<boolean> | undefined;
  h.editor.afterNextCapture = () => {
    const later = h.editor.commitExternalCommand("camera/configure", {
      settings: { response: 2 },
    });
    observation = h.controller.observeCommittedCommand(later.event);
  };

  await assert.rejects(h.controller.closeProject(), /command sequence changed/);
  await observation;

  assert.ok(h.editor.activeProjectSessionId, "a sessão remota continua ativa");
  assert.equal(h.lifecycle.currentState, "open-dirty");
  assert.equal(h.lifecycle.commandSequence, "2");
});

test("comando concorrente entre Save e Open preserva A por compare-and-swap", async () => {
  const h = harness();
  const a = createPlatformer2DDocument({ projectId: "project-a", name: "Projeto A" });
  const b = createPlatformer2DDocument({ projectId: "project-b", name: "Projeto B" });
  h.fileSystem.seed("/projects/a.p7m.json", JSON.stringify(a));
  h.fileSystem.seed("/projects/b.p7m.json", JSON.stringify(b));
  await h.controller.openRecent("/projects/a.p7m.json");
  const sessionA = h.editor.activeProjectSessionId;
  await h.controller.dispatch("camera/configure", { settings: { response: 1 } });
  h.dialogs.unsavedDecision = "save";

  let observation: Promise<boolean> | undefined;
  h.editor.afterNextCapture = () => {
    const later = h.editor.commitExternalCommand("camera/configure", {
      settings: { response: 2 },
    });
    observation = h.controller.observeCommittedCommand(later.event);
  };

  await assert.rejects(
    h.controller.openRecent("/projects/b.p7m.json"),
    /command sequence changed/,
  );
  await observation;

  assert.equal(h.editor.activeProjectSessionId, sessionA);
  assert.equal(h.lifecycle.project?.projectId, "project-a");
  assert.equal(h.lifecycle.currentState, "open-dirty");
});

test("resync não religa filePath por projectId quando o documento remoto diverge", async () => {
  const h = harness();
  const filePath = "/projects/same-id.p7m.json";
  const local = createPlatformer2DDocument({ projectId: "same-id", name: "Local" });
  h.fileSystem.seed(filePath, JSON.stringify(local));
  await h.controller.openRecent(filePath);
  await h.controller.dispatch("camera/configure", { settings: { response: 7 } });

  const remote = createPlatformer2DDocument({ projectId: "same-id", name: "Remoto" });
  const outcome = await h.controller.reconcileRemoteSnapshot({
    status: {
      active: true,
      projectSessionId: "remote-session",
      projectId: "same-id",
      commandSequence: "6",
      runtimeState: "synchronized",
    },
    projections: { document: { document: remote } },
  });

  assert.equal(outcome, "preserved");
  assert.notEqual(h.lifecycle.project?.projectSessionId, "remote-session");
  assert.equal(h.lifecycle.project?.filePath, filePath);
  assert.equal(h.lifecycle.currentState, "open-dirty");
});

test("restart do middleware reidrata somente o documento dirty ativo e preserva caminho", async () => {
  const h = harness();
  const filePath = "/projects/restart.p7m.json";
  const document = createPlatformer2DDocument({ projectId: "restart", name: "Restart" });
  h.fileSystem.seed(filePath, JSON.stringify(document));
  await h.controller.openRecent(filePath);
  const oldSessionId = h.lifecycle.project?.projectSessionId;
  await h.controller.dispatch("camera/configure", { settings: { response: 9 } });
  h.editor.restartMiddleware();

  const reconciliation = await h.controller.reconcileRemoteSnapshot({
    status: {
      active: false,
      commandSequence: "0",
      runtimeState: "synchronized",
    },
    projections: {},
  });

  assert.equal(reconciliation, "recovered");
  assert.notEqual(h.lifecycle.project?.projectSessionId, oldSessionId);
  assert.equal(h.lifecycle.project?.filePath, filePath);
  assert.equal(h.lifecycle.currentState, "open-dirty");
  assert.equal(
    (h.editor.currentDocument as { camera: { response?: number } }).camera.response,
    9,
  );
  assert.equal((await h.controller.openRecent(filePath)).outcome, "already-open");
});
