import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProjectLifecycle,
  ProjectLifecycleError,
  type LifecycleEvent,
} from "../src/core/projectLifecycle.js";

function makeLifecycle(startMs = 0): { lifecycle: ProjectLifecycle; tick: (ms: number) => void } {
  let nowMs = startMs;
  const lifecycle = new ProjectLifecycle(() => nowMs, {
    intervalMs: 30_000,
    dirtyCommandThreshold: 3,
  });
  return { lifecycle, tick: (ms) => (nowMs += ms) };
}

test("fluxo feliz: novo → editar → salvar → fechar", () => {
  const { lifecycle } = makeLifecycle();
  assert.equal(lifecycle.currentState, "no-project");
  assert.equal(lifecycle.windowTitle, "P7M");

  lifecycle.beginOpen();
  lifecycle.opened({ name: "Meu Jogo" });
  assert.equal(lifecycle.currentState, "open-clean");
  assert.equal(lifecycle.windowTitle, "Meu Jogo — P7M");

  lifecycle.commandApplied();
  assert.equal(lifecycle.currentState, "open-dirty");
  assert.equal(lifecycle.windowTitle, "● Meu Jogo — P7M"); // marcador de sujo

  lifecycle.beginSave();
  lifecycle.saved("/projetos/meu-jogo.p7m.json");
  assert.equal(lifecycle.currentState, "open-clean");
  assert.equal(lifecycle.project?.filePath, "/projetos/meu-jogo.p7m.json");

  assert.equal(lifecycle.requestClose(), "close");
  assert.equal(lifecycle.currentState, "closing");
  lifecycle.confirmClose();
  assert.equal(lifecycle.currentState, "no-project");
});

test("fechar sujo exige confirmação; cancelar volta ao estado sujo", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.beginOpen();
  lifecycle.opened({ name: "P" });
  lifecycle.commandApplied();

  assert.equal(lifecycle.requestClose(), "confirm-discard");
  assert.equal(lifecycle.currentState, "closing");

  lifecycle.cancelClose();
  assert.equal(lifecycle.currentState, "open-dirty"); // nada foi perdido

  lifecycle.requestClose();
  lifecycle.confirmClose();
  assert.equal(lifecycle.currentState, "no-project");
});

test("falha remota ao fechar projeto limpo restaura a sessão local", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.beginOpen();
  lifecycle.opened({
    name: "A",
    projectSessionId: "session-a",
    projectId: "project-a",
  });

  assert.equal(lifecycle.requestClose(), "close");
  assert.equal(lifecycle.currentState, "closing");
  lifecycle.cancelClose();

  assert.equal(lifecycle.currentState, "open-clean");
  assert.equal(lifecycle.project?.projectSessionId, "session-a");
});

test("substituição transacional aceita abrir por cima e só troca no commit", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.beginOpen();
  lifecycle.opened({ name: "A", projectSessionId: "session-a", projectId: "a" });
  lifecycle.commandApplied();

  lifecycle.beginOpen();
  assert.equal(lifecycle.currentState, "opening");
  assert.equal(lifecycle.project?.name, "A");
  assert.equal(lifecycle.isDirty, true);

  lifecycle.opened({ name: "B", projectSessionId: "session-b", projectId: "b" });
  assert.equal(lifecycle.currentState, "open-clean");
  assert.equal(lifecycle.project?.name, "B");
  assert.equal(lifecycle.isDirty, false);
});

test("falha de abertura preserva descritor e dirty state anteriores", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.beginOpen();
  lifecycle.openFailed();
  assert.equal(lifecycle.currentState, "no-project");

  lifecycle.beginOpen();
  lifecycle.opened({ name: "B" });
  lifecycle.commandApplied();
  lifecycle.beginOpen();
  lifecycle.openFailed();
  assert.equal(lifecycle.currentState, "open-dirty");
  assert.equal(lifecycle.project?.name, "B");

  lifecycle.beginSave();
  lifecycle.saveFailed();
  assert.equal(lifecycle.currentState, "open-dirty"); // documento continua sujo
});

test("autosave dispara por limiar de comandos e por intervalo", () => {
  const { lifecycle, tick } = makeLifecycle();
  const events: LifecycleEvent[] = [];
  lifecycle.onEvent((e) => events.push(e));

  lifecycle.beginOpen();
  lifecycle.opened({ filePath: "/p/a.p7m.json", name: "A" });

  // limiar = 3 comandos
  assert.equal(lifecycle.commandApplied(), false);
  assert.equal(lifecycle.commandApplied(), false);
  assert.equal(lifecycle.commandApplied(), true); // autosaveDue
  assert.ok(events.some((e) => e.kind === "autosaveDue"));

  // intervalo: 30 s desde o último save
  lifecycle.beginSave();
  lifecycle.saved();
  lifecycle.commandApplied();
  assert.equal(lifecycle.autosaveTick(), false); // cedo demais
  tick(31_000);
  assert.equal(lifecycle.autosaveTick(), true);
  // documento limpo nunca dispara autosave
  lifecycle.beginSave();
  lifecycle.saved();
  tick(60_000);
  assert.equal(lifecycle.autosaveTick(), false);
});

test("eventos de replay durante opening não sujam o documento", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.beginOpen();
  // broadcast de blueprint/load chega ANTES do opened()
  assert.equal(lifecycle.commandApplied(), false);
  lifecycle.opened({ name: "C" });
  assert.equal(lifecycle.currentState, "open-clean");
});

test("watermark deduplica journal atrasado e mantém dirty para evento posterior ao snapshot", () => {
  const { lifecycle } = makeLifecycle();
  lifecycle.beginOpen();
  lifecycle.opened({ name: "Sequenciado" }, { commandSequence: "5" });

  assert.equal(lifecycle.commandApplied("6"), false);
  assert.equal(lifecycle.commandApplied("6"), false, "resposta + journal contam uma vez");
  lifecycle.beginSave();
  lifecycle.commandApplied("7"); // commit externo depois do snapshot de seq 6
  lifecycle.saved("/p/seq.p7m.json", "6");

  assert.equal(lifecycle.currentState, "open-dirty");
  assert.equal(lifecycle.isDirty, true);
  assert.equal(lifecycle.commandSequence, "7");
});

test("recentes: mais novo primeiro, sem duplicatas, máximo de 10", () => {
  const { lifecycle, tick } = makeLifecycle(1_000);
  for (let i = 0; i < 12; i++) {
    lifecycle.beginOpen();
    lifecycle.opened({ filePath: `/p/jogo-${i % 11}.p7m.json`, name: `Jogo ${i % 11}` });
    lifecycle.requestClose();
    lifecycle.confirmClose();
    tick(1_000);
  }

  const recents = lifecycle.recentProjects;
  assert.equal(recents.length, 10);
  // o último aberto (jogo-0, reaberto na iteração 11) é o primeiro da lista
  assert.equal(recents[0]?.filePath, "/p/jogo-0.p7m.json");
  const unique = new Set(recents.map((r) => r.filePath));
  assert.equal(unique.size, recents.length);
});

test("transições fora de ordem falham com erros tipados", () => {
  const { lifecycle } = makeLifecycle();
  assert.throws(() => lifecycle.opened({ name: "x" }), ProjectLifecycleError);
  assert.throws(() => lifecycle.beginSave(), ProjectLifecycleError);
  assert.throws(() => lifecycle.confirmClose(), ProjectLifecycleError);
});
