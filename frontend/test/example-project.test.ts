import assert from "node:assert/strict";
import { test } from "node:test";
import { planExampleCopyName, pickExampleDocument } from "../src/core/exampleProject.js";

test("o primeiro nome livre é o base; depois vêm os sufixos a partir de 2", () => {
  assert.equal(planExampleCopyName("plataforma-2d", []), "plataforma-2d");
  assert.equal(planExampleCopyName("plataforma-2d", ["plataforma-2d"]), "plataforma-2d-2");
  assert.equal(
    planExampleCopyName("plataforma-2d", ["plataforma-2d", "plataforma-2d-2"]),
    "plataforma-2d-3",
  );
});

test("um buraco na sequência é reaproveitado — o sufixo não é contador", () => {
  // abrir três vezes e apagar a segunda não deve empurrar a próxima para -4:
  // o que importa é estar LIVRE, não quantas já existiram
  assert.equal(
    planExampleCopyName("plataforma-2d", ["plataforma-2d", "plataforma-2d-3"]),
    "plataforma-2d-2",
  );
});

test("nome ocupado com outra caixa também está ocupado", () => {
  // macOS e Windows não distinguem: escolher "plataforma-2d" com
  // "Plataforma-2D" no disco daria um mkdir que falha (ou pior, uma sobrescrita)
  assert.equal(planExampleCopyName("plataforma-2d", ["Plataforma-2D"]), "plataforma-2d-2");
});

test("o documento do exemplo é o único arquivo de projeto do diretório", () => {
  assert.equal(
    pickExampleDocument(["assets", "README.md", "plataforma-2d.gridsmith.json"]),
    "plataforma-2d.gridsmith.json",
  );
  // extensão herdada continua sendo documento de projeto
  assert.equal(pickExampleDocument(["antigo.p7m.json"]), "antigo.p7m.json");
});

test("zero ou dois documentos NÃO viram escolha implícita", () => {
  assert.equal(pickExampleDocument(["assets", "README.md"]), undefined);
  assert.equal(pickExampleDocument(["a.gridsmith.json", "b.gridsmith.json"]), undefined);
});
