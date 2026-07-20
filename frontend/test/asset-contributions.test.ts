import assert from "node:assert/strict";
import test from "node:test";
import { ALL_CAPABILITIES } from "../src/core/capabilityRegistry.js";
import { CommandRegistry } from "../src/core/commandRegistry.js";
import { LevelEditorStore } from "../src/core/levelEditorStore.js";
import { PanelRegistry } from "../src/core/panelRegistry.js";
import { SelectionService } from "../src/core/selectionService.js";
import { registerAssetContributions } from "../src/renderer/assetContributions.js";
import type { EditorWorkbenchApplication } from "../src/renderer/workbenchApplication.js";

test("asset contributions: falha oferece retry, configurar e abrir fonte por registries", async () => {
  const commands = new CommandRegistry();
  const selection = new SelectionService("session");
  selection.select({
    kind: "problem",
    projectSessionId: "session",
    projectId: "project",
    problemId: "failure",
    severity: "error",
    subjectId: "hero",
  }, "test");
  const calls = { import: 0, reimport: 0, reveal: 0, configure: 0, remove: 0 };
  const revealed: Array<{ assetId: string } | { operationId: string }> = [];
  const api = {
    assetCatalog: async () => ({
      projectSessionId: "session",
      projectId: "project",
      assets: [asset()],
      tags: ["player"],
      directories: ["sprites"],
    }),
    assetDetails: async () => ({ asset: asset(), payload: {}, frames: [], clips: [], frameTags: [], slices: [] }),
    importAsset: async (input: { operationId?: string }) => {
      calls.import++;
      return operation(input.operationId ?? "import", "import");
    },
    reimportAsset: async (_assetId: string, operationId?: string) => {
      calls.reimport++;
      return { ...operation(operationId ?? "reimport", "reimport"), assetId: "hero" };
    },
    removeAsset: async (assetId: string) => { calls.remove++; return { assetId, removed: true }; },
    revealSource: async (reference: { assetId: string } | { operationId: string }) => {
      calls.reveal++;
      revealed.push(reference);
      return {
        operationId: "reveal-source",
        ...( "assetId" in reference ? { assetId: reference.assetId } : { sourceOperationId: reference.operationId }),
        target: "source" as const,
        path: "/player.aseprite",
        revealed: true,
      };
    },
    revealOutput: async (assetId: string) => ({
      operationId: "reveal-output",
      assetId,
      target: "output" as const,
      path: "/player.png",
      revealed: true,
    }),
    cancelAssetOperation: async (operationId: string) => ({
      operationId,
      status: "cancellation-requested" as const,
      cancelled: true,
    }),
    configureAssetTools: async (input: unknown) => { calls.configure++; return input; },
    selectAssetSources: async () => ["/player.aseprite"],
    selectAssetToolExecutable: async () => "/tools/aseprite",
    pathForDroppedAsset: () => "",
    onApplicationEvent: () => undefined,
    beginEditGesture: () => undefined,
    endEditGesture: () => undefined,
    dispatch: async () => { throw new Error("not used"); },
  };
  const application = {
    api,
    commands,
    panels: new PanelRegistry<HTMLElement>(),
    selection,
    levelStore: new LevelEditorStore(),
    activeProject: { projectSessionId: "session", projectId: "project", name: "Project" },
    environment: { hostWindow: { confirm: () => true } },
    showError: () => undefined,
    activatePanel: () => true,
    recordApplicationEvent: () => undefined,
    recordDispatchOutcome: () => undefined,
    assertProjectEditable: () => undefined,
  } as unknown as EditorWorkbenchApplication;
  registerAssetContributions(application);

  const context = { selection, capabilities: ALL_CAPABILITIES, mode: "edit" };
  const actions = commands.list("corrective-action", context, { includeDisabled: true })
    .filter(({ placement }) => placement.surface === "corrective-action" &&
      placement.problemKind === "asset-pipeline-failed")
    .map(({ contribution }) => contribution.id);
  assert.ok(actions.includes("assets.retryFailedOperation"));
  assert.ok(actions.includes("assets.configureTools"));
  assert.ok(actions.includes("assets.openFailedSource"));

  const entry = { subject: "hero", applicationPayload: { assetId: "hero", stage: "mgcb", stderr: "failed" } };
  await commands.execute("assets.retryFailedOperation", context, { entry });
  await settle();
  await commands.execute("assets.openFailedSource", context, { entry });
  await commands.execute("assets.openFailedSource", context, {
    entry: {
      operationId: "first-import-operation",
      applicationPayload: { error: { filePath: "/broken/player.aseprite" } },
    },
  });
  await commands.execute("assets.configureTools", context);
  await commands.execute("assets.retryFailedOperation", context, {
    entry: { applicationPayload: { error: { filePath: "/broken/player.aseprite" } } },
  });
  await settle();
  await commands.execute("assets.configure.aseprite", context);
  assert.deepEqual(calls, { import: 1, reimport: 1, reveal: 2, configure: 2, remove: 0 });
  assert.deepEqual(revealed, [{ assetId: "hero" }, { operationId: "first-import-operation" }]);

  assert.ok(commands.get("assets.remove"), "remoção é alcançável por comando além do botão do catálogo");
  assert.ok(commands.get("assets.configure.aseprite"));
  assert.ok(commands.get("assets.configure.mgcb"));

  selection.select({
    kind: "asset",
    projectSessionId: "session",
    projectId: "project",
    assetId: "hero",
    assetType: "aseprite",
  }, "test");
  await commands.execute("assets.remove", context);
  assert.equal(calls.remove, 1);
});

function asset() {
  return {
    assetId: "hero",
    kind: "aseprite",
    name: "player.aseprite",
    revision: 1,
    sourcePath: "/player.aseprite",
    directory: "sprites",
    tags: ["player"],
    clipCount: 4,
    updatedAt: "0",
  };
}

function operation(operationId: string, kind: "import" | "reimport") {
  return {
    operationId,
    operation: kind,
    status: "accepted" as const,
    projectSessionId: "session",
    projectId: "project",
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
