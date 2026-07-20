import assert from "node:assert/strict";
import test from "node:test";
import {
  AssetBrowserController,
  P7M_ASSET_DRAG_TYPE,
  buildAssetDirectoryTree,
  decodeAssetDrag,
  encodeAssetDrag,
  filterAssetSummaries,
  safeAssetPreviewUrl,
  type AssetCatalogPort,
} from "../src/core/assetBrowserModel.js";
import type {
  AssetCatalogResult,
  AssetDetails,
  AssetImportInput,
  AssetSummary,
  EditorApplicationEvent,
} from "../src/core/assetApi.js";
import { EventLog } from "../src/core/eventLog.js";
import { withSpriteRenderer } from "../src/renderer/assetContributions.js";
import { assetInspectorCatalogKey } from "../src/renderer/asepriteInspectorPanel.js";
import { assetToolConfigurationSummary } from "../src/renderer/assetBrowserPanel.js";

test("asset browser: filtra por árvore, busca normalizada e interseção de tags", () => {
  const assets = [
    asset("hero", "Personagem", "sprites/players", ["Jogável", "pixel"]),
    asset("enemy", "Inimigo", "sprites/enemies", ["pixel"]),
    asset("ui", "Painel", "ui", ["interface"]),
  ];
  assert.deepEqual(
    filterAssetSummaries(assets, { search: "personagem", tags: ["jogavel"], directory: "sprites" })
      .map(({ assetId }) => assetId),
    ["hero"],
  );
  const tree = buildAssetDirectoryTree(assets);
  assert.deepEqual(tree.map(({ path, assetCount }) => [path, assetCount]), [["sprites", 2], ["ui", 1]]);
  assert.deepEqual(tree[0]?.children.map(({ path }) => path), ["sprites/enemies", "sprites/players"]);
});

test("asset browser: importação usa ACK assíncrono e progresso/conclusão vêm do stream", async () => {
  const port = new FakeAssetPort();
  const controller = new AssetBrowserController(port, {
    createOperationId: () => "op-1",
    now: () => 10,
  });
  assert.deepEqual(controller.importSources(["/tmp/hero.aseprite", "/tmp/hero.aseprite"]), ["op-1"]);
  await settle();
  assert.deepEqual(port.imports, [{ sourcePath: "/tmp/hero.aseprite", operationId: "op-1" }]);
  assert.equal(controller.snapshot.operations[0]?.status, "running");

  controller.handleApplicationEvent(applicationEvent("asset/operationProgress", "op-1", {
    progress: { phase: "spritesheet", current: 2, total: 5, percent: 40, message: "Gerando spritesheet" },
  }));
  assert.equal(controller.snapshot.operations[0]?.progress, 40);
  assert.equal(controller.snapshot.operations[0]?.phase, "spritesheet");

  controller.handleApplicationEvent(applicationEvent("asset/operationCompleted", "op-1", {
    severity: "info",
    payload: { assetId: "hero" },
  }));
  await settle();
  assert.equal(controller.snapshot.operations[0]?.status, "completed");
  assert.ok(port.catalogReads >= 1);
});

test("asset browser: catalogChanged externo invalida detalhes e atualiza sem operationId conhecido", async () => {
  const port = new FakeAssetPort();
  const controller = new AssetBrowserController(port);
  await controller.refresh();
  await controller.details("hero");
  assert.equal(port.detailReads, 1);
  controller.handleApplicationEvent(applicationEvent("asset/catalogChanged", undefined, {
    payload: { assetId: "hero" },
  }));
  await settle();
  await controller.details("hero");
  assert.equal(port.detailReads, 2);
  assert.equal(port.catalogReads, 2);
});

test("asset browser: cancelamento e reimportação não duplicam trabalho ativo", async () => {
  const port = new FakeAssetPort();
  let next = 0;
  const controller = new AssetBrowserController(port, { createOperationId: () => `op-${++next}` });
  await controller.refresh();
  const first = controller.reimport("hero");
  const duplicate = controller.reimport("hero");
  assert.equal(duplicate, first);
  await settle();
  assert.equal(port.reimports.length, 1);
  assert.equal(await controller.cancel(first), true);
  assert.equal(controller.snapshot.operations[0]?.status, "cancelled");
});

test("asset browser: preview e payload de DnD não expõem caminho local", () => {
  assert.equal(safeAssetPreviewUrl("file:///tmp/hero.png"), undefined);
  assert.equal(safeAssetPreviewUrl("C:\\sprites\\hero.png"), undefined);
  assert.equal(safeAssetPreviewUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  const encoded = encodeAssetDrag({ assetId: "hero", kind: "aseprite", name: "Hero" });
  assert.equal(P7M_ASSET_DRAG_TYPE, "application/x-p7m-asset");
  assert.deepEqual(decodeAssetDrag(encoded), { assetId: "hero", kind: "aseprite", name: "Hero" });
  assert.equal(decodeAssetDrag('{"version":2}'), undefined);
});

test("asset browser: associação SpriteRenderer preserva a definição e usa IDs canônicos", () => {
  const definition = {
    entityDefId: "player-def",
    archetypeId: "player",
    tags: ["player"],
    fields: [{ name: "speed", type: "float" as const, default: 10 }],
    editor: { color: "#fff", icon: "player" },
  };
  const updated = withSpriteRenderer(definition, "hero", "run");
  assert.deepEqual(updated, {
    ...definition,
    tags: ["player"],
    fields: [{ name: "speed", type: "float", default: 10 }],
    editor: { color: "#fff", icon: "player" },
    spriteRenderer: { assetId: "hero", defaultClip: "run" },
  });
  assert.notEqual(updated.fields, definition.fields);
});

test("asset browser: problemas operacionais mantêm domínio/severidade sem fingir projeção", () => {
  const log = new EventLog(10, () => 100);
  const entry = log.recordApplication({
    seq: "1",
    domain: "asset",
    kind: "asset-pipeline-failed",
    severity: "error",
    projectSessionId: "session",
    projectId: "project",
    operationId: "op",
    payload: {
      assetId: "hero",
      error: {
        stage: "mgcb",
        filePath: "/project/player.aseprite",
        stderr: "compiler failed",
        suggestedActions: ["configure"],
      },
    },
  });
  assert.equal(entry.domain, "application");
  assert.equal(entry.severity, "error");
  assert.equal(entry.projectionStatus, undefined);
  assert.equal(entry.subject, "hero");
  assert.deepEqual(entry.applicationPayload?.["error"], {
    stage: "mgcb",
    filePath: "/project/player.aseprite",
    stderr: "compiler failed",
    suggestedActions: ["configure"],
  });
  assert.equal(log.problemCount, 1);
  assert.equal(log.resolveApplication({
    kind: "asset-pipeline-failed",
    projectSessionId: "session",
    operationId: "op",
  }), 1);
  assert.equal(log.problemCount, 0);
});

test("asset browser: player.aseprite mantém clips, associação e atualização visual após reimport", async () => {
  const port = new FakeAssetPort();
  port.assetName = "player.aseprite";
  port.clips = ["idle", "run", "jump", "fall"];
  const controller = new AssetBrowserController(port, { createOperationId: () => "player-import" });
  controller.importSources(["/project/player.aseprite"]);
  await settle();
  controller.handleApplicationEvent(applicationEvent("asset/operationCompleted", "player-import", {
    payload: { assetId: "hero" },
  }));
  await settle();
  const first = await controller.details("hero");
  assert.deepEqual(first.clips.map(({ name }) => name), ["idle", "run", "jump", "fall"]);
  const definition = withSpriteRenderer({
    entityDefId: "Player",
    archetypeId: "player",
    fields: [],
  }, "hero", "idle");
  assert.deepEqual(definition.spriteRenderer, { assetId: "hero", defaultClip: "idle" });

  const oldKey = assetInspectorCatalogKey(controller.snapshot.catalogVersion, "hero");
  port.revision = 2;
  port.thumbnailDataUrl = "data:image/png;base64,REVISION2";
  controller.handleApplicationEvent(applicationEvent("asset/catalogChanged", undefined, {
    payload: { assetId: "hero" },
  }));
  await settle();
  const newKey = assetInspectorCatalogKey(controller.snapshot.catalogVersion, "hero");
  assert.notEqual(newKey, oldKey, "inspector subscription receives a new catalog key");
  assert.equal(controller.snapshot.assets[0]?.revision, 2);
  assert.equal((await controller.details("hero", true)).asset.thumbnailDataUrl, port.thumbnailDataUrl);
});

test("asset browser: resultado de detectar/testar ferramentas permanece visível e objetivo", () => {
  assert.equal(
    assetToolConfigurationSummary({
      scope: "project",
      aseprite: { path: "/tools/aseprite", version: "1.3.7" },
      mgcb: { path: "/tools/mgcb", version: "3.8" },
    }),
    "Configuração validada (project) · Aseprite 1.3.7 — /tools/aseprite · MGCB 3.8 — /tools/mgcb.",
  );
});

class FakeAssetPort implements AssetCatalogPort {
  imports: AssetImportInput[] = [];
  reimports: Array<{ assetId: string; operationId?: string }> = [];
  catalogReads = 0;
  detailReads = 0;
  revision = 1;
  assetName = "Hero";
  thumbnailDataUrl = "data:image/png;base64,REVISION1";
  clips: string[] = [];

  async assetCatalog(): Promise<AssetCatalogResult> {
    this.catalogReads++;
    return {
      projectSessionId: "session",
      projectId: "project",
      assets: [{
        ...asset("hero", this.assetName, "sprites/players", ["player"]),
        revision: this.revision,
        thumbnailDataUrl: this.thumbnailDataUrl,
      }],
      tags: ["player"],
      directories: ["sprites/players"],
    };
  }

  async assetDetails(assetId: string): Promise<AssetDetails> {
    this.detailReads++;
    const clips = this.clips.map((name) => ({
      name,
      from: 0,
      to: 0,
      direction: "forward" as const,
      playback: [0],
      durationMs: 100,
    }));
    return {
      asset: {
        ...asset(assetId, this.assetName, "sprites/players", []),
        revision: this.revision,
        thumbnailDataUrl: this.thumbnailDataUrl,
      },
      payload: {},
      frames: [],
      clips,
      frameTags: clips,
      slices: [],
    };
  }

  async importAsset(input: AssetImportInput) {
    this.imports.push(input);
    return operation(input.operationId ?? "generated", "import");
  }

  async reimportAsset(assetId: string, operationId?: string) {
    this.reimports.push({ assetId, ...(operationId ? { operationId } : {}) });
    return { ...operation(operationId ?? "generated", "reimport"), assetId };
  }

  async removeAsset(assetId: string) { return { assetId, removed: true }; }
  async revealSource(reference: { assetId: string } | { operationId: string }) {
    return {
      operationId: "reveal-source",
      ...( "assetId" in reference ? { assetId: reference.assetId } : { sourceOperationId: reference.operationId }),
      target: "source" as const,
      path: "/source",
      revealed: true,
    };
  }
  async revealOutput(assetId: string) {
    return { operationId: "reveal-output", assetId, target: "output" as const, path: "/output", revealed: true };
  }
  async cancelAssetOperation(operationId: string) {
    return { operationId, status: "cancellation-requested" as const, cancelled: true };
  }
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

function applicationEvent(
  kind: string,
  operationId?: string,
  override: Partial<EditorApplicationEvent> = {},
): EditorApplicationEvent {
  return {
    seq: "1",
    projectSessionId: "session",
    projectId: "project",
    commandSequence: "0",
    domain: "asset",
    kind,
    ...(operationId ? { operationId } : {}),
    severity: "info",
    payload: {},
    timestamp: "0",
    ...override,
  };
}

function asset(
  assetId: string,
  name: string,
  directory: string,
  tags: readonly string[],
): AssetSummary {
  return {
    assetId,
    kind: "aseprite",
    name,
    revision: 1,
    sourcePath: `/sources/${assetId}.aseprite`,
    directory,
    tags,
    clipCount: 0,
    updatedAt: "0",
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
