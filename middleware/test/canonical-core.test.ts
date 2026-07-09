import assert from "node:assert/strict";
import { test } from "node:test";
import { HookBus } from "../src/canonical/HookBus.js";
import { ArtifactStore, contentHashOf, stableStringify } from "../src/canonical/ArtifactStore.js";
import { ASEPRITE_PIPELINE, PipelineRunner } from "../src/canonical/Pipeline.js";
import { importAseprite } from "../src/assets/AsepriteImporter.js";

// ---------- HookBus ----------

test("filters transformam em cadeia respeitando prioridade", async () => {
  const hooks = new HookBus();
  hooks.addFilter("command:light/add", (v) => `${v}-b`, { priority: 20 });
  hooks.addFilter("command:light/add", (v) => `${v}-a`, { priority: 5 });
  const result = await hooks.applyFilters("command:light/add", "x");
  assert.equal(result, "x-a-b"); // prioridade menor roda primeiro
});

test("actions isolam erros sem interromper os demais handlers", async () => {
  const hooks = new HookBus();
  const calls: string[] = [];
  hooks.addAction("event:lightAdded", () => calls.push("first"), { id: "ok-1", priority: 1 });
  hooks.addAction(
    "event:lightAdded",
    () => {
      throw new Error("boom");
    },
    { id: "broken", priority: 2 },
  );
  hooks.addAction("event:lightAdded", () => calls.push("last"), { id: "ok-2", priority: 3 });

  const result = await hooks.doAction("event:lightAdded", {});
  assert.deepEqual(calls, ["first", "last"]);
  assert.equal(result.completed, 2);
  assert.deepEqual(result.errors, [{ handlerId: "broken", message: "boom" }]);
});

test("unsubscribe remove o handler e listHooks inventaria o barramento", async () => {
  const hooks = new HookBus();
  const off = hooks.addFilter("f", (v) => `${v}!`, { id: "shout" });
  hooks.addAction("a", () => {}, { id: "observer", priority: 3 });

  const inventory = hooks.listHooks();
  assert.deepEqual(inventory, [
    { hook: "a", kind: "action", handlers: [{ id: "observer", priority: 3 }] },
    { hook: "f", kind: "filter", handlers: [{ id: "shout", priority: 10 }] },
  ]);

  off();
  assert.equal(await hooks.applyFilters("f", "quiet"), "quiet");
});

// ---------- ArtifactStore ----------

test("hash de conteúdo é estável independente da ordem das chaves", () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [3] } }), '{"a":{"c":[3],"d":2},"b":1}');
  assert.equal(contentHashOf({ a: 1, b: 2 }), contentHashOf({ b: 2, a: 1 }));
  assert.notEqual(contentHashOf({ a: 1 }), contentHashOf({ a: 2 }));
});

test("revisões são append-only com dedup por hash", () => {
  let clock = 1000;
  const store = new ArtifactStore(() => clock++);
  const meta = { createdBy: "agent:test" };

  const r1 = store.publish({ artifactId: "hero", kind: "sprite-document", schemaVersion: 1, payload: { v: 1 }, metadata: meta });
  const dedup = store.publish({ artifactId: "hero", kind: "sprite-document", schemaVersion: 1, payload: { v: 1 }, metadata: meta });
  const r2 = store.publish({ artifactId: "hero", kind: "sprite-document", schemaVersion: 1, payload: { v: 2 }, metadata: meta });

  assert.equal(r1.revision, 1);
  assert.equal(dedup, r1); // payload idêntico não gera revisão
  assert.equal(r2.revision, 2);
  assert.equal(store.history("hero").length, 2);
  assert.equal(store.get("hero")?.revision, 2);
  assert.equal(store.get("hero", 1)?.contentHash, r1.contentHash);
});

test("kind é imutável por artefato e proveniência é obrigatória", () => {
  const store = new ArtifactStore(() => 0);
  store.publish({ artifactId: "x", kind: "level", schemaVersion: 1, payload: {}, metadata: { createdBy: "user:flavio" } });
  assert.throws(
    () => store.publish({ artifactId: "x", kind: "sprite", schemaVersion: 1, payload: {}, metadata: { createdBy: "u" } }),
    /cannot republish as/,
  );
  assert.throws(
    () => store.publish({ artifactId: "y", kind: "level", schemaVersion: 1, payload: {}, metadata: {} as never }),
    /createdBy/,
  );
});

test("list filtra por kind e retorna só as últimas revisões", () => {
  const store = new ArtifactStore(() => 0);
  const meta = { createdBy: "t" };
  store.publish({ artifactId: "a", kind: "level", schemaVersion: 1, payload: { n: 1 }, metadata: meta });
  store.publish({ artifactId: "a", kind: "level", schemaVersion: 1, payload: { n: 2 }, metadata: meta });
  store.publish({ artifactId: "b", kind: "sprite-document", schemaVersion: 1, payload: {}, metadata: meta });

  const levels = store.list("level");
  assert.equal(levels.length, 1);
  assert.equal(levels[0]?.revision, 2);
  assert.equal(store.list().length, 2);
});

// ---------- Pipeline ----------

const MINI_ASEPRITE = {
  frames: {
    "s 0": { frame: { x: 0, y: 0, w: 8, h: 8 }, duration: 50 },
    "s 1": { frame: { x: 8, y: 0, w: 8, h: 8 }, duration: 60 },
  },
  meta: {
    image: "s.png",
    frameTags: [{ name: "spin", from: 0, to: 1, direction: "forward" }],
    slices: [],
  },
};

test("pipeline executa estágios como filters e publica artefato com proveniência", async () => {
  const hooks = new HookBus();
  const artifacts = new ArtifactStore(() => 42);
  const runner = new PipelineRunner(hooks, artifacts);
  runner.register(ASEPRITE_PIPELINE);
  hooks.addFilter(`pipeline:aseprite-import:parse`, (raw) => importAseprite(raw));

  const stages: string[] = [];
  hooks.addAction("pipeline:stage:completed", (p) => {
    stages.push((p as { stage: string }).stage);
  });

  const envelope = await runner.run("aseprite-import", MINI_ASEPRITE, { artifactId: "sprites/spinner" });

  assert.equal(envelope.kind, "sprite-document");
  assert.equal(envelope.metadata.createdBy, "pipeline:aseprite-import");
  assert.deepEqual(stages, ["parse", "enrich"]);
  const doc = envelope.payload as { clips: Array<{ name: string; durationMs: number }> };
  assert.equal(doc.clips[0]?.name, "spin");
  assert.equal(doc.clips[0]?.durationMs, 110);

  // reprocessar a MESMA fonte não gera revisão nova (determinismo + dedup)
  const again = await runner.run("aseprite-import", MINI_ASEPRITE, { artifactId: "sprites/spinner" });
  assert.equal(again.revision, envelope.revision);
});

test("estágios são extensíveis por filters de terceiros", async () => {
  const hooks = new HookBus();
  const artifacts = new ArtifactStore(() => 0);
  const runner = new PipelineRunner(hooks, artifacts);
  runner.register(ASEPRITE_PIPELINE);
  hooks.addFilter("pipeline:aseprite-import:parse", (raw) => importAseprite(raw), { priority: 10 });
  // plugin: estágio "enrich" adiciona metadado sem tocar no pipeline
  hooks.addFilter(
    "pipeline:aseprite-import:enrich",
    (doc) => ({ ...(doc as object), palette: "auto-extracted" }),
    { priority: 20 },
  );

  const envelope = await runner.run("aseprite-import", MINI_ASEPRITE, { artifactId: "sprites/x" });
  assert.equal((envelope.payload as { palette: string }).palette, "auto-extracted");
});

test("pipeline desconhecido e registro duplicado são rejeitados", async () => {
  const hooks = new HookBus();
  const runner = new PipelineRunner(hooks, new ArtifactStore(() => 0));
  runner.register(ASEPRITE_PIPELINE);
  assert.throws(() => runner.register(ASEPRITE_PIPELINE), /already registered/);
  await assert.rejects(runner.run("nope", {}, { artifactId: "a" }), /not registered/);
});
