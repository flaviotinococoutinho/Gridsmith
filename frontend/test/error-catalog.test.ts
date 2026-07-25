/**
 * Catálogo de erros (frente F5): toda falha que alcança o usuário sai como
 * causa + ação em pt-BR, e nenhuma mensagem técnica em inglês vaza para a UI.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CATALOG,
  extractErrorCode,
  presentError,
} from "../src/core/errorCatalog.js";

test("catálogo: código conhecido vira causa e ação acionáveis em pt-BR", () => {
  const presented = presentError(new Error("No project session is active (code -32008)"));
  assert.equal(presented.title, "Nenhum projeto aberto");
  assert.match(presented.cause, /projeto ativo/);
  assert.match(presented.action, /Crie um projeto novo/);
  // o texto técnico é preservado para diagnóstico, sem o sufixo do código
  assert.equal(presented.detail, "No project session is active");
});

test("catálogo: aceita o sufixo do gRPC (código) e o do GraphQL (code)", () => {
  assert.equal(extractErrorCode("falhou (código -32009)"), -32009);
  assert.equal(extractErrorCode("failed (code -32001)"), -32001);
  assert.equal(extractErrorCode("sem código nenhum"), undefined);
  assert.equal(
    presentError("Project session changed (código -32009)").title,
    "O projeto mudou durante a operação",
  );
});

test("catálogo: código desconhecido não é engolido — vira genérico com o detalhe", () => {
  const presented = presentError(new Error("boom inesperado (code -32999)"));
  assert.equal(presented.title, "Não foi possível concluir a operação");
  assert.equal(presented.detail, "boom inesperado");
  assert.match(presented.action, /Saída/);
});

test("catálogo: nunca lança e sempre devolve algo exibível", () => {
  for (const input of [undefined, null, "", 42, {}, new Error("")]) {
    const presented = presentError(input);
    assert.ok(presented.title.length > 0);
    assert.ok(presented.cause.length > 0);
    assert.ok(presented.action.length > 0);
  }
});

test("catálogo: código explícito tem precedência sobre o texto", () => {
  const presented = presentError(new Error("qualquer coisa (code -32602)"), -32001);
  assert.equal(presented.title, "Versões incompatíveis");
});

test("catálogo: toda entrada é pt-BR, com causa e ação preenchidas", () => {
  const semAcao: string[] = [];
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    if (!entry.title || !entry.cause || !entry.action) semAcao.push(code);
    // heurística simples de idioma: nenhum título termina em construção típica
    // do inglês usada nas mensagens cruas do middleware
    assert.ok(
      !/\b(is|not|the|failed|must)\b/i.test(entry.title),
      `entrada ${code} tem título em inglês: ${entry.title}`,
    );
  }
  assert.deepEqual(semAcao, [], "toda entrada precisa de título, causa e ação");
});
