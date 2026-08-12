/**
 * Casca do workbench por contribuições (E10).
 *
 * O que estes testes travam é a propriedade que a casca antiga não tinha:
 * cada capacidade tem UM dono declarado, e a razão de um "desabilitado" nunca
 * perde a origem no caminho até o usuário.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PANEL_REQUIREMENTS, type ResolvedExperienceLike } from "../src/core/experienceGate.js";
import { CapabilityRegistry } from "../src/core/workbench/capabilityRegistry.js";
import {
  CommandDisabledError,
  CommandRegistry,
  KeybindingConflictError,
  UnknownCommandError,
} from "../src/core/workbench/commandRegistry.js";
import { ContributionConflictError } from "../src/core/workbench/contributions.js";
import {
  defaultInspectorSections,
  levelEditorTools,
} from "../src/core/workbench/editorContributions.js";
import { InspectorRegistry } from "../src/core/workbench/inspectorRegistry.js";
import {
  chordFromStroke,
  chordKey,
  formatChord,
  InvalidChordError,
  parseChord,
} from "../src/core/workbench/keybindings.js";
import { createPanelRegistry, defaultPanels } from "../src/core/workbench/panelRegistry.js";
import { SelectionService } from "../src/core/workbench/selectionService.js";
import { ToolRegistry } from "../src/core/workbench/toolRegistry.js";
import { WorkbenchLayout, clampArea } from "../src/core/workbench/workbenchLayout.js";
import { WorkbenchModel } from "../src/core/workbench/workbenchShell.js";
import { panelLabel } from "../src/core/vocabulary.js";

const EXPERIENCE: ResolvedExperienceLike = {
  family: "monogame",
  profileVersion: "3.8.2",
  displayName: "MonoGame 3.8.2 (DesktopGL)",
  constraints: {},
  decisions: [
    { feature: "level.intgrid-editor", enabled: true, source: "live-manifest", reason: "ok" },
    { feature: "lighting.deferred-pipeline", enabled: true, source: "live-manifest", reason: "ok" },
    { feature: "shaders.hlsl-editing", enabled: true, source: "profile-rule", reason: "ok" },
    { feature: "assets.mgcb-compile", enabled: true, source: "profile-rule", reason: "ok" },
    { feature: "preview.embedded", enabled: false, source: "profile-rule", reason: "chega no 3.8.2" },
    { feature: "debug.overlay", enabled: false, source: "live-manifest", reason: "sem engine" },
    { feature: "entities.spawn", enabled: true, source: "live-manifest", reason: "ok" },
  ],
};

function resolvido(): CapabilityRegistry {
  const capabilities = new CapabilityRegistry();
  capabilities.applyExperience(EXPERIENCE);
  capabilities.applyProjectState("open-clean");
  return capabilities;
}

// ------------------------------------------------------------- capacidades

test("a origem da razão sobrevive: governança nega com a razão do perfil, sessão com a dela", () => {
  const capabilities = new CapabilityRegistry();
  capabilities.applyExperience(EXPERIENCE);

  // sem projeto: quem a governança JÁ negava mantém a razão do perfil
  const negadoPeloPerfil = capabilities.resolve({
    requires: ["preview.embedded"],
    requiresProject: true,
  });
  assert.equal(negadoPeloPerfil.enabled, false);
  assert.equal(negadoPeloPerfil.reason, "chega no 3.8.2");
  assert.equal(negadoPeloPerfil.origin, "governance");

  // e quem a governança permite recebe a razão do eixo de sessão
  const semProjeto = capabilities.resolve({
    requires: ["level.intgrid-editor"],
    requiresProject: true,
  });
  assert.equal(semProjeto.enabled, false);
  assert.equal(semProjeto.origin, "session");
  assert.match(semProjeto.reason, /projeto/i);
});

test("antes da primeira resolução tudo que depende da governança é fail-safe", () => {
  const capabilities = new CapabilityRegistry();
  const answer = capabilities.resolve({ requires: ["level.intgrid-editor"], requiresProject: true });
  assert.equal(answer.enabled, false);
  assert.equal(answer.origin, "fail-safe");
  assert.match(answer.reason, /Aguardando conexão/);
});

test("ação que não pede nada à governança funciona OFFLINE", () => {
  // esconder o inspector não pode depender do middleware: prenderia o usuário
  // numa janela que ele nem consegue reorganizar enquanto a conexão não vem
  const capabilities = new CapabilityRegistry();
  const answer = capabilities.resolve({ requires: [], requiresProject: false });
  assert.equal(answer.enabled, true);
});

// ------------------------------------------------------------------ painéis

test("todo painel contribuído é governado e tem rótulo humano; nenhum requisito fica sem painel", () => {
  const painéis = defaultPanels();
  const contribuídos = new Set(painéis.map((p) => p.id));

  for (const panel of painéis) {
    assert.ok(panel.requires.length > 0, `painel "${panel.id}" habilitaria fora da governança`);
    assert.equal(panel.requiresProject, true, `painel "${panel.id}" editaria sem projeto`);
    assert.equal(panel.label, panelLabel(panel.id));
    assert.notEqual(panel.label, panel.id, "rótulo não pode ser o ID cru");
  }
  for (const requisito of Object.keys(PANEL_REQUIREMENTS)) {
    assert.ok(contribuídos.has(requisito), `recurso governado "${requisito}" sem painel que o ofereça`);
  }
});

test("contribuir o mesmo id duas vezes é ERRO, não 'o último vence'", () => {
  const registry = createPanelRegistry();
  assert.throws(
    () => registry.registerAll(defaultPanels()),
    ContributionConflictError,
    "um painel que some sem aviso é exatamente o bug que o registro elimina",
  );
});

test("o rail sai ordenado, e painel desabilitado nunca sai como ativo", () => {
  const registry = createPanelRegistry();
  const capabilities = resolvido();
  const rail = registry.navigation(capabilities, "embedded-preview");

  assert.deepEqual(
    rail.map((item) => item.panelId),
    Object.keys(PANEL_REQUIREMENTS),
  );
  const preview = rail.find((item) => item.panelId === "embedded-preview")!;
  assert.equal(preview.enabled, false);
  assert.equal(preview.active, false, "foco em painel desabilitado seria uma tela morta");
  assert.equal(registry.firstEnabled(capabilities), "level-editor");
});

// ------------------------------------------------------------ atalhos

test("acordes normalizam: Ctrl e Cmd são o MESMO atalho", () => {
  // separá-los faria o atalho existir só numa plataforma
  assert.equal(chordKey(parseChord("Ctrl+Z")), chordKey(parseChord("Cmd+z")));
  assert.equal(chordKey(parseChord("Mod+Shift+Z")), chordKey(parseChord("ctrl+shift+z")));
  assert.equal(
    chordKey(parseChord("Ctrl+Z")),
    chordKey(chordFromStroke({ key: "Z", metaKey: true })),
  );
  assert.notEqual(chordKey(parseChord("Ctrl+Z")), chordKey(parseChord("Ctrl+Shift+Z")));
  assert.equal(formatChord(parseChord("ctrl+shift+z")), "Ctrl+Shift+Z");
  assert.equal(formatChord(parseChord("Ctrl+Z"), true), "⌘+Z");
  assert.equal(formatChord(parseChord("Delete")), "Delete");
});

test("modificador desconhecido e acorde sem tecla são recusados no registro", () => {
  // falhar no register é o ponto: um atalho escrito errado que fosse ignorado
  // em silêncio viraria um comando inalcançável
  assert.throws(() => parseChord("Crtl+Z"), InvalidChordError);
  assert.throws(() => parseChord("Ctrl+Shift"), InvalidChordError);
  assert.throws(() => parseChord(""), InvalidChordError);
});

// ------------------------------------------------------------- comandos

function comando(id: string, keybindings: string[], run = (): void => {}) {
  return {
    id,
    label: id,
    category: "Editar",
    requires: [],
    requiresProject: false,
    order: 0,
    keybindings,
    run,
  };
}

test("um acorde tem UM dono: o segundo pretendente ao Ctrl+Z é recusado", () => {
  const registry = new CommandRegistry();
  registry.register(comando("a.undo", ["Ctrl+Z"]));
  assert.throws(() => registry.register(comando("b.undo", ["Ctrl+Z"])), KeybindingConflictError);
  // e o recusado não fica meio-registrado
  assert.equal(registry.get("b.undo"), undefined);
  assert.equal(registry.commandForStroke({ key: "z", ctrlKey: true })?.id, "a.undo");
});

test("devolver o comando LIBERA o acorde — remontar o painel volta a funcionar", () => {
  const registry = new CommandRegistry();
  registry.register(comando("level.undoDraft", ["Ctrl+Z"]));
  registry.unregister("level.undoDraft");
  assert.equal(registry.commandForStroke({ key: "z", ctrlKey: true }), undefined);
  registry.register(comando("level.undoDraft", ["Ctrl+Z"]));
  assert.equal(registry.commandForStroke({ key: "z", ctrlKey: true })?.id, "level.undoDraft");
});

test("comando desabilitado ERRA com a razão da governança, em vez de virar no-op", async () => {
  const registry = new CommandRegistry();
  const capabilities = new CapabilityRegistry();
  capabilities.applyExperience(EXPERIENCE);
  let executado = false;
  registry.register({
    ...comando("preview.start", []),
    requires: ["preview.embedded"],
    requiresProject: true,
    run: () => {
      executado = true;
    },
  });

  await assert.rejects(
    () => registry.execute("preview.start", capabilities),
    (error: unknown) => error instanceof CommandDisabledError && error.reason === "chega no 3.8.2",
  );
  assert.equal(executado, false);
  await assert.rejects(() => registry.execute("nao.existe", capabilities), UnknownCommandError);
});

test("o comando resolvido carrega o atalho para a UI, e a razão quando negado", () => {
  const registry = new CommandRegistry();
  const capabilities = resolvido();
  registry.register(comando("edit.redo", ["Ctrl+Shift+Z", "Ctrl+Y"]));
  const resolved = registry.resolve("edit.redo", capabilities)!;
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.shortcut, "Ctrl+Shift+Z", "o primeiro acorde é o rótulo");
  // o segundo continua disparando
  assert.equal(registry.commandForStroke({ key: "y", ctrlKey: true })?.id, "edit.redo");
});

// --------------------------------------------------------- ferramentas

test("a ferramenta ativa cai para uma habilitada quando a governança muda", () => {
  const tools = new ToolRegistry();
  tools.registerAll(levelEditorTools());
  const capabilities = resolvido();

  assert.equal(tools.activate("level-editor", "entity", capabilities), true);
  assert.equal(tools.activeTool("level-editor", capabilities)?.id, "entity");

  // o perfil tirou o spawn com o painel aberto
  capabilities.applyExperience({
    ...EXPERIENCE,
    decisions: EXPERIENCE.decisions.map((d) =>
      d.feature === "entities.spawn" ? { ...d, enabled: false, reason: "sem spawn table" } : d,
    ),
  });
  assert.equal(
    tools.activeTool("level-editor", capabilities)?.id,
    "pencil",
    "apontar para uma ferramenta que o próximo clique recusaria seria mentir",
  );
  assert.equal(tools.activate("level-editor", "entity", capabilities), false);
});

test("ferramenta de outro painel não ativa, e a tecla compara o ACORDE inteiro", () => {
  const tools = new ToolRegistry();
  tools.registerAll(levelEditorTools());
  const capabilities = resolvido();

  assert.equal(tools.activate("shader-editor", "pencil", capabilities), false);
  assert.equal(tools.toolForStroke("level-editor", { key: "b" }, capabilities)?.id, "pencil");
  assert.equal(
    tools.toolForStroke("level-editor", { key: "b", ctrlKey: true }, capabilities),
    undefined,
    "Ctrl+B não é o pincel",
  );
});

// ------------------------------------------------------------- seleção

test("a seleção é fonte única: substitui, alterna, deduplica e some quando vazia", () => {
  const selection = new SelectionService();
  let avisos = 0;
  selection.onChange(() => avisos++);

  selection.select("entity", ["a", "b", "a"], "level-editor");
  assert.deepEqual(selection.current?.ids, ["a", "b"]);
  assert.equal(selection.primary, "a");

  selection.select("entity", ["a", "b"], "level-editor");
  assert.equal(avisos, 1, "seleção idêntica não notifica à toa");

  selection.toggle("entity", "b");
  assert.deepEqual(selection.current?.ids, ["a"]);
  selection.toggle("entity", "a");
  assert.equal(selection.isEmpty, true, "seleção de zero itens não existe");
});

test("trocar de tipo SUBSTITUI: seleção heterogênea não tem inspector que a represente", () => {
  const selection = new SelectionService();
  selection.select("entity", ["e1", "e2"]);
  selection.toggle("light", "sol");
  assert.equal(selection.current?.kind, "light");
  assert.deepEqual(selection.current?.ids, ["sol"]);
});

test("retain remove o que deixou de existir — o inspector não mostra objeto morto", () => {
  const selection = new SelectionService();
  selection.select("entity", ["vivo", "apagado"]);
  selection.retain((id) => id === "vivo");
  assert.deepEqual(selection.current?.ids, ["vivo"]);
  selection.retain(() => false);
  assert.equal(selection.isEmpty, true);
});

// ----------------------------------------------------------- inspector

test("as seções seguem o tipo e a multiplicidade da seleção", () => {
  const inspector = new InspectorRegistry();
  inspector.registerAll(defaultInspectorSections());
  const capabilities = resolvido();

  const uma = inspector.sectionsFor({ kind: "entity", ids: ["e1"] }, capabilities);
  assert.deepEqual(
    uma.map((s) => s.section.id),
    ["entity.identity", "entity.transform"],
  );

  const várias = inspector.sectionsFor({ kind: "entity", ids: ["e1", "e2"] }, capabilities);
  assert.deepEqual(
    várias.map((s) => s.section.id),
    ["entity.identity"],
    "mostrar a posição da primeira como se fosse a de todas seria falso",
  );

  assert.deepEqual(inspector.sectionsFor(undefined, capabilities), []);
});

test("seção negada pela governança CONTINUA visível, em somente-leitura com a razão", () => {
  const inspector = new InspectorRegistry();
  inspector.registerAll(defaultInspectorSections());
  const capabilities = new CapabilityRegistry();
  capabilities.applyProjectState("open-clean");
  capabilities.applyExperience({
    ...EXPERIENCE,
    decisions: EXPERIENCE.decisions.map((d) =>
      d.feature === "entities.spawn" ? { ...d, enabled: false, reason: "sem spawn table" } : d,
    ),
  });

  const seções = inspector.sectionsFor({ kind: "entity", ids: ["e1"] }, capabilities);
  const transform = seções.find((s) => s.section.id === "entity.transform")!;
  assert.equal(transform.enabled, false);
  assert.equal(
    transform.reason,
    "sem spawn table",
    "esconder o campo faria o usuário concluir que a entidade não tem posição",
  );
});

// -------------------------------------------------------------- layout

test("o tamanho é clampado, e valor absurdo cai no default em vez de sumir com a área", () => {
  assert.equal(clampArea("rail", 5), 140);
  assert.equal(clampArea("rail", 10_000), 420);
  assert.equal(clampArea("inspector", Number.NaN), 300);
});

test("layout sobrevive ao round-trip; versão diferente e lixo voltam ao default", () => {
  const layout = new WorkbenchLayout();
  layout.resize("inspector", 380);
  layout.setVisible("bottom", false);
  const salvo = JSON.parse(JSON.stringify(layout.serialize())) as unknown;

  const restaurado = new WorkbenchLayout();
  assert.equal(restaurado.restore(salvo), true);
  assert.equal(restaurado.get("inspector").size, 380);
  assert.equal(restaurado.get("bottom").visible, false);
  assert.equal(restaurado.effectiveSize("bottom"), 0, "área escondida ocupa zero");

  // layout é conforto, não dado do projeto: nada disto pode lançar
  const intacto = new WorkbenchLayout();
  assert.equal(intacto.restore({ version: 99, areas: {} }), false);
  assert.equal(intacto.restore("não é json"), false);
  assert.equal(intacto.restore(null), false);
  assert.equal(intacto.get("inspector").size, 300);

  // valor fora dos limites vindo de um arquivo editado à mão
  const clampado = new WorkbenchLayout();
  clampado.restore({ version: 1, areas: { rail: { size: -50, visible: true } } });
  assert.equal(clampado.get("rail").size, 140);
});

// --------------------------------------------------------------- casca

test("comando global tem precedência sobre a ferramenta do painel", () => {
  const model = new WorkbenchModel();
  model.applyExperience(EXPERIENCE);
  model.applyProjectState("open-clean");
  model.tools.registerAll(levelEditorTools());
  model.commands.register(comando("global.b", ["b"]));

  // "b" é o pincel E um comando global: um atalho global que dependesse do
  // painel ativo seria imprevisível para o usuário
  assert.deepEqual(model.resolveKeyStroke({ key: "b" }), { kind: "command", commandId: "global.b" });
  assert.deepEqual(model.resolveKeyStroke({ key: "e" }), { kind: "tool", toolId: "eraser" });
  assert.deepEqual(model.resolveKeyStroke({ key: "F9" }), { kind: "ignored" });
});

test("trocar de painel limpa a seleção e avisa a casca UMA vez", () => {
  const model = new WorkbenchModel();
  model.applyExperience(EXPERIENCE);
  model.applyProjectState("open-clean");
  model.selection.select("entity", ["e1"], "level-editor");

  let avisos = 0;
  model.onChange(() => avisos++);
  assert.equal(model.activatePanel("lighting-pipeline"), true);

  assert.equal(model.selection.isEmpty, true, "a seleção pertence ao painel que a criou");
  assert.equal(avisos, 1, "duas notificações remontariam a vista no meio da troca");
});

test("os comandos da casca funcionam offline e mexem no layout de verdade", async () => {
  const model = new WorkbenchModel();
  model.registerViewCommands();
  // sem experiência nenhuma: é justamente o cenário em que o usuário precisa
  // conseguir reorganizar a janela
  assert.equal(model.resolveCommand("view.toggleInspector")?.enabled, true);
  await model.executeCommand("view.toggleInspector");
  assert.equal(model.layout.get("inspector").visible, false);
  await model.executeCommand("view.resetLayout");
  assert.equal(model.layout.get("inspector").visible, true);
});
