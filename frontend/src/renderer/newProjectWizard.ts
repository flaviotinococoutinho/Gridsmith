import { ProjectWizardModel } from "../core/projectWizardModel.js";
import type {
  CreateProjectFromTemplateRequest,
  ProjectTemplateDescriptor,
} from "../core/projectApi.js";
import { MAX_PROJECT_TILE_SIZE } from "../core/projectApi.js";

export function showNewProjectWizard(
  templates: readonly ProjectTemplateDescriptor[],
): Promise<CreateProjectFromTemplateRequest | undefined> {
  const model = new ProjectWizardModel(templates);
  const dialog = document.createElement("dialog");
  dialog.className = "project-wizard";
  dialog.setAttribute("aria-labelledby", "new-project-title");

  const title = document.createElement("h2");
  title.id = "new-project-title";
  title.textContent = "Novo projeto";
  const intro = document.createElement("p");
  intro.textContent = "Escolha um ponto de partida. O P7M criará o arquivo antes de abrir a sessão.";

  const templateGrid = document.createElement("div");
  templateGrid.className = "template-grid";
  const cards = new Map<string, HTMLButtonElement>();

  const fields = document.createElement("div");
  fields.className = "wizard-fields";
  const name = inputField(fields, "Nome", "text", model.name);
  const width = inputField(fields, "Largura de referência", "number", String(model.referenceWidth));
  const height = inputField(fields, "Altura de referência", "number", String(model.referenceHeight));
  const tile = inputField(fields, "Tile size", "number", String(model.tileSize));
  width.min = height.min = tile.min = "1";
  tile.max = String(MAX_PROJECT_TILE_SIZE);

  const renderSelection = (): void => {
    for (const [id, card] of cards) {
      card.setAttribute("aria-pressed", String(id === model.selectedTemplate?.id));
    }
    width.value = String(model.referenceWidth);
    height.value = String(model.referenceHeight);
    tile.value = String(model.tileSize);
  };

  for (const template of templates) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "template-card";
    const preview = templatePreview(template);
    const label = document.createElement("strong");
    label.textContent = template.label;
    const description = document.createElement("span");
    description.textContent = template.description;
    card.append(preview, label, description);
    card.addEventListener("click", () => {
      model.selectTemplate(template.id);
      renderSelection();
    });
    cards.set(template.id, card);
    templateGrid.append(card);
  }

  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Ao continuar, escolha a pasta onde o arquivo .p7m.json será criado.";
  const error = document.createElement("p");
  error.className = "wizard-error";
  error.setAttribute("role", "alert");
  const actions = document.createElement("div");
  actions.className = "wizard-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancelar";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "primary";
  create.textContent = "Escolher pasta e criar";
  actions.append(cancel, create);
  dialog.append(title, intro, templateGrid, fields, note, error, actions);
  document.body.append(dialog);
  renderSelection();

  return new Promise((resolve) => {
    const finish = (value: CreateProjectFromTemplateRequest | undefined): void => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(undefined));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(undefined);
    });
    create.addEventListener("click", () => {
      model.update({
        name: name.value,
        width: Number(width.value),
        height: Number(height.value),
        tileSize: Number(tile.value),
      });
      try {
        finish(model.buildRequest());
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : String(cause);
      }
    });
    dialog.showModal();
  });
}

function inputField(
  host: HTMLElement,
  labelText: string,
  type: "text" | "number",
  value: string,
): HTMLInputElement {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.value = value;
  label.append(caption, input);
  host.append(label);
  return input;
}

function templatePreview(template: ProjectTemplateDescriptor): HTMLElement {
  const preview = document.createElement("span");
  preview.className = "template-preview";
  preview.style.setProperty("--template-accent", template.preview.accent);
  preview.setAttribute(
    "aria-label",
    `Prévia ${template.preview.widthCells} por ${template.preview.heightCells} células`,
  );
  const ground = document.createElement("span");
  ground.className = "preview-ground";
  const player = document.createElement("span");
  player.className = "preview-player";
  player.style.left = `${(template.preview.playerCell[0] / template.preview.widthCells) * 100}%`;
  preview.append(ground, player);
  return preview;
}
