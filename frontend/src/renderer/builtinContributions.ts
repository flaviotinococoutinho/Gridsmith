/** Internal MVP contributions. This is a composition catalog, not a public plugin API. */

import {
  activateLevelEditorTool,
  type LevelEditorToolKind,
} from "../core/levelEditorTools.js";
import { PROJECT_STABLE_CAPABILITY } from "../core/capabilityRegistry.js";
import { PROJECT_COMMAND_IDS } from "../core/projectApi.js";
import type { ToolContribution, ToolKind } from "../core/toolRegistry.js";
import {
  mountHistoryPanel,
  mountOutputPanel,
  mountPerformancePanel,
  mountProblemsPanel,
} from "./bottomPanels.js";
import { registerBuiltinInspectors } from "./builtinInspectors.js";
import { mountLevelEditor } from "./levelEditorView.js";
import { mountProjectExplorer } from "./projectExplorerPanel.js";
import { mountProjectStart } from "./projectStartPanel.js";
import { mountSchemaInspector } from "./schemaInspectorView.js";
import type { EditorWorkbenchApplication } from "./workbenchApplication.js";

export function registerBuiltinContributions(application: EditorWorkbenchApplication): void {
  registerCommands(application);
  registerTools(application);
  registerBuiltinInspectors(application);
  registerPanels(application);
}

function registerCommands(application: EditorWorkbenchApplication): void {
  const previewHostCapability = "editor.preview-host.connected";
  const stableProject = () => application.isProjectCommandAvailable("save");
  const projectEnablement = () => stableProject()
    ? true
    : { enabled: false, reason: "Abra um projeto e aguarde a operação atual terminar." };
  const available = (kind: "new" | "open") => () => application.isProjectCommandAvailable(kind)
    ? true
    : { enabled: false, reason: "Aguarde a operação de projeto atual terminar." };

  application.commands.register({
    id: PROJECT_COMMAND_IDS.new,
    label: "Novo projeto…",
    description: "Criar um projeto a partir de um template real",
    category: "Projeto",
    keywords: ["novo", "template", "plataforma 2d"],
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: commonProjectPlacements("Novo", "CtrlOrMeta+N", ["Arquivo", "Novo projeto"]),
    enableWhen: available("new"),
    execute: () => application.startNewProject(),
  });
  application.commands.register({
    id: PROJECT_COMMAND_IDS.open,
    label: "Abrir projeto…",
    description: "Abrir um documento P7M existente",
    category: "Projeto",
    keywords: ["arquivo", "recentes"],
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: commonProjectPlacements("Abrir…", "CtrlOrMeta+O", ["Arquivo", "Abrir projeto"], 10),
    enableWhen: available("open"),
    execute: () => application.runProjectAction(() => application.api.openProject()),
  });
  application.commands.register({
    id: PROJECT_COMMAND_IDS.openExample,
    label: "Abrir exemplo",
    description: "Abrir uma cópia editável do projeto de exemplo",
    category: "Projeto",
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: [
      { surface: "menu", path: ["Arquivo", "Abrir exemplo"], order: 20 },
      { surface: "command-palette" },
    ],
    enableWhen: available("open"),
    execute: () => application.runProjectAction(() => application.api.openProject({ source: "example" })),
  });
  application.commands.register<{ readonly filePath?: string }, unknown>({
    id: PROJECT_COMMAND_IDS.openRecent,
    label: "Abrir projeto recente",
    description: "Abrir um caminho listado nos projetos recentes",
    category: "Projeto",
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: [{ surface: "menu", path: ["Arquivo", "Recentes"] }],
    enableWhen: available("open"),
    execute: (_context, args) => {
      if (!args?.filePath) throw new Error("O projeto recente não possui um caminho válido.");
      return application.runProjectAction(() => application.api.openRecent(args.filePath!));
    },
  });
  application.commands.register({
    id: PROJECT_COMMAND_IDS.save,
    label: "Salvar projeto",
    description: "Persistir o estado canônico exibido",
    category: "Projeto",
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: commonProjectPlacements("Salvar", "CtrlOrMeta+S", ["Arquivo", "Salvar"], 20),
    enableWhen: projectEnablement,
    execute: () => application.runProjectAction(() => application.api.saveProject()),
  });
  application.commands.register({
    id: PROJECT_COMMAND_IDS.saveAs,
    label: "Salvar projeto como…",
    description: "Escolher um novo arquivo sem alterar o original antes da confirmação",
    category: "Projeto",
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: [
      { surface: "menu", path: ["Arquivo", "Salvar como"], order: 30 },
      { surface: "command-palette" },
      { surface: "shortcut", chord: "CtrlOrMeta+Shift+S" },
    ],
    enableWhen: projectEnablement,
    execute: () => application.runProjectAction(() => application.api.saveProjectAs()),
  });
  application.commands.register({
    id: PROJECT_COMMAND_IDS.close,
    label: "Fechar projeto",
    description: "Fechar com proteção de alterações não salvas",
    category: "Projeto",
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: [
      { surface: "menu", path: ["Arquivo", "Fechar projeto"], order: 40 },
      { surface: "command-palette" },
      { surface: "shortcut", chord: "CtrlOrMeta+W" },
    ],
    enableWhen: projectEnablement,
    execute: () => application.runProjectAction(() => application.api.closeProject()),
  });
  application.commands.register({
    id: PROJECT_COMMAND_IDS.undo,
    label: "Desfazer",
    description: "Desfazer a última transação do histórico global",
    category: "Edição",
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: [
      { surface: "menu", path: ["Editar", "Desfazer"] },
      { surface: "toolbar", group: "context", compactLabel: "↶ Desfazer", order: 10 },
      { surface: "context-menu", group: "edit", order: 10 },
      { surface: "command-palette" },
      { surface: "shortcut", chord: "CtrlOrMeta+Z" },
    ],
    enableWhen: () => application.canUndo()
      ? true
      : { enabled: false, reason: "Não há uma transação disponível para desfazer." },
    execute: () => application.runHistoryAction(() => application.api.undo()),
  });
  application.commands.register({
    id: PROJECT_COMMAND_IDS.redo,
    label: "Refazer",
    description: "Refazer a próxima transação do histórico global",
    category: "Edição",
    requiredCapabilities: [],
    commitEditorDrafts: true,
    placements: [
      { surface: "menu", path: ["Editar", "Refazer"] },
      { surface: "toolbar", group: "context", compactLabel: "↷ Refazer", order: 20 },
      { surface: "context-menu", group: "edit", order: 20 },
      { surface: "command-palette" },
      { surface: "shortcut", chord: "CtrlOrMeta+Shift+Z" },
      { surface: "shortcut", chord: "CtrlOrMeta+Y" },
    ],
    enableWhen: () => application.canRedo()
      ? true
      : { enabled: false, reason: "Não há uma transação disponível para refazer." },
    execute: () => application.runHistoryAction(() => application.api.redo()),
  });
  application.commands.register({
    id: "workbench.commandPalette",
    label: "Mostrar paleta de comandos",
    description: "Buscar qualquer ação registrada",
    category: "Exibir",
    requiredCapabilities: [],
    placements: [
      { surface: "command-palette" },
      { surface: "shortcut", chord: "CtrlOrMeta+Shift+P" },
    ],
    execute: () => application.openCommandPalette(),
  });
  for (const [order, descriptor] of ([
    { id: "workbench.toggleProjectTree", label: "Alternar árvore do projeto", region: "left" },
    { id: "workbench.toggleInspector", label: "Alternar Inspector", region: "right" },
    { id: "workbench.toggleBottom", label: "Alternar painel inferior", region: "bottom" },
  ] as const).entries()) {
    application.commands.register({
      id: descriptor.id,
      label: descriptor.label,
      description: "Mostrar ou ocultar a região e persistir a preferência",
      category: "Exibir",
      requiredCapabilities: [],
      placements: [
        { surface: "menu", path: ["Exibir", descriptor.label], order },
        { surface: "command-palette" },
      ],
      execute: () => application.toggleWorkbenchRegion(descriptor.region),
    });
  }
  application.commands.register({
    id: "workbench.restoreLayout",
    label: "Restaurar layout padrão",
    description: "Restaurar tamanhos e visibilidade das regiões",
    category: "Exibir",
    requiredCapabilities: [],
    placements: [
      { surface: "menu", path: ["Exibir", "Restaurar layout padrão"], order: 100 },
      { surface: "command-palette" },
    ],
    execute: () => application.restoreWorkbenchLayout(),
  });
  application.commands.register({
    id: "workbench.play",
    label: "Play",
    description: "Entrar no modo de ferramentas de execução",
    category: "Execução",
    requiredCapabilities: [previewHostCapability],
    placements: [
      { surface: "toolbar", group: "context", compactLabel: "▶ Play", order: 100 },
      { surface: "command-palette" },
    ],
    visibleWhen: ({ mode }) => mode === "edit",
    enableWhen: () => Boolean(application.activeProject),
    execute: () => application.setMode("playing"),
  });
  application.commands.register({
    id: "workbench.pause",
    label: "Pausar",
    description: "Pausar o modo de execução da interface",
    category: "Execução",
    requiredCapabilities: [previewHostCapability],
    placements: [
      { surface: "toolbar", group: "context", compactLabel: "Ⅱ Pausar", order: 100 },
      { surface: "command-palette" },
    ],
    visibleWhen: ({ mode }) => mode === "playing",
    execute: () => application.setMode("paused"),
  });
  application.commands.register({
    id: "workbench.resume",
    label: "Continuar",
    description: "Retomar o modo de execução da interface",
    category: "Execução",
    requiredCapabilities: [previewHostCapability],
    placements: [
      { surface: "toolbar", group: "context", compactLabel: "▶ Continuar", order: 100 },
      { surface: "command-palette" },
    ],
    visibleWhen: ({ mode }) => mode === "paused",
    execute: () => application.setMode("playing"),
  });
  application.commands.register({
    id: "workbench.stop",
    label: "Parar",
    description: "Voltar às ferramentas de edição",
    category: "Execução",
    requiredCapabilities: [previewHostCapability],
    placements: [
      { surface: "toolbar", group: "context", compactLabel: "■ Parar", order: 110 },
      { surface: "command-palette" },
    ],
    visibleWhen: ({ mode }) => mode === "playing" || mode === "paused",
    execute: () => application.setMode("edit"),
  });
  application.commands.register<{
    readonly serviceId?: string;
    readonly entry?: { readonly subject?: string };
  }, boolean>({
    id: "service.restart",
    label: "Reiniciar serviço",
    description: "Tentar reiniciar somente o serviço com falha",
    category: "Diagnóstico",
    requiredCapabilities: [],
    placements: [
      { surface: "corrective-action", problemKind: "service-failed" },
    ],
    execute: (_context, args) => {
      const serviceId = args?.serviceId ?? args?.entry?.subject;
      if (!serviceId) throw new Error("Informe o serviço que deve ser reiniciado.");
      return application.restartService(serviceId);
    },
  });
}

function commonProjectPlacements(
  compactLabel: string,
  chord: string,
  path: readonly string[],
  order = 0,
) {
  return [
    { surface: "menu" as const, path, order },
    { surface: "toolbar" as const, group: "project", compactLabel, order },
    { surface: "command-palette" as const },
    { surface: "shortcut" as const, chord },
  ];
}

function registerTools(application: EditorWorkbenchApplication): void {
  const supported: ReadonlyArray<{
    readonly kind: LevelEditorToolKind;
    readonly label: string;
    readonly icon: string;
    readonly description: string;
    readonly cursor: string;
  }> = [
    { kind: "selection", label: "Seleção", icon: "↖", description: "Selecionar células e entidades", cursor: "default" },
    { kind: "pencil", label: "Pincel", icon: "✎", description: "Pintar continuamente", cursor: "crosshair" },
    { kind: "eraser", label: "Borracha", icon: "⌫", description: "Apagar continuamente", cursor: "cell" },
    { kind: "line", label: "Linha", icon: "╱", description: "Traçar uma linha", cursor: "crosshair" },
    { kind: "rectangle", label: "Retângulo", icon: "□", description: "Preencher um retângulo", cursor: "crosshair" },
    { kind: "flood", label: "Balde", icon: "▨", description: "Preencher uma região conectada", cursor: "cell" },
    { kind: "picker", label: "Conta-gotas", icon: "⌖", description: "Capturar um significado da célula", cursor: "copy" },
    { kind: "entity", label: "Entidade", icon: "♙", description: "Posicionar ou mover uma entidade", cursor: "move" },
  ];
  supported.forEach((descriptor, order) => application.tools.register({
    id: `level.${descriptor.kind}`,
    kind: descriptor.kind,
    label: `${descriptor.icon} ${descriptor.label}`,
    description: descriptor.description,
    cursor: descriptor.cursor,
    order,
    requiredCapabilities: [PROJECT_STABLE_CAPABILITY],
    visibleWhen: ({ mode }) => mode === "edit",
    activate: (context) => activateLevelEditorTool(descriptor.kind, context),
  }));

  const future: ReadonlyArray<{
    readonly kind: ToolKind;
    readonly label: string;
    readonly capability: string;
  }> = [
    { kind: "camera", label: "◉ Câmera", capability: "editor.tool.camera" },
    { kind: "light", label: "✦ Luz", capability: "editor.tool.light" },
    { kind: "spawn", label: "◎ Spawn", capability: "editor.tool.spawn" },
    { kind: "trigger", label: "⬡ Trigger", capability: "editor.tool.trigger" },
  ];
  for (const [index, descriptor] of future.entries()) {
    const contribution: ToolContribution = {
      id: `level.${descriptor.kind}`,
      kind: descriptor.kind,
      label: descriptor.label,
      description: "Contribuição reservada; o perfil atual explica sua disponibilidade.",
      order: 100 + index,
      requiredCapabilities: [PROJECT_STABLE_CAPABILITY, descriptor.capability],
      visibleWhen: ({ mode }) => mode === "edit",
      activate: () => ({ dispose: () => undefined }),
    };
    application.tools.register(contribution);
  }
}

function registerPanels(application: EditorWorkbenchApplication): void {
  application.panels.register({
    id: "project.explorer",
    label: "Projeto",
    icon: "▣",
    defaultRegion: "left",
    order: 0,
    requiredCapabilities: [],
    mount: ({ mountTarget }) => mountProjectExplorer({
      host: mountTarget,
      store: application.levelStore,
      selection: application.selection,
      projectStatus: () => application.projectStatus,
    }),
  });
  application.panels.register({
    id: "project.start",
    label: "Início",
    defaultRegion: "center",
    order: 0,
    requiredCapabilities: [],
    visibleWhen: () => !application.activeProject,
    mount: ({ mountTarget }) => mountProjectStart({
      host: mountTarget,
      commands: application.commands,
      context: () => application.contributionContext(),
      status: () => application.projectStatus,
      onError: (error) => application.showError(error),
    }),
  });
  application.panels.register({
    id: "project.loading",
    label: "Preparando projeto",
    defaultRegion: "center",
    order: 5,
    requiredCapabilities: [],
    visibleWhen: () => Boolean(
      application.activeProject?.projectSessionId &&
      application.levelStore.cursor?.projectSessionId !== application.activeProject.projectSessionId,
    ),
    mount: ({ mountTarget }) => staticPanel(
      mountTarget,
      "Validando e preparando a projeção da sessão ativa…",
    ),
  });
  application.panels.register({
    id: "level.editor",
    label: "Editor de nível",
    icon: "▦",
    defaultRegion: "center",
    order: 10,
    // Edição canônica independe da engine; runtime pode ficar deferred.
    requiredCapabilities: [],
    visibleWhen: () => Boolean(
      application.activeProject?.projectSessionId &&
      application.levelStore.cursor?.projectSessionId === application.activeProject.projectSessionId,
    ),
    mount: ({ mountTarget }) => {
      const project = application.activeProject;
      const projectId = project?.projectId ?? application.levelStore.snapshot.projectId;
      const projectSessionId = project?.projectSessionId;
      if (!projectId || !projectSessionId) return staticPanel(mountTarget, "A sessão do projeto ainda está sendo preparada.");
      let cleanup = (): void => undefined;
      const context = application.contributionContext();
      const { selection: _selection, ...contributionContext } = context;
      const levelEditor = mountLevelEditor({
        host: mountTarget,
        store: application.levelStore,
        setCleanup: (release) => { cleanup = release; },
        toolRegistry: application.tools,
        selection: application.selection,
        contributionContext,
        projectId,
        projectSessionId,
        onDispatchOutcome: (outcome) => application.recordDispatchOutcome(outcome),
        ...(application.activeLevelId ? { preferredLevelId: application.activeLevelId } : {}),
      });
      return {
        activate: () => levelEditor.activate(),
        focus: () => mountTarget.querySelector<HTMLCanvasElement>("canvas")?.focus(),
        dispose: cleanup,
      };
    },
  });
  application.panels.register({
    id: "selection.inspector",
    label: "Inspector",
    icon: "ⓘ",
    defaultRegion: "right",
    order: 0,
    requiredCapabilities: [],
    mount: ({ mountTarget }) => mountSchemaInspector({
      host: mountTarget,
      registry: application.inspector,
      context: () => application.contributionContext(),
      trackCommit: (key, operation) => application.trackPendingEdit(key, operation),
      onError: (error) => application.showError(error),
    }),
  });
  const filter = application.environment.document.getElementById("log-filter") as HTMLInputElement;
  application.panels.register({
    id: "diagnostics.problems",
    label: "Problemas",
    icon: "⚠",
    defaultRegion: "bottom",
    order: 0,
    requiredCapabilities: [],
    mount: ({ mountTarget }) => mountProblemsPanel({
      host: mountTarget,
      filter,
      log: application.eventLog,
      commands: application.commands,
      context: () => application.contributionContext(),
      projectStatus: () => application.projectStatus,
      onError: (error) => application.showError(error),
    }),
  });
  application.panels.register({
    id: "diagnostics.output",
    label: "Saída",
    icon: "≡",
    defaultRegion: "bottom",
    order: 10,
    requiredCapabilities: [],
    mount: ({ mountTarget }) => mountOutputPanel({
      host: mountTarget,
      filter,
      log: application.eventLog,
      commands: application.commands,
      context: () => application.contributionContext(),
      projectStatus: () => application.projectStatus,
      onError: (error) => application.showError(error),
    }),
  });
  application.panels.register({
    id: "project.history",
    label: "Histórico",
    icon: "↶",
    defaultRegion: "bottom",
    order: 20,
    requiredCapabilities: [],
    mount: ({ mountTarget }) => mountHistoryPanel({
      host: mountTarget,
      filter,
      history: () => application.historyStatus,
    }),
  });
  application.panels.register({
    id: "diagnostics.performance",
    label: "Performance",
    icon: "⌁",
    defaultRegion: "bottom",
    order: 30,
    requiredCapabilities: [],
    mount: ({ mountTarget }) => mountPerformancePanel({
      host: mountTarget,
      filter,
      metrics: application.metrics,
    }),
  });
}

function staticPanel(host: HTMLElement, message: string) {
  const paragraph = document.createElement("p");
  paragraph.className = "muted panel-empty-state";
  paragraph.textContent = message;
  host.replaceChildren(paragraph);
  return { dispose: () => host.replaceChildren() };
}
