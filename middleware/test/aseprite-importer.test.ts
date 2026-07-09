import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AsepriteImportError,
  expandPlayback,
  importAseprite,
} from "../src/assets/AsepriteImporter.js";

/** Fixture: export real do CLI (`--data --format json-hash --list-tags --list-slices`). */
const HASH_EXPORT = {
  frames: {
    "hero 0.ase": { frame: { x: 0, y: 0, w: 32, h: 32 }, duration: 100 },
    "hero 1.ase": { frame: { x: 32, y: 0, w: 32, h: 32 }, duration: 100 },
    "hero 2.ase": { frame: { x: 64, y: 0, w: 32, h: 32 }, duration: 150 },
    "hero 3.ase": { frame: { x: 96, y: 0, w: 32, h: 32 }, duration: 80 },
  },
  meta: {
    app: "https://www.aseprite.org/",
    image: "hero.png",
    frameTags: [
      { name: "idle", from: 0, to: 1, direction: "forward" },
      { name: "walk", from: 1, to: 3, direction: "pingpong" },
      { name: "fall", from: 3, to: 3, direction: "reverse" },
    ],
    slices: [
      {
        name: "hitbox",
        keys: [
          {
            frame: 0,
            bounds: { x: 8, y: 4, w: 16, h: 28 },
            pivot: { x: 8, y: 28 },
          },
        ],
      },
      {
        name: "panel",
        keys: [
          {
            frame: 0,
            bounds: { x: 0, y: 0, w: 32, h: 32 },
            center: { x: 8, y: 8, w: 16, h: 16 },
          },
        ],
      },
    ],
  },
};

test("importa json-hash: frames, clipes e slices normalizados", () => {
  const doc = importAseprite(HASH_EXPORT);

  assert.equal(doc.imagePath, "hero.png");
  assert.equal(doc.frames.length, 4);
  assert.deepEqual(doc.frames[2], { index: 2, x: 64, y: 0, w: 32, h: 32, durationMs: 150 });

  assert.equal(doc.clips.length, 3);
  const idle = doc.clips.find((c) => c.name === "idle")!;
  assert.deepEqual(idle.playback, [0, 1]);
  assert.equal(idle.durationMs, 200);

  const hitbox = doc.slices.find((s) => s.name === "hitbox")!;
  assert.deepEqual(hitbox.pivot, { x: 8, y: 28 });
  assert.equal(hitbox.center, undefined);

  const panel = doc.slices.find((s) => s.name === "panel")!;
  assert.deepEqual(panel.center, { x: 8, y: 8, w: 16, h: 16 }); // 9-slice
});

test("importa json-array (frames como lista)", () => {
  const arrayExport = {
    ...HASH_EXPORT,
    frames: Object.values(HASH_EXPORT.frames),
  };
  const doc = importAseprite(arrayExport);
  assert.equal(doc.frames.length, 4);
  assert.equal(doc.frames[3]!.durationMs, 80);
});

test("pingpong expande sem repetir extremos e soma a duração do ciclo", () => {
  const doc = importAseprite(HASH_EXPORT);
  const walk = doc.clips.find((c) => c.name === "walk")!;
  // frames 1..3 em pingpong: 1, 2, 3, 2
  assert.deepEqual(walk.playback, [1, 2, 3, 2]);
  assert.equal(walk.durationMs, 100 + 150 + 80 + 150);
});

test("reverse inverte e clipe de um frame é estável em qualquer direção", () => {
  const doc = importAseprite(HASH_EXPORT);
  const fall = doc.clips.find((c) => c.name === "fall")!;
  assert.deepEqual(fall.playback, [3]);

  assert.deepEqual(expandPlayback(0, 3, "reverse"), [3, 2, 1, 0]);
  assert.deepEqual(expandPlayback(2, 2, "pingpong"), [2]);
  assert.deepEqual(expandPlayback(1, 2, "pingpong"), [1, 2]); // 2 frames: sem retorno
});

test("rejeita export malformado e tags com faixa inválida", () => {
  assert.throws(() => importAseprite({}), AsepriteImportError);
  assert.throws(() => importAseprite({ frames: {}, meta: {} }), /contains no frames/);

  const badTag = {
    frames: HASH_EXPORT.frames,
    meta: {
      image: "x.png",
      frameTags: [{ name: "broken", from: 2, to: 99, direction: "forward" }],
    },
  };
  assert.throws(() => importAseprite(badTag), /range \[2\.\.99\] is invalid/);

  const badDirection = {
    frames: HASH_EXPORT.frames,
    meta: {
      image: "x.png",
      frameTags: [{ name: "weird", from: 0, to: 1, direction: "sideways" }],
    },
  };
  assert.throws(() => importAseprite(badDirection), /unknown direction/);
});

test("slice sem keys é rejeitado", () => {
  const badSlice = {
    frames: HASH_EXPORT.frames,
    meta: { image: "x.png", slices: [{ name: "empty" }] },
  };
  assert.throws(() => importAseprite(badSlice), /has no keys with bounds/);
});
