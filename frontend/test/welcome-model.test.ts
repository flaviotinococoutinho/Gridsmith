/**
 * Tela inicial (frente F8): o que o usuário vê enquanto não há projeto.
 *
 * Tudo aqui é núcleo puro — o relógio entra por parâmetro para o tempo
 * relativo ser determinístico em vez de depender de quando o teste roda.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeWelcome,
  relativeTime,
  shortenPath,
  type WelcomeInput,
} from "../src/core/welcomeModel.js";

const NOW = 1_700_000_000_000;
const base: WelcomeInput = {
  projectState: "no-project",
  recents: [],
  templates: [
    { id: "platformer-2d", label: "Plataforma 2D", description: "Cena de plataforma." },
  ],
  connected: true,
  now: () => NOW,
};

test("visível apenas sem projeto aberto", () => {
  assert.equal(describeWelcome(base).visible, true);
  for (const state of ["opening", "open-clean", "open-dirty", "saving", "closing"] as const) {
    assert.equal(
      describeWelcome({ ...base, projectState: state }).visible,
      false,
      `não deveria aparecer em ${state}`,
    );
  }
});

test("sem recentes: a dica aparece e as ações continuam disponíveis", () => {
  const view = describeWelcome(base);
  assert.equal(view.recents.length, 0);
  assert.ok(view.emptyHint.length > 0);
  assert.deepEqual(
    view.actions.map((a) => a.id),
    ["new", "open"],
  );
  assert.equal(view.actions.every((a) => a.enabled), true);
});

test("recentes ganham linha secundária com tempo relativo determinístico", () => {
  const view = describeWelcome({
    ...base,
    recents: [
      { filePath: "/home/u/jogos/plataforma.gridsmith.json", name: "Plataforma", lastOpenedUnixMs: NOW - 2 * 86_400_000 },
      { filePath: "/home/u/jogos/antigo.gridsmith.json", name: "Antigo", lastOpenedUnixMs: NOW - 90 * 86_400_000 },
    ],
  });
  assert.equal(view.emptyHint, "");
  assert.match(view.recents[0]!.secondary, /há 2 dias/);
  assert.match(view.recents[1]!.secondary, /há 3 meses/);
  // o caminho continua identificável na linha secundária
  assert.match(view.recents[0]!.secondary, /plataforma\.gridsmith\.json/);
});

test("offline: as ações desabilitam com razão em vez de falhar ao clicar", () => {
  const view = describeWelcome({ ...base, connected: false });
  assert.equal(view.actions.every((a) => !a.enabled), true);
  for (const action of view.actions) {
    assert.ok((action.reason ?? "").length > 0, `${action.id} sem razão`);
  }
  assert.match(view.subtitle, /serviços/i);
});

test("a ação de exemplo só aparece quando há exemplo", () => {
  assert.equal(describeWelcome(base).actions.some((a) => a.id === "example"), false);
  const comExemplo = describeWelcome({ ...base, exampleAvailable: true });
  assert.equal(comExemplo.actions.some((a) => a.id === "example"), true);
});

test("templates inválidos e duplicados não viram card", () => {
  const view = describeWelcome({
    ...base,
    templates: [
      { id: "platformer-2d", label: "Plataforma 2D", description: "a" },
      { id: "platformer-2d", label: "Duplicado", description: "b" },
      { id: "", label: "Sem id", description: "c" },
      { id: "sem-rotulo", label: "", description: "d" },
      { id: "top-down", label: "Aventura top-down", description: "e" },
    ] as never,
  });
  assert.deepEqual(view.templates.map((t) => t.templateId), ["platformer-2d", "top-down"]);
});

test("tempo relativo cobre as faixas e não inventa futuro", () => {
  assert.equal(relativeTime(NOW, NOW), "agora há pouco");
  assert.equal(relativeTime(NOW - 5 * 60_000, NOW), "há 5 min");
  assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), "há 3 h");
  assert.equal(relativeTime(NOW - 86_400_000, NOW), "há 1 dia");
  assert.equal(relativeTime(NOW - 45 * 86_400_000, NOW), "há 1 mês");
  // relógio do sistema atrasado não pode virar "há -3 dias"
  assert.equal(relativeTime(NOW + 86_400_000, NOW), "recentemente");
});

test("caminho longo é encurtado pelo começo, preservando o arquivo", () => {
  const longo = "/home/usuario/projetos/muito/fundo/na/arvore/meu-jogo.gridsmith.json";
  const curto = shortenPath(longo, 30);
  assert.ok(curto.length <= 30);
  assert.ok(curto.endsWith("meu-jogo.gridsmith.json"), "o nome do arquivo precisa sobreviver");
  assert.equal(shortenPath("/curto.json", 30), "/curto.json");
});
