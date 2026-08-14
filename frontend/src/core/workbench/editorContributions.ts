/**
 * Contribuições concretas do editor Gridsmith (E10).
 *
 * Separadas do framework de propósito: `panelRegistry`/`commandRegistry`/…
 * não conhecem pincel nem entidade, e este módulo não conhece a mecânica de
 * registro. É a fronteira que permite um domínio novo (tilemap, timeline,
 * shader) entrar só acrescentando dados aqui.
 *
 * Módulo puro (regra F1).
 */

import type { InspectorSection } from "./inspectorRegistry.js";
import type { ToolContribution } from "./toolRegistry.js";

/** Painel do editor de níveis — o único com vista real hoje. */
export const LEVEL_EDITOR_PANEL = "level-editor";

/**
 * Ferramentas do editor de níveis. Eram sete botões criados à mão na vista,
 * com a governança de `entities.spawn` aplicada uma única vez na montagem.
 * Como contribuição, a habilitação volta a ser resolvida a cada render.
 */
export function levelEditorTools(): ToolContribution[] {
  const tool = (
    id: string,
    label: string,
    hint: string,
    keybinding: string,
    requires: readonly string[] = [],
  ): ToolContribution => ({
    id,
    label,
    hint,
    keybinding,
    requires,
    requiresProject: true,
    panelId: LEVEL_EDITOR_PANEL,
    order: 0,
  });

  return [
    tool("pencil", "Pincel", "Pintar célula (arraste)", "b"),
    tool("eraser", "Borracha", "Apagar célula (arraste)", "e"),
    tool("flood", "Balde", "Preencher região conectada", "g"),
    tool("rect", "Retângulo", "Arraste para preencher a área", "r"),
    tool("line", "Linha", "Arraste para traçar uma linha", "l"),
    tool("picker", "Conta-gotas", "Clique para pegar o significado da célula", "i"),
    // a única ferramenta governada: posicionar entidade depende do perfil
    tool("entity", "Jogador", "Clique posiciona, arraste move, Delete remove", "p", [
      "entities.spawn",
    ]),
  ].map((contribution, index) => ({ ...contribution, order: index }));
}

/**
 * Seções do inspector. O inspector não existia — a frente F4 inteira estava
 * vazia —, então estas são as primeiras: identidade e transformação do que o
 * editor já sabe selecionar.
 *
 * Seção governada aparece em somente-leitura COM a razão, nunca some: um campo
 * ausente faz o usuário concluir que o objeto não tem aquela propriedade.
 */
export function defaultInspectorSections(): InspectorSection[] {
  return [
    {
      id: "entity.identity",
      label: "Entidade",
      appliesTo: ["entity"],
      multiple: true,
      requires: [],
      requiresProject: true,
      order: 0,
    },
    {
      id: "entity.transform",
      label: "Posição no mundo",
      appliesTo: ["entity"],
      // posição de N entidades exigiria edição relativa; enquanto não existe,
      // a seção some em vez de mostrar a da primeira como se fosse a de todas
      multiple: false,
      requires: ["entities.spawn"],
      requiresProject: true,
      order: 1,
    },
    {
      id: "level.identity",
      label: "Nível",
      appliesTo: ["level"],
      multiple: false,
      requires: ["level.intgrid-editor"],
      requiresProject: true,
      order: 2,
    },
    {
      id: "light.properties",
      label: "Luz",
      appliesTo: ["light"],
      multiple: false,
      requires: ["lighting.deferred-pipeline"],
      requiresProject: true,
      order: 3,
    },
  ];
}
