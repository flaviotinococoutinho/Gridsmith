/**
 * Extensão do documento de projeto após o rebrand P7M → Gridsmith.
 *
 * O ponto destes testes é uma armadilha real: os testes que citam a extensão
 * a tratam como string de caminho OPACA (a lifecycle nunca a parseia, o
 * ProjectFileService só deriva sidecars), então um rename PELA METADE — filtro
 * do diálogo novo, roteamento de argv velho — passa por toda a suíte VERDE e
 * só aparece quando o usuário não encontra o próprio projeto no diálogo Abrir.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEGACY_PROJECT_EXTENSION,
  PROJECT_EXTENSION,
  PROJECT_EXTENSIONS,
  defaultProjectFileName,
  isProjectPath,
  projectNameFromPath,
} from "../src/core/projectExtensions.js";
import { projectPathFromArgs } from "../src/main/project/ProjectLaunchRouting.js";

test("a leitura aceita o sufixo NOVO e o HERDADO — o rebrand não órfã projeto nenhum", () => {
  assert.equal(isProjectPath("/jogos/plataforma.gridsmith.json"), true);
  assert.equal(isProjectPath("/jogos/plataforma.p7m.json"), true);
  // caixa não importa: o Windows entrega o caminho como o usuário digitou
  assert.equal(isProjectPath("/jogos/PLATAFORMA.P7M.JSON"), true);
});

test("o que NÃO é projeto continua fora", () => {
  assert.equal(isProjectPath("/jogos/plataforma.json"), false);
  assert.equal(isProjectPath("/jogos/plataforma.gridsmith.json.bak"), false);
  assert.equal(isProjectPath("/jogos/gridsmith.json.txt"), false);
});

test("a ESCRITA de caminho novo emite só o sufixo novo", () => {
  // quem abriu um .p7m.json continua salvando NELE (o filePath do descriptor
  // manda); esta é a sugestão de nome para Novo / Salvar como
  assert.equal(defaultProjectFileName("Plataforma"), "Plataforma.gridsmith.json");
  assert.equal(PROJECT_EXTENSION, "gridsmith.json");
  assert.equal(LEGACY_PROJECT_EXTENSION, "p7m.json");
});

test("o filtro do diálogo carrega as DUAS: com uma só, todo projeto antigo fica inselecionável", () => {
  // o showOpenDialog passa este filtro ÚNICO, sem entrada "Todos os arquivos"
  assert.deepEqual([...PROJECT_EXTENSIONS], ["gridsmith.json", "p7m.json"]);
  for (const extension of PROJECT_EXTENSIONS) {
    assert.equal(extension.startsWith("."), false, "o Electron exige o sufixo SEM ponto inicial");
  }
});

test("o nome exibido perde QUALQUER sufixo aceito — o rebrand não vaza para o título", () => {
  // tirar só o sufixo novo faria o projeto herdado abrir chamado "jogo.p7m"
  assert.equal(projectNameFromPath("/jogos/plataforma.gridsmith.json"), "plataforma");
  assert.equal(projectNameFromPath("/jogos/plataforma.p7m.json"), "plataforma");
  assert.equal(projectNameFromPath("C:\\jogos\\plataforma.p7m.json"), "plataforma");
  // arquivo sem sufixo conhecido mantém o nome inteiro em vez de virar vazio
  assert.equal(projectNameFromPath("/jogos/solto.json"), "solto.json");
});

test("o roteamento de argv usa a MESMA fonte — arrastar um .p7m.json ainda abre", () => {
  assert.equal(
    projectPathFromArgs(["/usr/bin/electron", "/jogos/antigo.p7m.json"]),
    "/jogos/antigo.p7m.json",
  );
  assert.equal(
    projectPathFromArgs(["/usr/bin/electron", "/jogos/novo.gridsmith.json"]),
    "/jogos/novo.gridsmith.json",
  );
  assert.equal(projectPathFromArgs(["/usr/bin/electron", "--pipe", "gridsmith-engine"]), undefined);
});
