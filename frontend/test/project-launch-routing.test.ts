import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  focusExistingProjectWindow,
  projectPathFromArgs,
} from "../src/main/project/ProjectLaunchRouting.js";

test("argumento da segunda instância resolve o projeto correto relativo ao cwd recebido", () => {
  assert.equal(
    projectPathFromArgs(["electron", "--flag", "projects/Jogo.P7M.JSON"], "/workspace"),
    path.resolve("/workspace/projects/Jogo.P7M.JSON"),
  );
  assert.equal(projectPathFromArgs(["electron", "--flag"], "/workspace"), undefined);
});

test("segunda instância restaura e foca a janela existente", () => {
  const calls: string[] = [];
  const focused = focusExistingProjectWindow({
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    focus: () => calls.push("focus"),
  });

  assert.equal(focused, true);
  assert.deepEqual(calls, ["restore", "focus"]);
  assert.equal(focusExistingProjectWindow(undefined), false);
});
