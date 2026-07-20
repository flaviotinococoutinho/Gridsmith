/**
 * Escolha de template no fluxo "Novo projeto" (ALPHA-0.1, P0.2 — passo 2 da
 * jornada de aceite: "escolher Novo projeto de plataforma 2D").
 *
 * NÚCLEO PURO: aqui vive só a DECISÃO (quais opções oferecer e o que a
 * resposta significa). O diálogo nativo e a chamada canônica ficam no `main`,
 * que é cola do Electron. Assim o passo mais visível da jornada fica coberto
 * por teste sem precisar de Electron rodando.
 *
 * Regras de construção do prompt:
 *  - templates primeiro, na ordem em que o middleware os anuncia (a ordem é
 *    contrato do middleware, não decisão da UI);
 *  - "Projeto em branco" sempre existe — o usuário nunca fica preso ao template;
 *  - "Cancelar" é sempre o último botão e também o `cancelId` (fechar o
 *    diálogo pelo X ou Esc equivale a cancelar);
 *  - foco inicial no primeiro template (o caminho feliz da jornada).
 */

export interface ProjectTemplateOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** O que o usuário decidiu; `cancel` NUNCA cria nem substitui sessão. */
export type NewProjectChoice =
  | { readonly kind: "template"; readonly templateId: string }
  | { readonly kind: "blank" }
  | { readonly kind: "cancel" };

/** Descrição declarativa do diálogo; o `main` traduz para `showMessageBox`. */
export interface NewProjectPrompt {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: readonly string[];
  readonly defaultId: number;
  readonly cancelId: number;
}

export const BLANK_PROJECT_LABEL = "Projeto em branco";
export const CANCEL_LABEL = "Cancelar";

/**
 * Templates utilizáveis: id e rótulo não vazios. Um template sem identidade
 * não pode ser pedido ao middleware, então some da lista em vez de virar um
 * botão que falha ao ser clicado.
 */
export function usableTemplates(
  templates: readonly ProjectTemplateOption[],
): readonly ProjectTemplateOption[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    const id = template.id?.trim();
    const label = template.label?.trim();
    if (!id || !label || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * Monta o prompt de escolha. Sem template utilizável não há escolha a fazer:
 * retorna `undefined` e o chamador segue direto para o projeto em branco (o
 * comportamento anterior ao template — fail-safe se o middleware não anunciar
 * templates).
 */
export function buildNewProjectPrompt(
  templates: readonly ProjectTemplateOption[],
): NewProjectPrompt | undefined {
  const usable = usableTemplates(templates);
  if (usable.length === 0) return undefined;

  const buttons = [
    ...usable.map((template) => template.label.trim()),
    BLANK_PROJECT_LABEL,
    CANCEL_LABEL,
  ];

  const detail = usable
    .map((template) => {
      const description = template.description?.trim();
      return description ? `${template.label.trim()} — ${description}` : template.label.trim();
    })
    .join("\n");

  return {
    title: "Novo projeto",
    message: "Como você quer começar?",
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  };
}

/**
 * Traduz o índice do botão de volta para a decisão. Índice fora da faixa é
 * tratado como cancelamento: nenhuma resposta inesperada do diálogo pode
 * substituir a sessão de projeto ativa por acidente.
 */
export function resolveNewProjectChoice(
  templates: readonly ProjectTemplateOption[],
  response: number,
): NewProjectChoice {
  const usable = usableTemplates(templates);
  if (!Number.isInteger(response) || response < 0) return { kind: "cancel" };
  if (response < usable.length) {
    return { kind: "template", templateId: usable[response]!.id.trim() };
  }
  if (response === usable.length) return { kind: "blank" };
  return { kind: "cancel" };
}
