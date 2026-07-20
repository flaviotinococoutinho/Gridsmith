import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AssetApplicationError,
  AssetApplicationService,
  FileAssetCatalogPersistence,
  FileAssetToolSettingsAdapter,
  MemoryAssetCatalogPersistence,
  type AssetCatalogManifest,
  type AssetCatalogPersistence,
  type AssetPathRevealer,
} from "../src/application/AssetApplicationService.js";
import {
  AssetPipelineService,
  type ToolResult,
  type ToolRunOptions,
  type ToolRunner,
} from "../src/assets/AssetPipelineService.js";
import { importAseprite } from "../src/assets/AsepriteImporter.js";
import { ArtifactStore } from "../src/canonical/ArtifactStore.js";
import { EditorSurface } from "../src/canonical/EditorSurface.js";
import type { EditorApplicationEvent } from "../src/canonical/EditorApplicationEvent.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { ASEPRITE_PIPELINE, PipelineRunner } from "../src/canonical/Pipeline.js";
import { ProjectSessionManager } from "../src/canonical/ProjectSessionManager.js";
import type { BlueprintEvent, BlueprintStore } from "../src/domain/BlueprintStore.js";
import type { ExperienceGovernor } from "../src/runtime/ExperienceGovernor.js";
import type {
  ProjectionResult,
  RuntimeAdapter,
  RuntimeIdentity,
  RuntimeSessionResetResult,
} from "../src/runtime/RuntimeAdapter.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class OfflineRuntime implements RuntimeAdapter {
  readonly family = "test";
  readonly isConnected = false;

  identify(): RuntimeIdentity {
    return { family: this.family, version: "1.0.0" };
  }

  async project(event: BlueprintEvent): Promise<ProjectionResult> {
    return { event: event.kind, status: "deferred", reason: "test runtime offline" };
  }

  async resetSession(): Promise<RuntimeSessionResetResult> {
    return { status: "deferred", runtimeSessionEpoch: 1, reason: "test runtime offline" };
  }

  async rehydrateFrom(_store: BlueprintStore): Promise<readonly ProjectionResult[]> {
    return [];
  }
}

class FakeAssetRunner implements ToolRunner {
  failNextMgcb = false;
  failNextAseprite = false;
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];
  private exportGate:
    | { readonly started: () => void; readonly wait: Promise<void> }
    | undefined;

  blockNextExport(): { readonly started: Promise<void>; release(): void } {
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.exportGate = { started, wait };
    return { started: startedPromise, release };
  }

  async run(
    command: string,
    args: readonly string[],
    _options?: ToolRunOptions,
  ): Promise<ToolResult> {
    this.calls.push({ command, args: [...args] });
    if (args.length === 1 && args[0] === "--version") {
      return { code: 0, stdout: `${command} 1.2.3\n`, stderr: "" };
    }
    if (args.includes("-b")) {
      if (this.exportGate) {
        const gate = this.exportGate;
        this.exportGate = undefined;
        gate.started();
        await gate.wait;
      }
      if (this.failNextAseprite) {
        this.failNextAseprite = false;
        return { code: 9, stdout: "", stderr: "invalid sprite source" };
      }
      const sourcePath = args[args.indexOf("-b") + 1]!;
      const marker = Number.parseInt(fs.readFileSync(sourcePath, "utf8"), 10) || 1;
      const dataPath = args[args.indexOf("--data") + 1]!;
      const sheetPath = args[args.indexOf("--sheet") + 1]!;
      fs.writeFileSync(dataPath, JSON.stringify(spriteExport(marker)));
      fs.writeFileSync(sheetPath, Buffer.concat([PNG, Buffer.from(`-${marker}`)]));
      return { code: 0, stdout: "exported", stderr: "" };
    }
    if (args.some((arg) => arg.startsWith("/build:"))) {
      if (this.failNextMgcb) {
        this.failNextMgcb = false;
        return { code: 7, stdout: "", stderr: "MGCB compile failed" };
      }
      const outputDir = args.find((arg) => arg.startsWith("/outputDir:"))!
        .slice("/outputDir:".length);
      const sheetPath = args.find((arg) => arg.startsWith("/build:"))!
        .slice("/build:".length);
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(
        path.join(outputDir, `${path.basename(sheetPath, ".png")}.xnb`),
        Buffer.concat([Buffer.from("XNB"), fs.readFileSync(sheetPath)]),
      );
      return { code: 0, stdout: "compiled", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: `unexpected invocation: ${command}` };
  }
}

class FakeRevealer implements AssetPathRevealer {
  readonly paths: string[] = [];
  async reveal(filePath: string): Promise<void> {
    this.paths.push(filePath);
  }
}

class ControlledCatalogPersistence implements AssetCatalogPersistence {
  private gate:
    | { readonly started: () => void; readonly wait: Promise<void> }
    | undefined;
  private failure: Error | undefined;

  constructor(private readonly delegate: AssetCatalogPersistence) {}

  load(projectId: string): unknown {
    return this.delegate.load(projectId);
  }

  blockNextSave(): { readonly started: Promise<void>; release(): void } {
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.gate = { started, wait };
    return { started: startedPromise, release };
  }

  failNextSave(error = new Error("catalog persistence failed")): void {
    this.failure = error;
  }

  async save(projectId: string, manifest: AssetCatalogManifest): Promise<void> {
    if (this.gate) {
      const gate = this.gate;
      this.gate = undefined;
      gate.started();
      await gate.wait;
    }
    if (this.failure) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
    await this.delegate.save(projectId, manifest);
  }
}

interface Harness {
  readonly root: string;
  readonly assetsRoot: string;
  readonly outputRoot: string;
  readonly artifacts: ArtifactStore;
  readonly runner: FakeAssetRunner;
  readonly runtime: OfflineRuntime;
  readonly sessions: ProjectSessionManager;
  readonly pipeline: AssetPipelineService;
  readonly service: AssetApplicationService;
  readonly revealer: FakeRevealer;
  readonly events: EditorApplicationEvent[];
}

async function makeHarness(
  projectId = "project-a",
  existingRoot?: string,
  options: {
    memoryCatalog?: boolean;
    catalogPersistence?: AssetCatalogPersistence;
  } = {},
): Promise<Harness> {
  const root = existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "p7m-asset-app-"));
  const assetsRoot = path.join(root, "assets");
  const outputRoot = path.join(assetsRoot, ".p7m-build");
  fs.mkdirSync(assetsRoot, { recursive: true });
  const hooks = new HookBus();
  const artifacts = new ArtifactStore(() => 1234);
  const pipelines = new PipelineRunner(hooks, artifacts);
  pipelines.register(ASEPRITE_PIPELINE);
  hooks.addFilter(`pipeline:${ASEPRITE_PIPELINE.pipelineId}:parse`, importAseprite);
  const runner = new FakeAssetRunner();
  const pipeline = new AssetPipelineService({
    assetsRoot,
    outputRoot,
    runner,
    pipelines,
    hooks,
  });
  const runtime = new OfflineRuntime();
  const sessions = new ProjectSessionManager({ hooks, adapter: runtime });
  await sessions.activate(sessions.createEmptySession(projectId));
  const revealer = new FakeRevealer();
  const service = new AssetApplicationService({
    pipeline,
    artifacts,
    sessions,
    revealer,
    settings: new FileAssetToolSettingsAdapter(path.join(root, "settings")),
    ...(options.catalogPersistence !== undefined
      ? { catalogPersistence: options.catalogPersistence }
      : options.memoryCatalog
        ? { catalogPersistence: new MemoryAssetCatalogPersistence() }
        : {}),
  });
  const events: EditorApplicationEvent[] = [];
  service.on("event", (event: EditorApplicationEvent) => events.push(event));
  return {
    root,
    assetsRoot,
    outputRoot,
    artifacts,
    runner,
    runtime,
    sessions,
    pipeline,
    service,
    revealer,
    events,
  };
}

function spriteExport(marker: number): unknown {
  return {
    frames: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
      `player ${index}`,
      { frame: { x: index * 16, y: 0, w: 16, h: 16 }, duration: marker * 10 + index },
    ])),
    meta: {
      image: "player.png",
      frameTags: ["idle", "run", "jump", "fall"].map((name, index) => ({
        name,
        from: index,
        to: index,
        direction: "forward",
      })),
      slices: [{
        name: "origin",
        keys: [{ frame: 0, bounds: { x: 0, y: 0, w: 16, h: 16 }, pivot: { x: 8, y: 16 } }],
      }],
    },
  };
}

function externalSource(h: Harness, name = "player.aseprite", marker = 1): string {
  const directory = path.join(h.root, "external");
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, name);
  fs.writeFileSync(source, String(marker));
  return source;
}

function waitForTerminal(
  service: AssetApplicationService,
  operationId: string,
): Promise<EditorApplicationEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      service.off("event", listener);
      reject(new Error(`operation ${operationId} did not finish`));
    }, 3_000);
    const listener = (event: EditorApplicationEvent): void => {
      if (
        event.operationId === operationId &&
        ["asset/operationCompleted", "asset/operationFailed", "asset/operationCancelled"].includes(event.kind)
      ) {
        clearTimeout(timeout);
        service.off("event", listener);
        resolve(event);
      }
    };
    service.on("event", listener);
  });
}

function cleanup(h: Harness): void {
  h.service.close();
  fs.rmSync(h.root, { recursive: true, force: true });
}

test("asset application: import publica catalogo/detalhes e quatro clips sem sujar Blueprint", async () => {
  const h = await makeHarness();
  try {
    const source = externalSource(h);
    const accepted = h.service.importAsset({
      sourcePath: source,
      targetDirectory: "characters",
      tags: ["playable"],
      operationId: "import-player",
    });
    assert.equal((await waitForTerminal(h.service, accepted.operationId)).kind, "asset/operationCompleted");
    assert.equal(accepted.assetId, "assets/characters/player");

    const catalog = h.service.assetCatalog({ tags: ["characters", "playable"] });
    assert.equal(catalog.assets.length, 1);
    const asset = catalog.assets[0]!;
    assert.equal(asset.kind, "sprite-document");
    assert.notEqual(asset.paths.originSource, asset.paths.managedSource);
    assert.match(asset.thumbnailDataUrl ?? "", /^data:image\/png;base64,/);
    assert.deepEqual(h.service.assetDetails(asset.assetId).clips.map((clip) => clip.name), [
      "idle", "run", "jump", "fall",
    ]);
    assert.equal(h.sessions.current!.history.length, 0);
    assert.ok(h.events.every((event) => event.domain === "asset"));
    const catalogEvent = h.events.find((event) => event.kind === "asset/catalogChanged")!;
    assert.equal(JSON.stringify(catalogEvent.payload).includes("thumbnailDataUrl"), false);
    assert.equal(JSON.stringify(catalogEvent.payload).includes("data:image"), false);
    assert.ok(h.artifacts.list("sprite-document")[0]!.artifactId.startsWith("projects/project-a/"));
  } finally {
    cleanup(h);
  }
});

test("asset application: leitores veem head anterior enquanto manifesto de reimport esta bloqueado", async () => {
  const persistence = new ControlledCatalogPersistence(new MemoryAssetCatalogPersistence());
  const h = await makeHarness("project-a", undefined, { catalogPersistence: persistence });
  try {
    const source = externalSource(h);
    const first = h.service.importAsset({ sourcePath: source, operationId: "visible-v1" });
    await waitForTerminal(h.service, first.operationId);
    const before = h.service.assetCatalog().assets[0]!;
    assert.equal(h.service.assetDetails(before.assetId).frames[0]!.durationMs, 10);

    fs.writeFileSync(source, "2");
    const gate = persistence.blockNextSave();
    const reimport = h.service.reimportAsset(before.assetId, "blocked-v2");
    const terminal = waitForTerminal(h.service, reimport.operationId);
    await gate.started;

    const during = h.service.assetCatalog().assets[0]!;
    assert.equal(during.revision, before.revision);
    assert.equal(h.service.assetDetails(during.assetId).frames[0]!.durationMs, 10);

    gate.release();
    assert.equal((await terminal).kind, "asset/operationCompleted");
    const after = h.service.assetCatalog().assets[0]!;
    assert.equal(after.revision, before.revision + 1);
    assert.equal(h.service.assetDetails(after.assetId).frames[0]!.durationMs, 20);
  } finally {
    cleanup(h);
  }
});

test("asset application: remove so troca catalogo ativo depois do manifesto duravel", async () => {
  const persistence = new ControlledCatalogPersistence(new MemoryAssetCatalogPersistence());
  const h = await makeHarness("project-a", undefined, { catalogPersistence: persistence });
  try {
    const source = externalSource(h);
    const imported = h.service.importAsset({ sourcePath: source, operationId: "remove-visible-import" });
    await waitForTerminal(h.service, imported.operationId);
    const asset = h.service.assetCatalog().assets[0]!;
    const artifactId = `projects/project-a/${asset.assetId}`;

    const gate = persistence.blockNextSave();
    const removing = h.service.removeAsset(asset.assetId);
    await gate.started;
    assert.equal(h.service.assetCatalog().assets[0]!.assetId, asset.assetId);
    assert.equal(h.artifacts.get(artifactId)?.revision, asset.revision);

    gate.release();
    assert.equal((await removing).removed, true);
    assert.equal(h.service.assetCatalog().assets.length, 0);
    assert.equal(h.artifacts.get(artifactId), undefined);
  } finally {
    cleanup(h);
  }
});

test("asset application: falha de manifesto nao consome revisao nem emite catalogChanged/completed", async () => {
  const persistence = new ControlledCatalogPersistence(new MemoryAssetCatalogPersistence());
  const h = await makeHarness("project-a", undefined, { catalogPersistence: persistence });
  try {
    const source = externalSource(h);
    persistence.failNextSave();
    const failed = h.service.importAsset({ sourcePath: source, operationId: "manifest-failure" });
    assert.equal((await waitForTerminal(h.service, failed.operationId)).kind, "asset/operationFailed");
    const artifactId = "projects/project-a/assets/player";
    assert.equal(h.artifacts.history(artifactId).length, 0);
    assert.equal(h.artifacts.list("sprite-document").length, 0);
    assert.equal(h.service.assetCatalog().assets.length, 0);
    assert.equal(h.events.some((event) =>
      event.operationId === failed.operationId &&
      ["asset/catalogChanged", "asset/operationCompleted"].includes(event.kind)), false);

    const retried = h.service.importAsset({ sourcePath: source, operationId: "manifest-retry" });
    assert.equal((await waitForTerminal(h.service, retried.operationId)).kind, "asset/operationCompleted");
    assert.equal(h.service.assetCatalog().assets[0]!.revision, 1);
    assert.equal(h.artifacts.history(artifactId).length, 1);
  } finally {
    cleanup(h);
  }
});

test("asset application: imports cross-asset concorrentes serializam manifesto e sobrevivem restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p7m-asset-concurrent-"));
  const persistence = new ControlledCatalogPersistence(new FileAssetCatalogPersistence(
    path.join(root, "assets", ".p7m-build", ".p7m-state", "catalogs"),
  ));
  const h = await makeHarness("project-a", root, { catalogPersistence: persistence });
  try {
    const firstSource = externalSource(h, "hero.aseprite", 1);
    const secondSource = externalSource(h, "enemy.aseprite", 2);
    const gate = persistence.blockNextSave();
    const first = h.service.importAsset({
      sourcePath: firstSource,
      targetDirectory: "characters",
      operationId: "parallel-hero",
    });
    const second = h.service.importAsset({
      sourcePath: secondSource,
      targetDirectory: "enemies",
      operationId: "parallel-enemy",
    });
    const terminals = [
      waitForTerminal(h.service, first.operationId),
      waitForTerminal(h.service, second.operationId),
    ];
    await gate.started;
    assert.equal(h.service.assetCatalog().assets.length, 0);
    gate.release();
    assert.deepEqual((await Promise.all(terminals)).map((event) => event.kind), [
      "asset/operationCompleted",
      "asset/operationCompleted",
    ]);
    assert.deepEqual(h.service.assetCatalog().assets.map((asset) => asset.assetId), [
      "assets/characters/hero",
      "assets/enemies/enemy",
    ]);

    h.service.close();
    const restarted = await makeHarness("project-a", root);
    try {
      assert.deepEqual(restarted.service.assetCatalog().assets.map((asset) => asset.assetId), [
        "assets/characters/hero",
        "assets/enemies/enemy",
      ]);
      assert.equal(restarted.artifacts.list("sprite-document").length, 2);
    } finally {
      restarted.service.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("asset application: reimport recopia origem, rollback MGCB preserva head e bytes anteriores", async () => {
  const h = await makeHarness();
  try {
    const source = externalSource(h);
    const first = h.service.importAsset({ sourcePath: source, operationId: "first" });
    await waitForTerminal(h.service, first.operationId);
    const before = h.service.assetCatalog().assets[0]!;
    const beforeManaged = fs.readFileSync(before.paths.managedSource);
    const beforePng = fs.readFileSync(before.paths.spritesheet);
    const beforeXnb = fs.readFileSync(before.paths.compiled);
    const artifactId = `projects/project-a/${before.assetId}`;

    fs.writeFileSync(source, "2");
    h.runner.failNextMgcb = true;
    const failed = h.service.reimportAsset(before.assetId, "failed-reimport");
    const failure = await waitForTerminal(h.service, failed.operationId);
    assert.equal(failure.kind, "asset/operationFailed");
    const error = failure.payload["error"] as Record<string, unknown>;
    assert.equal(error["code"], "ASSET_TOOL_FAILED");
    assert.equal(error["stage"], "compiling");
    assert.match(String(error["stderr"]), /MGCB compile failed/);
    assert.ok(Array.isArray(error["suggestedActions"]));
    const afterFailure = h.service.assetCatalog().assets[0]!;
    assert.equal(afterFailure.revision, before.revision);
    assert.deepEqual(fs.readFileSync(before.paths.managedSource), beforeManaged);
    assert.deepEqual(fs.readFileSync(before.paths.spritesheet), beforePng);
    assert.deepEqual(fs.readFileSync(before.paths.compiled), beforeXnb);
    assert.equal(h.artifacts.get(artifactId)?.revision, before.revision);

    fs.writeFileSync(source, "3");
    const success = h.service.reimportAsset(before.assetId, "successful-reimport");
    assert.equal((await waitForTerminal(h.service, success.operationId)).kind, "asset/operationCompleted");
    const after = h.service.assetCatalog().assets[0]!;
    assert.equal(after.revision, before.revision + 1);
    assert.notEqual(after.paths.managedSource, before.paths.managedSource);
    assert.equal(h.service.assetDetails(after.assetId).frames[0]!.durationMs, 30);
  } finally {
    cleanup(h);
  }
});

test("asset application: cancelamento e troca de sessao impedem commit tardio", async () => {
  const h = await makeHarness();
  try {
    const source = externalSource(h);
    const gate = h.runner.blockNextExport();
    const accepted = h.service.importAsset({ sourcePath: source, operationId: "slow-a" });
    const terminal = waitForTerminal(h.service, accepted.operationId);
    await gate.started;
    await h.sessions.activate(h.sessions.createEmptySession("project-b"));
    gate.release();
    assert.equal((await terminal).kind, "asset/operationCancelled");
    assert.equal(h.service.assetCatalog().assets.length, 0);
    assert.equal(h.events.some((event) =>
      event.operationId === accepted.operationId && event.kind === "asset/catalogChanged"), false);

    const gate2 = h.runner.blockNextExport();
    const second = h.service.importAsset({ sourcePath: source, operationId: "slow-b" });
    const terminal2 = waitForTerminal(h.service, second.operationId);
    await gate2.started;
    assert.deepEqual(h.service.cancelAssetOperation(second.operationId), {
      operationId: second.operationId,
      status: "cancellation-requested",
      cancelled: true,
    });
    gate2.release();
    assert.equal((await terminal2).kind, "asset/operationCancelled");
  } finally {
    cleanup(h);
  }
});

test("asset application: falha de primeira importacao preserva referencia validada para reveal", async () => {
  const h = await makeHarness();
  try {
    const source = externalSource(h);
    h.runner.failNextAseprite = true;
    const accepted = h.service.importAsset({ sourcePath: source, operationId: "problem-source" });
    assert.equal((await waitForTerminal(h.service, accepted.operationId)).kind, "asset/operationFailed");
    const revealed = await h.service.revealSource({ operationId: accepted.operationId });
    assert.equal(revealed.sourceOperationId, accepted.operationId);
    assert.equal(revealed.path, fs.realpathSync(source));
    assert.deepEqual(h.revealer.paths, [fs.realpathSync(source)]);
    assert.throws(
      () => h.service.revealSource({ assetId: "assets/player", operationId: accepted.operationId } as never),
      /exactly one/,
    );
  } finally {
    cleanup(h);
  }
});

test("asset application: traversal, symlink escape e imports concorrentes sao recusados", async (t) => {
  const h = await makeHarness();
  try {
    const source = externalSource(h);
    assert.throws(
      () => h.service.importAsset({ sourcePath: source, targetDirectory: "../escape" }),
      (error: unknown) => error instanceof AssetApplicationError && error.code === "ASSET_PATH_OUTSIDE_ROOT",
    );

    if (process.platform !== "win32") {
      const symlink = path.join(h.assetsRoot, "escaped.aseprite");
      fs.symlinkSync(source, symlink);
      assert.throws(
        () => h.service.importAsset({ sourcePath: symlink }),
        (error: unknown) => error instanceof AssetApplicationError && error.code === "ASSET_PATH_OUTSIDE_ROOT",
      );
    } else {
      t.diagnostic("symlink assertion skipped on Windows without developer mode");
    }

    const gate = h.runner.blockNextExport();
    const first = h.service.importAsset({ sourcePath: source, operationId: "concurrent-a" });
    await gate.started;
    assert.throws(
      () => h.service.importAsset({ sourcePath: source, operationId: "concurrent-b" }),
      (error: unknown) => error instanceof AssetApplicationError && error.code === "ASSET_OPERATION_CONFLICT",
    );
    const terminal = waitForTerminal(h.service, first.operationId);
    gate.release();
    await terminal;
  } finally {
    cleanup(h);
  }
});

test("asset application: tool settings sao testados, atomicos, privados e detectaveis sem paths", async () => {
  const h = await makeHarness();
  try {
    const configured = await h.service.configureAssetTools({
      scope: "project",
      asepritePath: "custom-aseprite",
      mgcbPath: "custom-mgcb",
    });
    assert.equal(configured.aseprite.available, true);
    assert.equal(configured.aseprite.source, "project");
    assert.match(configured.aseprite.version ?? "", /1\.2\.3/);
    const detected = await h.service.configureAssetTools({ scope: "project" });
    assert.equal(detected.asepritePath, "custom-aseprite");
    assert.equal(detected.mgcbPath, "custom-mgcb");

    const settingsRoot = path.join(h.root, "settings");
    const files = fs.readdirSync(settingsRoot);
    assert.equal(files.length, 1);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(settingsRoot).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(settingsRoot, files[0]!)).mode & 0o777, 0o600);
    }
  } finally {
    cleanup(h);
  }
});

test("asset application: projetos isolam mesmo basename e manifesto reidrata apos restart", async () => {
  const h = await makeHarness("project-a");
  const root = h.root;
  try {
    const source = externalSource(h);
    const first = h.service.importAsset({ sourcePath: source, operationId: "project-a-import" });
    await waitForTerminal(h.service, first.operationId);
    const projectA = h.service.assetCatalog().assets[0]!;

    await h.sessions.activate(h.sessions.createEmptySession("project-b"));
    const second = h.service.importAsset({ sourcePath: source, operationId: "project-b-import" });
    await waitForTerminal(h.service, second.operationId);
    const projectB = h.service.assetCatalog().assets[0]!;
    assert.equal(projectA.assetId, projectB.assetId);
    assert.notEqual(projectA.paths.managedSource, projectB.paths.managedSource);
    assert.notEqual(projectA.paths.compiled, projectB.paths.compiled);

    h.service.close();
    const restarted = await makeHarness("project-a", root);
    try {
      const restored = restarted.service.assetCatalog().assets[0]!;
      assert.equal(restored.assetId, projectA.assetId);
      assert.equal(restored.revision, projectA.revision);
      assert.deepEqual(restarted.service.assetDetails(restored.assetId).clips.map((clip) => clip.name), [
        "idle", "run", "jump", "fall",
      ]);
      assert.equal(restarted.artifacts.get(`projects/project-a/${restored.assetId}`)?.revision, 1);
    } finally {
      restarted.service.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("asset application: mesmo basename em diretorios distintos nao colide no XNB", async () => {
  const h = await makeHarness();
  try {
    const firstDirectory = path.join(h.root, "source-a");
    const secondDirectory = path.join(h.root, "source-b");
    fs.mkdirSync(firstDirectory);
    fs.mkdirSync(secondDirectory);
    const firstSource = path.join(firstDirectory, "hero.aseprite");
    const secondSource = path.join(secondDirectory, "hero.aseprite");
    fs.writeFileSync(firstSource, "1");
    fs.writeFileSync(secondSource, "2");
    const first = h.service.importAsset({
      sourcePath: firstSource,
      targetDirectory: "characters",
      operationId: "characters-hero",
    });
    await waitForTerminal(h.service, first.operationId);
    const second = h.service.importAsset({
      sourcePath: secondSource,
      targetDirectory: "enemies",
      operationId: "enemies-hero",
    });
    await waitForTerminal(h.service, second.operationId);
    const assets = h.service.assetCatalog().assets;
    assert.deepEqual(assets.map((asset) => asset.assetId), [
      "assets/characters/hero",
      "assets/enemies/hero",
    ]);
    assert.notEqual(assets[0]!.paths.compiled, assets[1]!.paths.compiled);
    assert.equal(fs.existsSync(assets[0]!.paths.compiled), true);
    assert.equal(fs.existsSync(assets[1]!.paths.compiled), true);
  } finally {
    cleanup(h);
  }
});

test("asset application: EditorSurface delega operacoes frias, eventos e erro sem pipeline", async () => {
  const h = await makeHarness();
  try {
    const governor = { resolve: () => ({}) } as unknown as ExperienceGovernor;
    const surface = new EditorSurface({
      sessions: h.sessions,
      governor,
      adapter: h.runtime,
      assets: h.service,
    });
    const observed: EditorApplicationEvent[] = [];
    const unsubscribe = surface.onApplicationEvent((event) => observed.push(event));
    const source = externalSource(h);
    const accepted = surface.importAsset({ sourcePath: source, operationId: "surface-import" });
    await waitForTerminal(h.service, accepted.operationId);
    const asset = surface.assetCatalog().assets[0]!;
    assert.equal(surface.assetDetails(asset.assetId).assetId, asset.assetId);
    await surface.configureAssetTools({ scope: "project" });
    assert.equal((await surface.revealSource({ assetId: asset.assetId })).revealed, true);
    assert.equal((await surface.revealSource({ operationId: accepted.operationId })).sourceOperationId, accepted.operationId);
    assert.equal((await surface.revealOutput(asset.assetId)).revealed, true);
    const reimport = surface.reimportAsset(asset.assetId, "surface-reimport");
    assert.equal(surface.cancelAssetOperation(reimport.operationId).cancelled, true);
    await waitForTerminal(h.service, reimport.operationId);
    assert.equal((await surface.removeAsset(asset.assetId)).filesPreserved, true);
    assert.ok(observed.some((event) => event.kind === "asset/catalogChanged"));
    unsubscribe();

    const unavailable = new EditorSurface({ sessions: h.sessions, governor, adapter: h.runtime });
    assert.throws(() => unavailable.assetCatalog(), /Asset pipeline is not configured/);
    assert.throws(() => unavailable.assetDetails("assets/player"), /Asset pipeline is not configured/);
    assert.throws(
      () => unavailable.importAsset({ sourcePath: source }),
      /Asset pipeline is not configured/,
    );
    assert.throws(() => unavailable.reimportAsset("assets/player"), /Asset pipeline is not configured/);
    assert.throws(() => unavailable.cancelAssetOperation("op"), /Asset pipeline is not configured/);
    assert.throws(() => unavailable.onApplicationEvent(() => undefined), /Asset pipeline is not configured/);
    await assert.rejects(unavailable.removeAsset("assets/player"), /Asset pipeline is not configured/);
    await assert.rejects(unavailable.configureAssetTools({ scope: "project" }), /Asset pipeline is not configured/);
    await assert.rejects(unavailable.revealSource({ assetId: "assets/player" }), /Asset pipeline is not configured/);
    await assert.rejects(unavailable.revealOutput("assets/player"), /Asset pipeline is not configured/);
  } finally {
    cleanup(h);
  }
});

test("asset application: remove preserva arquivos e permite novo import do mesmo logical id", async () => {
  const h = await makeHarness();
  try {
    const source = externalSource(h);
    const first = h.service.importAsset({ sourcePath: source, operationId: "remove-first" });
    await waitForTerminal(h.service, first.operationId);
    const previous = h.service.assetCatalog().assets[0]!;
    const removed = await h.service.removeAsset(previous.assetId);
    assert.equal(removed.filesPreserved, true);
    assert.equal(fs.existsSync(previous.paths.managedSource), true);
    assert.equal(h.artifacts.get(`projects/project-a/${previous.assetId}`), undefined);

    const again = h.service.importAsset({ sourcePath: source, operationId: "remove-second" });
    await waitForTerminal(h.service, again.operationId);
    const current = h.service.assetCatalog().assets[0]!;
    assert.equal(current.assetId, previous.assetId);
    assert.notEqual(current.paths.managedSource, previous.paths.managedSource);
  } finally {
    cleanup(h);
  }
});

test("asset application: staging de projeto usa hash estavel e nao vaza projectId no path", async () => {
  const projectId = "../../private project";
  const h = await makeHarness(projectId);
  try {
    const source = externalSource(h);
    const accepted = h.service.importAsset({ sourcePath: source, operationId: "hashed-project" });
    await waitForTerminal(h.service, accepted.operationId);
    const managed = h.service.assetCatalog().assets[0]!.paths.managedSource;
    const expected = createHash("sha256").update(projectId).digest("hex").slice(0, 24);
    assert.ok(managed.includes(expected));
    assert.equal(managed.includes("private project"), false);
  } finally {
    cleanup(h);
  }
});

test("asset application: settings/catalog recusam state root symlink sem tocar no destino", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink assertion requires Windows developer mode");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p7m-asset-state-symlink-"));
  try {
    const externalSettings = path.join(root, "external-settings");
    const externalCatalog = path.join(root, "external-catalog");
    fs.mkdirSync(externalSettings, { mode: 0o755 });
    fs.mkdirSync(externalCatalog, { mode: 0o755 });
    fs.writeFileSync(path.join(externalSettings, "user.json"), "{}\n");
    const projectId = "project-a";
    const catalogName = `project-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}.json`;
    fs.writeFileSync(path.join(externalCatalog, catalogName), JSON.stringify({
      version: 1,
      projectId,
      assets: [],
    }));
    const settingsMode = fs.statSync(externalSettings).mode & 0o777;
    const catalogMode = fs.statSync(externalCatalog).mode & 0o777;
    const settingsRoot = path.join(root, "settings-link");
    const catalogRoot = path.join(root, "catalog-link");
    fs.symlinkSync(externalSettings, settingsRoot, "dir");
    fs.symlinkSync(externalCatalog, catalogRoot, "dir");

    const settings = new FileAssetToolSettingsAdapter(settingsRoot);
    await assert.rejects(settings.read("user", projectId), /symlink/iu);
    await assert.rejects(settings.write("user", projectId, { asepritePath: "never-written" }), /symlink/iu);
    const catalog = new FileAssetCatalogPersistence(catalogRoot);
    assert.throws(() => catalog.load(projectId), /symlink/iu);
    await assert.rejects(catalog.save(projectId, { version: 1, projectId, assets: [] }), /symlink/iu);

    assert.deepEqual(fs.readdirSync(externalSettings), ["user.json"]);
    assert.equal(fs.readFileSync(path.join(externalSettings, "user.json"), "utf8"), "{}\n");
    assert.deepEqual(fs.readdirSync(externalCatalog), [catalogName]);
    assert.equal(fs.statSync(externalSettings).mode & 0o777, settingsMode);
    assert.equal(fs.statSync(externalCatalog).mode & 0o777, catalogMode);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("asset application: manifesto aplica limite de 16 MiB em save e load", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p7m-asset-manifest-limit-"));
  try {
    const projectId = "project-large";
    const saveRoot = path.join(root, "save");
    const savePersistence = new FileAssetCatalogPersistence(saveRoot);
    const oversized = {
      version: 1,
      projectId,
      assets: [],
      padding: "x".repeat(16 * 1024 * 1024),
    } as unknown as AssetCatalogManifest;
    await assert.rejects(savePersistence.save(projectId, oversized), /16 MiB/iu);
    assert.equal(fs.existsSync(saveRoot), false);

    const loadRoot = path.join(root, "load");
    fs.mkdirSync(loadRoot);
    const catalogName = `project-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}.json`;
    const oversizedPath = path.join(loadRoot, catalogName);
    fs.writeFileSync(oversizedPath, "");
    fs.truncateSync(oversizedPath, 16 * 1024 * 1024 + 1);
    const loadPersistence = new FileAssetCatalogPersistence(loadRoot);
    assert.throws(() => loadPersistence.load(projectId), /too large/iu);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
