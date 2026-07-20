import assert from "node:assert/strict";
import test from "node:test";
import { asepriteSourcePaths } from "../src/renderer/assetFileDropAdapter.js";

test("asset drop adapter: resolve caminhos somente pela porta injetada", () => {
  const files = [
    { name: "hero.aseprite" },
    { name: "notes.txt" },
    { name: "enemy.ASE" },
  ] as File[];
  const observed: string[] = [];
  const paths = asepriteSourcePaths(files, {
    pathOf: (file) => {
      observed.push(file.name);
      return `/dropped/${file.name}`;
    },
  });
  assert.deepEqual(paths, ["/dropped/hero.aseprite", "/dropped/enemy.ASE"]);
  assert.deepEqual(observed, ["hero.aseprite", "enemy.ASE"]);
});

test("asset drop adapter: ignora arquivo sem caminho em vez de ler File.path", () => {
  const file = { name: "hero.aseprite", path: "/unsafe/legacy-path" } as unknown as File;
  assert.deepEqual(asepriteSourcePaths([file], { pathOf: () => undefined }), []);
});
