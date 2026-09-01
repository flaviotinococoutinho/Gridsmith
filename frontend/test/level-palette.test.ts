import assert from "node:assert/strict";
import { test } from "node:test";
import { keepActiveValue, resolveLevelPalette } from "../src/core/levelPalette.js";
import { LEVEL_PALETTE } from "../src/core/levelPresets.js";

test("sem paleta no documento, o fallback de build vale inteiro", () => {
  // v3 e anteriores, ou nível recém-criado: abrir sem paleta nenhuma seria
  // pior que abrir com os significados default
  assert.equal(resolveLevelPalette(undefined, LEVEL_PALETTE), LEVEL_PALETTE);
  assert.equal(resolveLevelPalette([], LEVEL_PALETTE), LEVEL_PALETTE);
});

test("com paleta no documento, o DOCUMENTO manda — nome, cor e ordem", () => {
  // era aqui que a interface mentia: o editor desenhava "Chão"/"#7a5230"
  // sobre um documento que diz outra coisa
  const resolved = resolveLevelPalette(
    [
      { value: 7, name: "Água", color: "#1f6f9a" },
      { value: 2, name: "Rocha", color: "#444444" },
    ],
    LEVEL_PALETTE,
  );

  assert.deepEqual(resolved, [
    { value: 2, name: "Rocha", color: "#444444", shortcut: "1" },
    { value: 7, name: "Água", color: "#1f6f9a", shortcut: "2" },
  ]);
});

test("o atalho é POSICIONAL, não o valor — e acaba no nono", () => {
  // um documento pode nomear os valores 100 e 200; o usuário continua
  // alcançando os dois com 1 e 2
  const dez = Array.from({ length: 10 }, (_, i) => ({
    value: (i + 1) * 100,
    name: `n${i}`,
    color: "#000000",
  }));
  const resolved = resolveLevelPalette(dez, LEVEL_PALETTE);

  assert.equal(resolved[0]?.shortcut, "1");
  assert.equal(resolved[8]?.shortcut, "9");
  assert.equal(resolved[9]?.shortcut, undefined, "não há dígito para a décima");
});

test("o valor ativo sobrevive à troca de paleta quando ainda existe", () => {
  const palette = resolveLevelPalette(
    [
      { value: 2, name: "Rocha", color: "#444444" },
      { value: 7, name: "Água", color: "#1f6f9a" },
    ],
    LEVEL_PALETTE,
  );
  assert.equal(keepActiveValue(palette, 7), 7);
});

test("valor ativo que a paleta nova não nomeia cai para a primeira entrada", () => {
  // mantê-lo ativo deixaria o pincel pintando um significado sem nome, e sem
  // swatch por onde voltar a ele
  const palette = resolveLevelPalette([{ value: 2, name: "Rocha", color: "#444444" }], LEVEL_PALETTE);
  assert.equal(keepActiveValue(palette, 99), 2);
});

test("paleta vazia não zera a seleção", () => {
  // sem entradas não há para onde cair; trocar o valor por 0 (vazio) faria o
  // pincel virar borracha em silêncio
  assert.equal(keepActiveValue([], 3), 3);
});
