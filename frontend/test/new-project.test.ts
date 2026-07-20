import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROJECT_TEMPLATES,
  getProjectTemplate,
} from "@p7m/middleware/dist/canonical/ProjectTemplates.js";
import { ProjectLifecycle } from "../src/core/projectLifecycle.js";
import type { ProjectOperationResult } from "../src/main/EditorClient.js";
import {
  DEFAULT_PROJECT_TEMPLATE_ID,
  UNTITLED_PROJECT_NAME,
  createProjectFromTemplate,
  type NewProjectClient,
} from "../src/main/newProject.js";

/** Cliente falso: registra o templateId pedido e devolve o resultado configurado. */
class FakeClient implements NewProjectClient {
  requestedTemplateIds: Array<string | undefined> = [];

  constructor(
    private readonly result: ProjectOperationResult | (() => Promise<ProjectOperationResult>),
  ) {}

  createProject(templateId?: string): Promise<ProjectOperationResult> {
    this.requestedTemplateIds.push(templateId);
    return typeof this.result === "function"
      ? this.result()
      : Promise.resolve(this.result);
  }
}

const activeResult = (overrides: Partial<ProjectOperationResult> = {}): ProjectOperationResult => ({
  status: {
    active: true,
    projectSessionId: "session-1",
    projectId: "project-1",
    commandSequence: "4",
    runtimeState: "synchronized",
  },
  summary: { applied: 4, projected: 4, deferred: 0, skipped: 0 },
  templateId: DEFAULT_PROJECT_TEMPLATE_ID,
  name: "Plataforma 2D",
  ...overrides,
});

test("novo projeto: o template default existe no registro canônico do middleware", () => {
  const template = getProjectTemplate(DEFAULT_PROJECT_TEMPLATE_ID);
  assert.ok(
    template,
    `o template "${DEFAULT_PROJECT_TEMPLATE_ID}" precisa existir no middleware ` +
      `(disponíveis: ${PROJECT_TEMPLATES.map((t) => t.id).join(", ")})`,
  );
  assert.equal(template.label, "Plataforma 2D");
});

test("novo projeto: cria a partir do template canônico e abre a sessão limpa", async () => {
  const client = new FakeClient(activeResult());
  const lifecycle = new ProjectLifecycle(() => 0);

  const descriptor = await createProjectFromTemplate(client, lifecycle);

  // O passo 2 da jornada NÃO cria projeto em branco: o template viaja no pedido.
  assert.deepEqual(client.requestedTemplateIds, [DEFAULT_PROJECT_TEMPLATE_ID]);
  assert.equal(descriptor.name, "Plataforma 2D");
  assert.equal(descriptor.projectSessionId, "session-1");
  assert.equal(descriptor.projectId, "project-1");
  assert.equal(descriptor.filePath, undefined); // novo projeto ainda não salvo
  assert.equal(lifecycle.currentState, "open-clean");
  assert.equal(lifecycle.windowTitle, "Plataforma 2D — P7M");
});

test("novo projeto: sem nome do middleware, cai no nome padrão", async () => {
  const client = new FakeClient(activeResult({ name: undefined }));
  const lifecycle = new ProjectLifecycle(() => 0);

  const descriptor = await createProjectFromTemplate(client, lifecycle);
  assert.equal(descriptor.name, UNTITLED_PROJECT_NAME);
});

test("novo projeto: falha de transporte restaura exatamente a sessão anterior", async () => {
  const boom = new Error("gateway indisponível");
  const client = new FakeClient(() => Promise.reject(boom));
  const lifecycle = new ProjectLifecycle(() => 0);
  // Sessão anterior: projeto aberto e sujo.
  lifecycle.beginOpen();
  lifecycle.opened({ name: "Anterior", projectSessionId: "s0", projectId: "p0" });
  lifecycle.commandApplied();
  assert.equal(lifecycle.currentState, "open-dirty");

  await assert.rejects(() => createProjectFromTemplate(client, lifecycle), boom);

  assert.equal(lifecycle.currentState, "open-dirty");
  assert.equal(lifecycle.project?.name, "Anterior");
  assert.equal(lifecycle.project?.projectSessionId, "s0");
});

test("novo projeto: sessão não ativada pelo middleware é erro e faz rollback", async () => {
  const client = new FakeClient(
    activeResult({
      status: { active: false, commandSequence: "0", runtimeState: "synchronized" },
    }),
  );
  const lifecycle = new ProjectLifecycle(() => 0);

  await assert.rejects(
    () => createProjectFromTemplate(client, lifecycle),
    /did not activate/,
  );
  assert.equal(lifecycle.currentState, "no-project");
  assert.equal(lifecycle.project, undefined);
});

test("novo projeto: um template explícito sobrepõe o default", async () => {
  const client = new FakeClient(activeResult({ templateId: "outro", name: "Outro" }));
  const lifecycle = new ProjectLifecycle(() => 0);

  const descriptor = await createProjectFromTemplate(client, lifecycle, "outro");
  assert.deepEqual(client.requestedTemplateIds, ["outro"]);
  assert.equal(descriptor.name, "Outro");
});
