import { AssetBrowserController } from "../core/assetBrowserModel.js";
import { PROJECT_STABLE_CAPABILITY } from "../core/capabilityRegistry.js";
import { isAvailabilityError } from "../core/canonicalCommandFeedback.js";
import type { DispatchOutcome } from "../core/editorCommands.js";
import type { ProjectedEntityDefinition } from "../core/levelEditorProjection.js";
import type { AssetSelection, Selection } from "../core/selectionService.js";
import { mountAsepriteInspector, type SpriteRendererTarget } from "./asepriteInspectorPanel.js";
import { mountAssetBrowser } from "./assetBrowserPanel.js";
import type { EditorWorkbenchApplication } from "./workbenchApplication.js";

const ASSET_BROWSER_PANEL_ID = "assets.browser";
const ASEPRITE_INSPECTOR_PANEL_ID = "assets.aseprite";

export function registerAssetContributions(application: EditorWorkbenchApplication): void {
  const controller = new AssetBrowserController(application.api, {
    onError: (error) => application.showError(error),
  });
  let targetDefinitionId: string | undefined;
  let observedSessionId: string | undefined;
  const reportedMissingAssets = new Set<string>();

  const rememberTarget = (selection: Selection | undefined): void => {
    if (selection?.kind === "entity-definition") targetDefinitionId = selection.definitionId;
    if (selection?.kind === "entity-instance") {
      targetDefinitionId = application.levelStore.snapshot.entities.find(
        ({ entityId }) => entityId === selection.entityId,
      )?.entityDefId;
    }
  };
  application.selection.subscribe((change) => {
    if (change.projectSessionId !== observedSessionId) {
      observedSessionId = change.projectSessionId;
      targetDefinitionId = undefined;
      reportedMissingAssets.clear();
      if (change.projectSessionId) void controller.refresh();
    }
    rememberTarget(change.current);
  }, true);

  application.api.onApplicationEvent((event) => {
    const active = application.activeProject;
    if (!active || event.projectSessionId !== active.projectSessionId || event.projectId !== active.projectId) return;
    controller.handleApplicationEvent(event);
    if (event.kind === "asset/operationCompleted" && event.operationId) {
      application.resolveApplicationProblem({
        kind: "asset-pipeline-failed",
        projectSessionId: event.projectSessionId,
        operationId: event.operationId,
      });
    }
    if (event.severity === "error" || /fail|error/iu.test(event.kind)) {
      const payload = recordValue(event.payload);
      const assetId = text(payload?.["assetId"]);
      const errorPayload = recordValue(payload?.["error"]);
      const message = text(event.progress?.message) ?? text(payload?.["message"]) ??
        text(errorPayload?.["message"]) ?? text(errorPayload?.["stderr"]) ??
        "O pipeline de assets falhou. Reimporte ou configure as ferramentas do projeto.";
      application.recordApplicationEvent({
        ...event,
        kind: "asset-pipeline-failed",
        payload: { ...(payload ?? {}), ...(assetId ? { assetId } : {}), message },
      });
    } else application.recordApplicationEvent(event);
  });

  const target = (): SpriteRendererTarget | undefined => {
    const definition = targetDefinitionId
      ? application.levelStore.snapshot.entityDefinitions.find(
        ({ entityDefId }) => entityDefId === targetDefinitionId,
      )
      : undefined;
    return definition ? {
      definitionId: definition.entityDefId,
      label: definition.archetypeId ?? definition.entityDefId,
      hasSpriteRenderer: Boolean(definition.spriteRenderer),
    } : undefined;
  };

  const associate = (assetId: string, defaultClip?: string): Promise<void> =>
    associateSpriteRenderer(application, targetDefinitionId, assetId, defaultClip);

  application.panels.register({
    id: ASSET_BROWSER_PANEL_ID,
    label: "Assets",
    icon: "▧",
    defaultRegion: "left",
    order: 10,
    requiredCapabilities: [PROJECT_STABLE_CAPABILITY],
    visibleWhen: () => Boolean(application.activeProject),
    mount: ({ mountTarget }) => mountAssetBrowser({
      host: mountTarget,
      controller,
      selectSources: () => application.api.selectAssetSources(),
      detectAssetTools: () => application.api.configureAssetTools({ scope: "project" }),
      configureAssetTool: async (tool) => {
        const path = await application.api.selectAssetToolExecutable(tool);
        if (!path) return undefined;
        return application.api.configureAssetTools({
          scope: "project",
          ...(tool === "aseprite" ? { asepritePath: path } : { mgcbPath: path }),
        });
      },
      confirmRemove: (asset) => application.environment.hostWindow.confirm(
        `Remover “${asset.name}” do catálogo? Referências no Blueprint serão preservadas como problema reparável.`,
      ),
      filePathAdapter: {
        pathOf: (file) => {
          try {
            return application.api.pathForDroppedAsset(file) || undefined;
          } catch {
            return undefined;
          }
        },
      },
      onSelect: (asset) => {
        const project = application.activeProject;
        if (!project?.projectSessionId || !project.projectId) return;
        application.selection.select({
          kind: "asset",
          assetId: asset.assetId,
          assetType: asset.kind,
          projectSessionId: project.projectSessionId,
          projectId: project.projectId,
        }, "asset-browser");
        application.activatePanel(ASEPRITE_INSPECTOR_PANEL_ID, true);
      },
      onError: (error) => application.showError(error),
    }),
  });

  application.panels.register({
    id: ASEPRITE_INSPECTOR_PANEL_ID,
    label: "Aseprite",
    icon: "▦",
    defaultRegion: "right",
    order: 10,
    requiredCapabilities: [PROJECT_STABLE_CAPABILITY],
    supportedSelections: ["asset"],
    selectionPolicy: "primary",
    mount: ({ mountTarget }) => mountAsepriteInspector({
      host: mountTarget,
      controller,
      selectedAssetId: () => selectedAsset(application.selection.current)?.assetId,
      spriteRendererTarget: target,
      onAssociate: associate,
      onError: (error) => application.showError(error),
    }),
  });

  registerAssetCommands(application, controller, () => selectedAsset(application.selection.current), associate);

  const inspectReferences = (): void => {
    const snapshot = controller.snapshot;
    const project = application.activeProject;
    if (!snapshot.loaded || !project?.projectSessionId || !project.projectId) return;
    const available = new Set(snapshot.assets.map(({ assetId }) => assetId));
    const missing = new Map<string, string[]>();
    for (const definition of application.levelStore.snapshot.entityDefinitions) {
      const assetId = definition.spriteRenderer?.assetId;
      if (!assetId || available.has(assetId)) continue;
      const definitions = missing.get(assetId) ?? [];
      definitions.push(definition.entityDefId);
      missing.set(assetId, definitions);
    }
    for (const [assetId, definitions] of missing) {
      reportedMissingAssets.add(assetId);
      application.recordApplicationEvent({
        seq: `reference:${assetId}`,
        domain: "asset",
        kind: "asset-reference-missing",
        operationId: `reference:${assetId}`,
        projectSessionId: project.projectSessionId,
        projectId: project.projectId,
        commandSequence: application.levelStore.cursor?.commandSequence ?? "0",
        severity: "warning",
        payload: {
          assetId,
          definitions,
          message: `O asset ${assetId} não está no catálogo. A referência foi preservada para reparo.`,
        },
        timestamp: String(Date.now()),
      });
    }
    for (const assetId of [...reportedMissingAssets]) {
      if (missing.has(assetId)) continue;
      reportedMissingAssets.delete(assetId);
      application.resolveApplicationProblem({
        kind: "asset-reference-missing",
        projectSessionId: project.projectSessionId,
        subject: assetId,
      });
    }
  };
  controller.subscribe(inspectReferences);
  application.levelStore.onChange(inspectReferences);
}

function registerAssetCommands(
  application: EditorWorkbenchApplication,
  controller: AssetBrowserController,
  selected: () => AssetSelection | undefined,
  associate: (assetId: string, defaultClip?: string) => Promise<void>,
): void {
  const projectAvailable = () => application.activeProject
    ? true
    : { enabled: false, reason: "Abra um projeto para gerenciar assets." };
  application.commands.register({
    id: "assets.openBrowser",
    label: "Abrir Asset Browser",
    description: "Explorar o catálogo, tags e importações do projeto",
    category: "Assets",
    requiredCapabilities: [],
    placements: [
      { surface: "menu", path: ["Assets", "Abrir Asset Browser"] },
      { surface: "command-palette" },
      { surface: "corrective-action", problemKind: "asset-reference-missing" },
    ],
    enableWhen: projectAvailable,
    execute: () => application.activatePanel(ASSET_BROWSER_PANEL_ID, true),
  });
  application.commands.register({
    id: "assets.import",
    label: "Importar asset…",
    description: "Selecionar .ase/.aseprite para o pipeline existente",
    category: "Assets",
    requiredCapabilities: [],
    placements: [
      { surface: "menu", path: ["Assets", "Importar…"], order: 10 },
      { surface: "command-palette" },
      { surface: "corrective-action", problemKind: "asset-reference-missing" },
    ],
    enableWhen: projectAvailable,
    execute: async () => {
      const sources = await application.api.selectAssetSources();
      if (sources.length > 0) controller.importSources(sources);
      application.activatePanel(ASSET_BROWSER_PANEL_ID, true);
    },
  });
  application.commands.register<{ readonly entry?: { readonly subject?: string } }, string | undefined>({
    id: "assets.reimport",
    label: "Reimportar asset",
    description: "Executar novamente o pipeline a partir da fonte",
    category: "Assets",
    requiredCapabilities: [],
    supportedSelections: ["asset", "problem"],
    selectionPolicy: "primary",
    placements: [
      { surface: "command-palette" },
      { surface: "context-menu", group: "asset" },
      { surface: "corrective-action", problemKind: "asset-pipeline-failed" },
    ],
    enableWhen: projectAvailable,
    execute: (_context, args) => {
      const assetId = selected()?.assetId ?? args?.entry?.subject;
      if (!assetId) throw new Error("Selecione um asset que ainda exista no catálogo.");
      return controller.reimport(assetId);
    },
  });
  application.commands.register<{
    readonly entry?: {
      readonly subject?: string;
      readonly operationId?: string;
      readonly applicationPayload?: Readonly<Record<string, unknown>>;
    };
  }, string | readonly string[]>({
    id: "assets.retryFailedOperation",
    label: "Tentar novamente",
    description: "Repetir a importação ou reimportação que falhou",
    category: "Assets",
    requiredCapabilities: [],
    placements: [{ surface: "corrective-action", problemKind: "asset-pipeline-failed", order: 0 }],
    enableWhen: projectAvailable,
    execute: (_context, args) => {
      const payload = args?.entry?.applicationPayload;
      const assetId = text(payload?.["assetId"]);
      if (assetId) return controller.reimport(assetId);
      const nestedError = recordValue(payload?.["error"]);
      const sourcePath = text(payload?.["sourcePath"]) ?? text(payload?.["filePath"]) ??
        text(nestedError?.["sourcePath"]) ?? text(nestedError?.["filePath"]);
      if (!sourcePath) throw new Error("O evento não informou assetId nem arquivo de origem para repetir.");
      return controller.importSources([sourcePath]);
    },
  });
  application.commands.register<{
    readonly entry?: {
      readonly subject?: string;
      readonly operationId?: string;
      readonly applicationPayload?: Readonly<Record<string, unknown>>;
    };
  }, unknown>({
    id: "assets.openFailedSource",
    label: "Abrir arquivo",
    description: "Abrir a fonte associada à falha do pipeline",
    category: "Assets",
    requiredCapabilities: [],
    placements: [{ surface: "corrective-action", problemKind: "asset-pipeline-failed", order: 10 }],
    enableWhen: projectAvailable,
    execute: (_context, args) => {
      const assetId = text(args?.entry?.applicationPayload?.["assetId"]);
      if (assetId) return controller.revealSource(assetId);
      const operationId = args?.entry?.operationId;
      if (!operationId) throw new Error("A falha não informou uma operação segura para abrir.");
      return controller.revealOperationSource(operationId);
    },
  });
  application.commands.register({
    id: "assets.revealSource",
    label: "Abrir fonte do asset",
    category: "Assets",
    requiredCapabilities: [],
    supportedSelections: ["asset"],
    placements: [{ surface: "command-palette" }, { surface: "context-menu", group: "asset" }],
    execute: () => {
      const assetId = selected()?.assetId;
      if (!assetId) throw new Error("Selecione um asset.");
      return controller.revealSource(assetId);
    },
  });
  application.commands.register({
    id: "assets.revealOutput",
    label: "Revelar artefato compilado",
    category: "Assets",
    requiredCapabilities: [],
    supportedSelections: ["asset"],
    placements: [{ surface: "command-palette" }, { surface: "context-menu", group: "asset" }],
    execute: () => {
      const assetId = selected()?.assetId;
      if (!assetId) throw new Error("Selecione um asset.");
      return controller.revealOutput(assetId);
    },
  });
  application.commands.register({
    id: "assets.associateSpriteRenderer",
    label: "Associar asset ao SpriteRenderer",
    description: "Criar ou atualizar a referência canônica na definição alvo",
    category: "Assets",
    requiredCapabilities: [PROJECT_STABLE_CAPABILITY],
    supportedSelections: ["asset"],
    placements: [{ surface: "command-palette" }, { surface: "context-menu", group: "asset" }],
    execute: () => {
      const assetId = selected()?.assetId;
      if (!assetId) throw new Error("Selecione um asset.");
      return associate(assetId);
    },
  });
  application.commands.register({
    id: "assets.remove",
    label: "Remover asset do catálogo",
    description: "Remover o artefato preservando referências canônicas para reparo",
    category: "Assets",
    requiredCapabilities: [],
    supportedSelections: ["asset"],
    placements: [{ surface: "command-palette" }, { surface: "context-menu", group: "asset" }],
    execute: async () => {
      const assetId = selected()?.assetId;
      if (!assetId) throw new Error("Selecione um asset.");
      const asset = controller.snapshot.assets.find((candidate) => candidate.assetId === assetId);
      const confirmed = application.environment.hostWindow.confirm(
        `Remover “${asset?.name ?? assetId}” do catálogo?`,
      );
      return confirmed ? controller.remove(assetId) : false;
    },
  });

  registerToolConfigurationCommands(application);
}

function registerToolConfigurationCommands(application: EditorWorkbenchApplication): void {
  application.commands.register({
    id: "assets.configureTools",
    label: "Detectar e testar ferramentas de assets",
    description: "Validar Aseprite/MGCB do projeto sem informar caminhos manualmente",
    category: "Assets",
    requiredCapabilities: [],
    placements: [
      { surface: "menu", path: ["Assets", "Ferramentas", "Detectar e testar"], order: 20 },
      { surface: "command-palette" },
      { surface: "corrective-action", problemKind: "asset-pipeline-failed" },
    ],
    execute: () => application.api.configureAssetTools({ scope: "project" }),
  });
  for (const [order, tool, label] of ([
    [30, "aseprite", "Selecionar executável do Aseprite…"],
    [40, "mgcb", "Selecionar executável do MGCB…"],
  ] as const)) {
    application.commands.register({
      id: `assets.configure.${tool}`,
      label,
      description: "Selecionar pelo diálogo nativo e validar no escopo do projeto",
      category: "Assets",
      requiredCapabilities: [],
      placements: [
        { surface: "menu", path: ["Assets", "Ferramentas", label], order },
        { surface: "command-palette" },
        { surface: "corrective-action", problemKind: "asset-pipeline-failed", order },
      ],
      execute: async () => {
        const path = await application.api.selectAssetToolExecutable(tool);
        if (!path) return undefined;
        return application.api.configureAssetTools({
          scope: "project",
          ...(tool === "aseprite" ? { asepritePath: path } : { mgcbPath: path }),
        });
      },
    });
  }
}

async function associateSpriteRenderer(
  application: EditorWorkbenchApplication,
  definitionId: string | undefined,
  assetId: string,
  defaultClip: string | undefined,
): Promise<void> {
  application.assertProjectEditable();
  if (!definitionId) {
    throw new Error("Selecione uma entidade ou definição antes de escolher o asset.");
  }
  const definition = application.levelStore.snapshot.entityDefinitions.find(
    ({ entityDefId }) => entityDefId === definitionId,
  );
  if (!definition) throw new Error("A definição alvo não está mais na sessão ativa.");
  const transactionId = crypto.randomUUID();
  application.api.beginEditGesture(transactionId);
  let uncertain = false;
  try {
    const outcome = await application.api.dispatch("entitydef/update", {
      definition: withSpriteRenderer(definition, assetId, defaultClip),
      transactionId,
      metadata: { label: `Associar sprite a ${definition.entityDefId}` },
    }) as DispatchOutcome;
    application.recordDispatchOutcome(outcome);
    uncertain = !application.levelStore.applyAcknowledgement(outcome.event);
  } catch (error) {
    uncertain = isAvailabilityError(error);
    throw error;
  } finally {
    if (!uncertain) application.api.endEditGesture(transactionId);
  }
}

export function withSpriteRenderer(
  definition: ProjectedEntityDefinition,
  assetId: string,
  defaultClip?: string,
): ProjectedEntityDefinition & { readonly fields: NonNullable<ProjectedEntityDefinition["fields"]> } {
  if (!assetId.trim()) throw new Error("AssetId must not be empty.");
  return {
    ...definition,
    fields: (definition.fields ?? []).map((field) => ({
      ...field,
      ...(field.options ? { options: [...field.options] } : {}),
    })),
    ...(definition.tags ? { tags: [...definition.tags] } : {}),
    ...(definition.editor ? { editor: { ...definition.editor } } : {}),
    spriteRenderer: {
      assetId: assetId.trim(),
      ...(defaultClip?.trim() ? { defaultClip: defaultClip.trim() } : {}),
    },
  };
}

function selectedAsset(selection: Selection | undefined): AssetSelection | undefined {
  return selection?.kind === "asset" ? selection : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
