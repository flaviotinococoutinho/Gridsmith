import type {
  CreateProjectFromTemplateRequest,
  ProjectTemplateDescriptor,
} from "./projectApi.js";
import { MAX_PROJECT_TILE_SIZE } from "./projectApi.js";

export class ProjectWizardModel {
  private selected: ProjectTemplateDescriptor | undefined;
  private projectName = "Meu jogo";
  private width = 1280;
  private height = 720;
  private tile = 16;

  constructor(readonly templates: readonly ProjectTemplateDescriptor[]) {
    const platformer = templates.find((template) => template.id === "platformer-2d");
    this.selectTemplate((platformer ?? templates[0])?.id);
  }

  get selectedTemplate(): ProjectTemplateDescriptor | undefined {
    return this.selected;
  }

  get name(): string {
    return this.projectName;
  }

  get referenceWidth(): number {
    return this.width;
  }

  get referenceHeight(): number {
    return this.height;
  }

  get tileSize(): number {
    return this.tile;
  }

  selectTemplate(templateId: string | undefined): void {
    const next = this.templates.find((template) => template.id === templateId);
    if (!next) return;
    this.selected = next;
    this.width = next.defaults.referenceResolution.width;
    this.height = next.defaults.referenceResolution.height;
    this.tile = next.defaults.tileSize;
  }

  update(values: {
    readonly name?: string;
    readonly width?: number;
    readonly height?: number;
    readonly tileSize?: number;
  }): void {
    if (values.name !== undefined) this.projectName = values.name;
    if (values.width !== undefined) this.width = values.width;
    if (values.height !== undefined) this.height = values.height;
    if (values.tileSize !== undefined) this.tile = values.tileSize;
  }

  buildRequest(): CreateProjectFromTemplateRequest {
    if (!this.selected) throw new Error("Nenhum template disponível");
    const name = this.projectName.trim();
    if (!name) throw new Error("Informe o nome do projeto");
    if (!Number.isInteger(this.width) || this.width < 1 || !Number.isInteger(this.height) || this.height < 1) {
      throw new Error("Informe uma resolução de referência válida");
    }
    if (!Number.isInteger(this.tile) || this.tile < 1 || this.tile > MAX_PROJECT_TILE_SIZE) {
      throw new Error(`Tile size deve ser um inteiro entre 1 e ${MAX_PROJECT_TILE_SIZE}`);
    }
    return {
      templateId: this.selected.id,
      name,
      referenceResolution: { width: this.width, height: this.height },
      tileSize: this.tile,
    };
  }
}
