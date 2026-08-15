import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { atlasImageMime, resolveAtlasImagePath } from "../src/main/project/AtlasImagePath.js";

const PROJECT = path.join(path.sep, "jogos", "plataforma", "meu-jogo.gridsmith.json");
const DIR = path.join(path.sep, "jogos", "plataforma");

test("referência relativa resolve DENTRO do diretório do projeto", () => {
  assert.equal(
    resolveAtlasImagePath(PROJECT, "assets/terreno.png"),
    path.join(DIR, "assets", "terreno.png"),
  );
  // subir e voltar para dentro é aceito — o que importa é onde TERMINA
  assert.equal(
    resolveAtlasImagePath(PROJECT, "assets/../assets/terreno.png"),
    path.join(DIR, "assets", "terreno.png"),
  );
});

test("o documento é entrada NÃO confiável: escapar do projeto é recusado", () => {
  // sem esta recusa, o visualizador de tiles viraria um leitor de arquivos
  // arbitrários do usuário — o documento pode ter sido editado à mão ou
  // gerado por um agente
  assert.equal(resolveAtlasImagePath(PROJECT, "../outro-projeto/atlas.png"), undefined);
  assert.equal(resolveAtlasImagePath(PROJECT, "../../etc/passwd"), undefined);
  assert.equal(resolveAtlasImagePath(PROJECT, "assets/../../segredo.png"), undefined);
  // absoluto nunca: a referência é relativa ao projeto por contrato (o
  // documento é portátil entre máquinas)
  assert.equal(resolveAtlasImagePath(PROJECT, path.join(DIR, "assets", "a.png")), undefined);
  assert.equal(resolveAtlasImagePath(PROJECT, "C:\\windows\\system32\\config"), undefined);
  assert.equal(resolveAtlasImagePath(PROJECT, ""), undefined);
});

test("irmão com prefixo comum NÃO passa pelo teste de contenção", () => {
  // "/jogos/plataforma" × "/jogos/plataforma-2": startsWith sem separador
  // aceitaria o segundo — o sufixo com path.sep é o que impede
  assert.equal(resolveAtlasImagePath(PROJECT, "../plataforma-2/atlas.png"), undefined);
});

test("só formatos que o canvas decodifica ganham MIME; o resto é recusado", () => {
  assert.equal(atlasImageMime("a/terreno.png"), "image/png");
  assert.equal(atlasImageMime("a/TERRENO.PNG"), "image/png");
  assert.equal(atlasImageMime("a/foto.jpg"), "image/jpeg");
  assert.equal(atlasImageMime("a/foto.webp"), "image/webp");
  assert.equal(atlasImageMime("a/atlas.svg"), undefined, "svg executa script; nunca");
  assert.equal(atlasImageMime("a/atlas.bmp"), undefined);
  assert.equal(atlasImageMime("a/sem-extensao"), undefined);
});
