/**
 * Abertura por argumento e segunda instância (etapa E3).
 *
 * O caminho vem do sistema operacional — pode ser relativo ao diretório de
 * onde o usuário chamou, e vem misturado com as flags do Electron.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  focusExistingProjectWindow,
  projectPathFromArgs,
} from "../src/main/project/ProjectLaunchRouting.js";

test("encontra o projeto entre as flags do Electron", () => {
  const argv = ["/usr/bin/electron", ".", "--pipe", "gridsmith-engine", "/home/u/jogo.gridsmith.json"];
  assert.equal(projectPathFromArgs(argv, "/tmp"), "/home/u/jogo.gridsmith.json");
});

test("caminho relativo resolve contra o diretório de quem chamou, não o do app", () => {
  // é o caso do `gridsmith ./jogo.gridsmith.json` num terminal qualquer
  assert.equal(
    projectPathFromArgs(["electron", "./jogo.gridsmith.json"], "/home/u/projetos"),
    path.resolve("/home/u/projetos", "./jogo.gridsmith.json"),
  );
});

test("sem argumento de projeto devolve undefined", () => {
  assert.equal(projectPathFromArgs(["electron", ".", "--external-services"], "/tmp"), undefined);
  assert.equal(projectPathFromArgs([], "/tmp"), undefined);
});

test("só reconhece a extensão de projeto", () => {
  assert.equal(projectPathFromArgs(["electron", "/tmp/outro.json"], "/tmp"), undefined);
  assert.equal(projectPathFromArgs(["electron", "/tmp/x.gridsmith.JSON"], "/tmp"), "/tmp/x.gridsmith.JSON");
});

test("foco restaura a janela minimizada antes de focar", () => {
  const ordem: string[] = [];
  const janela = {
    isMinimized: () => true,
    restore: () => ordem.push("restore"),
    focus: () => ordem.push("focus"),
  };
  assert.equal(focusExistingProjectWindow(janela), true);
  assert.deepEqual(ordem, ["restore", "focus"]);
});

test("janela não minimizada só recebe foco; sem janela é no-op", () => {
  const ordem: string[] = [];
  assert.equal(
    focusExistingProjectWindow({
      isMinimized: () => false,
      restore: () => ordem.push("restore"),
      focus: () => ordem.push("focus"),
    }),
    true,
  );
  assert.deepEqual(ordem, ["focus"]);
  assert.equal(focusExistingProjectWindow(undefined), false);
});
