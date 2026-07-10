import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssetPipelineService,
  AssetToolError,
  type ToolResult,
  type ToolRunner,
} from "../src/assets/AssetPipelineService.js";
import { ArtifactStore } from "../src/canonical/ArtifactStore.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { ASEPRITE_PIPELINE, PipelineRunner } from "../src/canonical/Pipeline.js";
import { importAseprite } from "../src/assets/AsepriteImporter.js";

const EXPORT_FIXTURE = {
  frames: {
    "hero 0": { frame: { x: 0, y: 0, w: 16, h: 16 }, duration: 100 },
    "hero 1": { frame: { x: 16, y: 0, w: 16, h: 16 }, duration: 120 },
  },
  meta: {
    image: "hero.png",
    frameTags: [{ name: "idle", from: 0, to: 1, direction: "forward" }],
    slices: [],
  },
};

/** Runner falso: registra chamadas e materializa as saídas das ferramentas. */
class FakeRunner implements ToolRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  failWith: { tool: string; code: number; stderr: string } | undefined;

  async run(command: string, args: readonly string[]): Promise<ToolResult> {
    this.calls.push({ command, args: [...args] });
    if (this.failWith && command === this.failWith.tool) {
      return { code: this.failWith.code, stdout: "", stderr: this.failWith.stderr };
    }
    if (command === "aseprite") {
      const dataPath = args[args.indexOf("--data") + 1]!;
      const sheetPath = args[args.indexOf("--sheet") + 1]!;
      fs.writeFileSync(dataPath, JSON.stringify(EXPORT_FIXTURE));
      fs.writeFileSync(sheetPath, "png-bytes");
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

interface Harness {
  service: AssetPipelineService;
  runner: FakeRunner;
  artifacts: ArtifactStore;
  hooks: HookBus;
  assetsRoot: string;
  cleanup(): void;
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p7m-assets-"));
  const assetsRoot = path.join(root, "catalog");
  const outputRoot = path.join(root, "out");
  fs.mkdirSync(path.join(assetsRoot, "characters", "boss"), { recursive: true });

  const hooks = new HookBus();
  const artifacts = new ArtifactStore(() => 0);
  const pipelines = new PipelineRunner(hooks, artifacts);
  pipelines.register(ASEPRITE_PIPELINE);
  hooks.addFilter(`pipeline:${ASEPRITE_PIPELINE.pipelineId}:parse`, (raw) => importAseprite(raw));

  const runner = new FakeRunner();
  const service = new AssetPipelineService({
    assetsRoot,
    outputRoot,
    runner,
    pipelines,
    hooks,
  });
  return {
    service,
    runner,
    artifacts,
    hooks,
    assetsRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function touchAsset(h: Harness, relative: string): string {
  const full = path.join(h.assetsRoot, relative);
  fs.writeFileSync(full, "aseprite-binary");
  return full;
}

test("ingest orquestra aseprite → pipeline canônico → mgcb com taxonomia por diretório", async () => {
  const h = makeHarness();
  try {
    const ingested: unknown[] = [];
    h.hooks.addAction("asset:ingested", (payload) => {
      ingested.push(payload);
    });

    const file = touchAsset(h, path.join("characters", "boss", "hero.aseprite"));
    const result = await h.service.ingest(file);

    assert.equal(result.status, "ingested");
    if (result.status !== "ingested") return;
    assert.equal(result.artifactId, "assets/characters/boss/hero");
    assert.deepEqual(result.tags, ["characters", "boss"]);
    assert.equal(result.clipCount, 1);

    // artefato canônico publicado com taxonomia e proveniência do arquivo
    const envelope = h.artifacts.get("assets/characters/boss/hero")!;
    assert.deepEqual(envelope.metadata.tags, ["characters", "boss"]);
    assert.equal(envelope.metadata.source, file);

    // ordem e forma das chamadas de ferramenta
    assert.equal(h.runner.calls[0]?.command, "aseprite");
    assert.ok(h.runner.calls[0]?.args.includes("--list-tags"));
    assert.equal(h.runner.calls[1]?.command, "mgcb");
    assert.ok(h.runner.calls[1]?.args.some((a) => a === "/platform:DesktopGL"));
    assert.ok(h.runner.calls[1]?.args.some((a) => a.startsWith("/build:") && a.endsWith("hero.png")));

    // hook de observabilidade disparou com o resultado
    assert.equal((ingested[0] as { artifactId: string }).artifactId, "assets/characters/boss/hero");
  } finally {
    h.cleanup();
  }
});

test("re-ingestão do mesmo conteúdo não gera revisão nova (dedup canônico)", async () => {
  const h = makeHarness();
  try {
    const file = touchAsset(h, path.join("characters", "hero.aseprite"));
    const first = await h.service.ingest(file);
    const second = await h.service.ingest(file);
    assert.equal(first.status, "ingested");
    assert.equal(second.status, "ingested");
    if (first.status !== "ingested" || second.status !== "ingested") return;
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 1); // payload idêntico → mesma revisão
  } finally {
    h.cleanup();
  }
});

test("extensões não-Aseprite são ignoradas com razão", async () => {
  const h = makeHarness();
  try {
    const file = touchAsset(h, "notes.txt");
    const result = await h.service.ingest(file);
    assert.equal(result.status, "ignored");
    if (result.status === "ignored") assert.match(result.reason, /\.txt/);
    assert.equal(h.runner.calls.length, 0);
  } finally {
    h.cleanup();
  }
});

test("falhas das ferramentas viram erros tipados com stderr", async () => {
  const h = makeHarness();
  try {
    const file = touchAsset(h, "broken.ase");
    h.runner.failWith = { tool: "aseprite", code: 3, stderr: "corrupt file" };
    await assert.rejects(h.service.ingest(file), (err: unknown) => {
      assert.ok(err instanceof AssetToolError);
      assert.equal(err.tool, "aseprite");
      assert.equal(err.exitCode, 3);
      assert.match(err.message, /corrupt file/);
      return true;
    });

    h.runner.failWith = { tool: "mgcb", code: 1, stderr: "shader profile missing" };
    await assert.rejects(h.service.ingest(file), (err: unknown) =>
      err instanceof AssetToolError && err.tool === "mgcb",
    );
  } finally {
    h.cleanup();
  }
});

test("catalog filtra as últimas revisões por tag", async () => {
  const h = makeHarness();
  try {
    await h.service.ingest(touchAsset(h, path.join("characters", "hero.aseprite")));
    fs.mkdirSync(path.join(h.assetsRoot, "props"), { recursive: true });
    await h.service.ingest(touchAsset(h, path.join("props", "barrel.aseprite")));

    const all = h.artifacts.list("sprite-document");
    assert.equal(all.length, 2);
    const characters = h.service.catalog(all, "characters");
    assert.equal(characters.length, 1);
    assert.equal(characters[0]?.artifactId, "assets/characters/hero");
  } finally {
    h.cleanup();
  }
});
