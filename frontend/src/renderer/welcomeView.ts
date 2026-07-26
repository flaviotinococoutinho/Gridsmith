/**
 * Tela inicial (frente F8) — DOM apenas.
 *
 * A decisão do que mostrar vive em `core/welcomeModel.ts` (puro e testado);
 * aqui só há materialização, no mesmo contrato de contexto explícito de
 * `mountLevelEditor`: recebe o host e registra sua limpeza, sem estado de
 * módulo compartilhado.
 *
 * Restrição real do arquivo: a CSP do `index.html` é `default-src 'self'`, sem
 * recurso remoto; e nenhum id interno chega ao usuário — todo texto vem do
 * descritor, que já sai em pt-BR.
 */

import type { WelcomeView } from "../core/welcomeModel.js";

export interface WelcomeContext {
  readonly host: HTMLElement;
  readonly setCleanup: (cleanup: () => void) => void;
  readonly view: WelcomeView;
  readonly onNew: (templateId?: string) => void;
  readonly onOpen: () => void;
  readonly onOpenPath: (filePath: string) => void;
  readonly onOpenExample: () => void;
}

export function mountWelcome(ctx: WelcomeContext): void {
  const { host, view } = ctx;
  const root = document.createElement("div");
  root.className = "welcome-view";

  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = view.title;
  const subtitle = document.createElement("p");
  subtitle.className = "muted";
  subtitle.textContent = view.subtitle;
  header.append(title, subtitle);

  // ---- ações principais
  const actions = document.createElement("div");
  actions.className = "welcome-actions";
  for (const action of view.actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.disabled = !action.enabled;
    // painel desabilitado sempre carrega a razão — nunca um "indisponível" seco
    if (action.reason) button.title = action.reason;
    button.addEventListener("click", () => {
      if (action.id === "new") ctx.onNew();
      else if (action.id === "open") ctx.onOpen();
      else ctx.onOpenExample();
    });
    actions.append(button);
  }

  const columns = document.createElement("div");
  columns.className = "welcome-columns";

  // ---- cards de template
  const templatesColumn = document.createElement("section");
  templatesColumn.className = "welcome-templates";
  const templatesTitle = document.createElement("h3");
  templatesTitle.textContent = "Começar de um template";
  templatesColumn.append(templatesTitle);
  for (const template of view.templates) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "template-card";
    const name = document.createElement("strong");
    name.textContent = template.label;
    const description = document.createElement("span");
    description.className = "muted";
    description.textContent = template.description;
    card.append(name, description);
    card.addEventListener("click", () => ctx.onNew(template.templateId));
    templatesColumn.append(card);
  }

  // ---- recentes
  const recentsColumn = document.createElement("section");
  recentsColumn.className = "welcome-recents";
  const recentsTitle = document.createElement("h3");
  recentsTitle.textContent = "Projetos recentes";
  recentsColumn.append(recentsTitle);
  if (view.recents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = view.emptyHint;
    recentsColumn.append(empty);
  }
  for (const recent of view.recents) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "recent-item";
    item.title = recent.filePath;
    const name = document.createElement("strong");
    name.textContent = recent.name;
    const secondary = document.createElement("span");
    secondary.className = "muted";
    secondary.textContent = recent.secondary;
    item.append(name, secondary);
    item.addEventListener("click", () => ctx.onOpenPath(recent.filePath));
    recentsColumn.append(item);
  }

  columns.append(templatesColumn, recentsColumn);
  root.append(header, actions, columns);
  host.append(root);

  ctx.setCleanup(() => root.remove());
}
