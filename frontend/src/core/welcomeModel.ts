/**
 * Tela inicial do editor (frente F8) — o NÚCLEO da decisão.
 *
 * Enquanto não há projeto aberto, o Gridsmith deve oferecer um ponto de partida em
 * vez de um canvas editável que não pertence a lugar nenhum: criar a partir de
 * um template, abrir um projeto, retomar um recente ou abrir o exemplo.
 *
 * Este módulo decide O QUE mostrar; o DOM apenas materializa (mesmo contrato
 * declarativo de `newProjectChoice.ts`). Puro: sem Electron, sem Node, sem
 * rede — o relógio entra por parâmetro para o "há 2 dias" ser determinístico
 * no teste.
 */

import type { ProjectState, RecentProject } from "./projectLifecycle.js";
import type { ProjectTemplateOption } from "./newProjectChoice.js";

export interface WelcomeAction {
  readonly id: "new" | "open" | "example";
  readonly label: string;
  readonly enabled: boolean;
  /** Por que está desabilitada; ausente quando habilitada. */
  readonly reason?: string;
}

export interface WelcomeTemplateCard {
  readonly templateId: string;
  readonly label: string;
  readonly description: string;
}

export interface WelcomeRecent {
  readonly filePath: string;
  readonly name: string;
  /** Linha secundária pronta: "há 2 dias · /caminho/encurtado". */
  readonly secondary: string;
}

export interface WelcomeView {
  readonly visible: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly actions: readonly WelcomeAction[];
  readonly templates: readonly WelcomeTemplateCard[];
  readonly recents: readonly WelcomeRecent[];
  /** Dica exibida quando não há recentes; vazia quando há. */
  readonly emptyHint: string;
}

export interface WelcomeInput {
  readonly projectState: ProjectState;
  readonly recents: readonly RecentProject[];
  readonly templates: readonly ProjectTemplateOption[];
  /** Conexão com o middleware; sem ela criar/abrir projeto falharia. */
  readonly connected: boolean;
  readonly exampleAvailable?: boolean;
  readonly now: () => number;
}

const DAY_MS = 86_400_000;
const OFFLINE_REASON = "Aguardando os serviços do Gridsmith ficarem prontos.";

/** "há 2 dias", "há 3 horas", "agora há pouco" — sem dependência de i18n. */
export function relativeTime(fromUnixMs: number, nowUnixMs: number): string {
  const delta = nowUnixMs - fromUnixMs;
  if (!Number.isFinite(delta) || delta < 0) return "recentemente";
  if (delta < 60_000) return "agora há pouco";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(delta / DAY_MS);
  if (days === 1) return "há 1 dia";
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  return months === 1 ? "há 1 mês" : `há ${months} meses`;
}

/**
 * Encurta o caminho preservando o fim, que é a parte que identifica: o começo
 * some, não o nome do arquivo.
 */
export function shortenPath(filePath: string, maxLength = 48): string {
  if (filePath.length <= maxLength) return filePath;
  return `…${filePath.slice(filePath.length - maxLength + 1)}`;
}

/** Descarta template sem id/rótulo utilizável (mesma disciplina do diálogo). */
function usableTemplates(templates: readonly ProjectTemplateOption[]): WelcomeTemplateCard[] {
  const seen = new Set<string>();
  const cards: WelcomeTemplateCard[] = [];
  for (const template of templates) {
    if (typeof template?.id !== "string" || template.id.length === 0) continue;
    if (typeof template.label !== "string" || template.label.length === 0) continue;
    if (seen.has(template.id)) continue;
    seen.add(template.id);
    cards.push({
      templateId: template.id,
      label: template.label,
      description: typeof template.description === "string" ? template.description : "",
    });
  }
  return cards;
}

/**
 * Descreve a tela inicial. Visível SOMENTE sem projeto aberto — com projeto, o
 * workbench é a tela, e devolver `visible: false` deixa a decisão de esconder
 * fora do DOM.
 */
export function describeWelcome(input: WelcomeInput): WelcomeView {
  const visible = input.projectState === "no-project";
  const nowMs = input.now();
  const templates = usableTemplates(input.templates);
  const offline = !input.connected;

  const actions: WelcomeAction[] = [
    {
      id: "new",
      label: "Novo projeto",
      enabled: !offline,
      ...(offline ? { reason: OFFLINE_REASON } : {}),
    },
    {
      id: "open",
      label: "Abrir projeto…",
      enabled: !offline,
      ...(offline ? { reason: OFFLINE_REASON } : {}),
    },
  ];
  if (input.exampleAvailable) {
    actions.push({
      id: "example",
      label: "Abrir exemplo",
      enabled: !offline,
      ...(offline ? { reason: OFFLINE_REASON } : {}),
    });
  }

  const recents = input.recents.map((recent) => ({
    filePath: recent.filePath,
    name: recent.name,
    secondary: `${relativeTime(recent.lastOpenedUnixMs, nowMs)} · ${shortenPath(recent.filePath)}`,
  }));

  return {
    visible,
    title: "Bem-vindo ao Gridsmith",
    subtitle: offline
      ? "Iniciando os serviços do Gridsmith…"
      : "Crie um projeto a partir de um template, abra um existente ou retome um recente.",
    actions,
    templates,
    recents,
    emptyHint: recents.length === 0 ? "Nenhum projeto recente por aqui ainda." : "",
  };
}
