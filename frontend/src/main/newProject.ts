/**
 * Fluxo "Novo projeto" (ALPHA-0.1 P0.2, passo 2 da jornada de aceite).
 *
 * "Novo projeto" cria o projeto a partir do template canônico "Plataforma 2D"
 * do middleware — não um projeto em branco. O nome do descritor vem do
 * template resolvido pelo middleware, então a UI mostra "Plataforma 2D" e o
 * usuário cai direto numa cena editável (nível, câmera, luz e Player).
 *
 * O fluxo é puro e injetável (cliente e ciclo de vida por parâmetro),
 * testável sem Electron — mesmo padrão do ProcessSupervisor.
 */

import type { ProjectDescriptor } from "../core/projectLifecycle.js";
import type { ProjectOperationResult } from "./EditorClient.js";

/** Template canônico usado pelo passo 2 da jornada ("Novo projeto de plataforma 2D"). */
export const DEFAULT_PROJECT_TEMPLATE_ID = "platformer-2d";

/** Nome exibido quando o middleware não devolve o nome do template. */
export const UNTITLED_PROJECT_NAME = "Projeto sem título";

/** Subconjunto do EditorClient que o fluxo precisa (injetável nos testes). */
export interface NewProjectClient {
  createProject(templateId?: string): Promise<ProjectOperationResult>;
}

/** Subconjunto da ProjectLifecycle que o fluxo precisa (injetável nos testes). */
export interface NewProjectLifecycle {
  beginOpen(): void;
  opened(descriptor: ProjectDescriptor): void;
  openFailed(): void;
}

/**
 * Transação "novo projeto a partir do template": beginOpen → createProject no
 * caminho canônico → opened com o descritor da nova sessão. Qualquer falha
 * (transporte, sessão não ativada) restaura exatamente a sessão local
 * anterior via openFailed e propaga o erro original.
 */
export async function createProjectFromTemplate(
  client: NewProjectClient,
  lifecycle: NewProjectLifecycle,
  templateId: string = DEFAULT_PROJECT_TEMPLATE_ID,
): Promise<ProjectDescriptor> {
  lifecycle.beginOpen();
  try {
    const result = await client.createProject(templateId);
    const { status } = result;
    if (!status.active || !status.projectSessionId || !status.projectId) {
      throw new Error("middleware did not activate the requested project session");
    }
    const descriptor: ProjectDescriptor = {
      name: result.name ?? UNTITLED_PROJECT_NAME,
      projectSessionId: status.projectSessionId,
      projectId: status.projectId,
    };
    lifecycle.opened(descriptor);
    return descriptor;
  } catch (error) {
    lifecycle.openFailed();
    throw error;
  }
}
