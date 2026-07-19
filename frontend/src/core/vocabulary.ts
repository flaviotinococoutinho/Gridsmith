/**
 * Vocabulário humano da interface (ALPHA-0.1 P0.3).
 *
 * IDs internos (`lighting-pipeline`, `preview.embedded`, `lightAdded`) NUNCA
 * aparecem na UI: todo identificador passa por aqui e sai como rótulo pt-BR.
 * Identificador sem tradução ganha um fallback legível — e o teste de
 * cobertura garante que os catálogos conhecidos estão 100% traduzidos.
 */

/** Recursos governados (tooltips e diagnósticos). */
export const FEATURE_LABELS: Readonly<Record<string, string>> = {
  "level.intgrid-editor": "Edição de níveis (IntGrid)",
  "lighting.deferred-pipeline": "Pipeline de iluminação",
  "shaders.hlsl-editing": "Edição de shaders HLSL",
  "assets.mgcb-compile": "Compilação de assets (MGCB)",
  "preview.embedded": "Pré-visualização embutida",
  "editor.preview-host.connected": "PreviewHost conectado",
  "debug.overlay": "Sobreposição de depuração",
  "editor.tool.camera": "Ferramenta de câmera",
  "editor.tool.light": "Ferramenta de luz",
  "editor.tool.spawn": "Ferramenta de spawn",
  "editor.tool.trigger": "Ferramenta de trigger",
};

/** Eventos do Blueprint (log de saída e histórico). */
export const EVENT_LABELS: Readonly<Record<string, string>> = {
  skeletonDefined: "Esqueleto definido",
  meshBound: "Malha vinculada",
  cameraConfigured: "Câmera configurada",
  lightAdded: "Luz adicionada",
  lightUpdated: "Luz alterada",
  lightRemoved: "Luz removida",
  entityDefDefined: "Definição de entidade criada",
  entityDefUpdated: "Definição de entidade alterada",
  entityDefRemoved: "Definição de entidade removida",
  entityPlaced: "Entidade posicionada",
  entityMoved: "Entidade movida",
  entityPropertiesChanged: "Propriedades da entidade alteradas",
  entityRemoved: "Entidade removida",
  levelDefined: "Nível definido",
  levelUpdated: "Nível atualizado",
  levelPatched: "Nível editado",
  levelPaletteChanged: "Paleta do nível alterada",
  levelRemoved: "Nível removido",
  worldLevelPlaced: "Nível posicionado no mapa-múndi",
  worldLevelUnplaced: "Nível removido do mapa-múndi",
};

export const HISTORY_ACTOR_LABELS = {
  human: "Pessoa",
  agent: "Agente",
  pipeline: "Pipeline",
} as const;

export const HISTORY_ACTION_LABELS = {
  apply: "Edição",
  undo: "Desfeito",
  redo: "Refeito",
} as const;

/** Status de projeção no runtime. */
export const PROJECTION_LABELS: Readonly<Record<string, string>> = {
  projected: "Aplicado no runtime",
  skipped: "Não aplicado (sem suporte)",
  deferred: "Pendente (runtime desconectado)",
};

/** Estados do ciclo de vida do projeto (status bar). */
export const PROJECT_STATE_LABELS: Readonly<Record<string, string>> = {
  "no-project": "Nenhum projeto aberto",
  opening: "Abrindo projeto…",
  "open-clean": "Projeto salvo",
  "open-dirty": "Alterações não salvas",
  saving: "Salvando…",
  closing: "Fechando…",
};

/** Estados dos serviços supervisionados. */
export const SERVICE_STATE_LABELS: Readonly<Record<string, string>> = {
  stopped: "Parado",
  starting: "Iniciando…",
  running: "Em execução",
  retrying: "Reconectando…",
  failed: "Falhou",
};

/** Fallback legível: "preview.embedded" → "Preview embedded". */
export function humanize(id: string): string {
  const words = id.replace(/[._/-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const lookup =
  (table: Readonly<Record<string, string>>) =>
  (id: string): string =>
    table[id] ?? humanize(id);

export const featureLabel = lookup(FEATURE_LABELS);
export const eventLabel = lookup(EVENT_LABELS);
export const projectionLabel = lookup(PROJECTION_LABELS);
export const projectStateLabel = lookup(PROJECT_STATE_LABELS);
export const serviceStateLabel = lookup(SERVICE_STATE_LABELS);
