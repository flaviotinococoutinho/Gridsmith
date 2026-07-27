/**
 * Recuperação de autosave (etapa E2).
 *
 * A regra que estes testes protegem: o sidecar só some por save confirmado ou
 * descarte explícito. Apagá-lo em qualquer outro momento perde trabalho do
 * usuário sem pedir licença.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { planRecovery, planWithoutRecovery } from "../src/core/recoveryPlan.js";

test("restaurar abre o autosave no projeto original, e abre SUJO", () => {
  const plan = planRecovery("restore");
  assert.equal(plan.proceed, true);
  assert.equal(plan.source, "autosave");
  assert.equal(plan.bindToFile, true);
  // conteúdo recuperado nunca esteve no arquivo: abrir limpo faria o usuário
  // fechar sem salvar e perder o mesmo trabalho outra vez
  assert.equal(plan.openDirty, true);
  assert.equal(plan.discardAutosave, false);
});

test("abrir cópia não vincula ao arquivo, então o original fica intocado", () => {
  const plan = planRecovery("copy");
  assert.equal(plan.source, "autosave");
  assert.equal(plan.bindToFile, false, "vincular sobrescreveria o original no primeiro save");
  assert.equal(plan.openDirty, true);
  assert.equal(plan.discardAutosave, false, "a cópia não autoriza descartar a recuperação");
});

test("ignorar é o ÚNICO caminho de abertura que descarta o sidecar", () => {
  const plan = planRecovery("ignore");
  assert.equal(plan.source, "original");
  assert.equal(plan.discardAutosave, true);
  assert.equal(plan.openDirty, false);

  for (const decision of ["restore", "copy", "cancel"] as const) {
    assert.equal(
      planRecovery(decision).discardAutosave,
      false,
      `${decision} não pode apagar a recuperação`,
    );
  }
});

test("cancelar não abre nada e não toca no sidecar", () => {
  const plan = planRecovery("cancel");
  assert.equal(plan.proceed, false);
  assert.equal(plan.discardAutosave, false);
});

test("decisão desconhecida cai em cancelar (fail-safe)", () => {
  const plan = planRecovery("qualquer-coisa" as never);
  assert.equal(plan.proceed, false);
  assert.equal(plan.discardAutosave, false);
});

test("sem recuperação pendente a abertura segue direta e não mexe no sidecar", () => {
  const plan = planWithoutRecovery();
  assert.equal(plan.proceed, true);
  assert.equal(plan.source, "original");
  assert.equal(plan.bindToFile, true);
  assert.equal(plan.openDirty, false);
  assert.equal(plan.discardAutosave, false);
  assert.equal(plan.notice, "");
});

test("todo plano que abre tem origem e vínculo coerentes", () => {
  for (const decision of ["restore", "copy", "ignore"] as const) {
    const plan = planRecovery(decision);
    assert.equal(plan.proceed, true);
    // abrir do autosave sempre implica trabalho não gravado no arquivo
    if (plan.source === "autosave") assert.equal(plan.openDirty, true);
    // e todo plano que abre diz alguma coisa ao usuário
    assert.ok(plan.notice.length > 0, `${decision} abriu em silêncio`);
  }
});
