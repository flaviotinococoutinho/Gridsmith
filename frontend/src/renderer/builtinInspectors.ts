import { isAvailabilityError } from "../core/canonicalCommandFeedback.js";
import type { DispatchOutcome } from "../core/editorCommands.js";
import type {
  InspectorEdit,
  InspectorFieldSchema,
} from "../core/inspectorRegistry.js";
import type {
  ProjectedEntityField,
  ProjectedLight,
} from "../core/levelEditorProjection.js";
import type {
  CellSelection,
  EntityDefinitionSelection,
  EntityInstanceSelection,
  LevelSelection,
  LightSelection,
  Selection,
} from "../core/selectionService.js";
import type { EditorWorkbenchApplication } from "./workbenchApplication.js";

export function registerBuiltinInspectors(application: EditorWorkbenchApplication): void {
  registerProjectInspector(application);
  registerLevelInspector(application);
  registerCellInspector(application);
  registerEntityDefinitionInspector(application);
  registerEntityInspector(application);
  registerCameraInspector(application);
  registerLightInspector(application);
  registerAssetAndProblemInspectors(application);
}

function registerProjectInspector(application: EditorWorkbenchApplication): void {
  application.inspector.register({
    id: "project.properties",
    label: "Projeto",
    requiredCapabilities: [],
    supportedSelections: ["project"],
    fields: [
      readOnlyString("name", "metadata.name", "Nome"),
      readOnlyString("project-id", "projectId", "ID do projeto"),
      readOnlyString("file-path", "filePath", "Arquivo"),
      {
        id: "reference-resolution",
        path: "metadata.referenceResolution",
        kind: "vector",
        label: "Resolução de referência",
        dimensions: 2,
        componentLabels: ["L", "A"],
        unit: { symbol: "px", label: "pixels", system: "pixel" },
        applyMode: "restart",
        readOnly: true,
      },
    ],
    read: (_selection, field) => {
      const snapshot = application.levelStore.snapshot;
      if (field.id === "name") return application.activeProject?.name ?? snapshot.metadata?.name ?? "";
      if (field.id === "project-id") return application.activeProject?.projectId ?? snapshot.projectId ?? "";
      if (field.id === "file-path") return application.activeProject?.filePath ?? "Ainda não salvo";
      const resolution = snapshot.metadata?.referenceResolution;
      return resolution ? [resolution.width, resolution.height] : [0, 0];
    },
  });
}

function registerLevelInspector(application: EditorWorkbenchApplication): void {
  application.inspector.register({
    id: "level.properties",
    label: "Nível",
    requiredCapabilities: [],
    supportedSelections: ["level"],
    fields: [
      readOnlyString("level-id", "levelId", "ID"),
      readOnlyInt("width", "width", "Largura", "cél", "células", "cell"),
      readOnlyInt("height", "height", "Altura", "cél", "células", "cell"),
      readOnlyInt("tile-size", "tileSize", "Tile size", "px", "pixels", "pixel"),
      readOnlyInt("seed", "seed", "Seed"),
    ],
    read: (selection, field) => {
      const level = application.levelStore.snapshot.levels.find(
        ({ levelId }) => levelId === (selection as LevelSelection).levelId,
      );
      return level?.[field.path as "levelId" | "width" | "height" | "tileSize" | "seed"];
    },
  });
}

function registerCellInspector(application: EditorWorkbenchApplication): void {
  application.inspector.register({
    id: "level.cell",
    label: "Célula",
    requiredCapabilities: [],
    supportedSelections: ["cell"],
    fields: [
      {
        id: "position",
        path: "position",
        kind: "vector",
        label: "Posição",
        dimensions: 2,
        componentLabels: ["X", "Y"],
        unit: { symbol: "cél", label: "coordenadas de célula", system: "cell" },
        applyMode: "immediate",
        readOnly: true,
      },
      {
        id: "value",
        path: "intGrid.value",
        kind: "int",
        label: "Significado",
        range: { min: 0, max: 32767, step: 1 },
        defaultValue: 0,
        reset: true,
        multiEdit: true,
        applyMode: "immediate",
      },
    ],
    read: (selection, field) => {
      const cellSelection = selection as CellSelection;
      const cell = cellSelection.cells[0];
      if (!cell) return field.id === "position" ? [0, 0] : 0;
      if (field.id === "position") return [cell.x, cell.y];
      const level = application.levelStore.snapshot.levels.find(
        ({ levelId }) => levelId === cellSelection.levelId,
      );
      return level && isCellInside(cell.x, cell.y, level.width, level.height)
        ? level.intGrid.valueAt(cell.x, cell.y)
        : 0;
    },
    apply: (edit) => applyCellEdit(application, edit),
  });
}

function registerEntityDefinitionInspector(application: EditorWorkbenchApplication): void {
  application.inspector.register({
    id: "entity.definition",
    label: "Definição de entidade",
    requiredCapabilities: [],
    supportedSelections: ["entity-definition"],
    fields: [
      readOnlyString("definition-id", "entityDefId", "ID"),
      readOnlyString("archetype", "archetypeId", "Archetype"),
      readOnlyString("tags", "tags", "Tags"),
    ],
    read: (selection, field) => {
      const definition = application.levelStore.snapshot.entityDefinitions.find(
        ({ entityDefId }) => entityDefId === (selection as EntityDefinitionSelection).definitionId,
      );
      if (field.id === "definition-id") return definition?.entityDefId ?? "";
      if (field.id === "archetype") return definition?.archetypeId ?? "Somente editorial";
      return definition?.tags?.join(", ") ?? "";
    },
  });
}

function registerEntityInspector(application: EditorWorkbenchApplication): void {
  application.inspector.register({
    id: "entity.instance",
    label: "Entidade",
    requiredCapabilities: [],
    supportedSelections: ["entity-instance"],
    fields: () => entityInspectorFields(application),
    read: (selection, field) => {
      const entity = application.levelStore.snapshot.entities.find(
        ({ entityId }) => entityId === (selection as EntityInstanceSelection).entityId,
      );
      if (field.id === "entity-id") return entity?.entityId ?? "";
      if (field.id === "definition-id") return entity?.entityDefId ?? "";
      if (field.id === "position") return entity?.position ?? [0, 0];
      return entity?.fields?.[field.path];
    },
    apply: (edit) => applyEntityEdit(application, edit),
  });
}

function registerCameraInspector(application: EditorWorkbenchApplication): void {
  const cameraFields: readonly InspectorFieldSchema[] = [
    floatField("frequency", "Frequência", { min: Number.EPSILON, step: 0.1 }, "Hz", "hertz", "time"),
    floatField("damping", "Amortecimento", { min: 0, step: 0.1 }),
    floatField("response", "Resposta", { step: 0.1 }),
    floatField("anticipationSeconds", "Antecipação", { min: 0, step: 0.01 }, "s", "segundos", "time"),
  ];
  application.inspector.register({
    id: "camera.settings",
    label: "Câmera",
    requiredCapabilities: [],
    supportedSelections: ["camera"],
    fields: cameraFields,
    read: (_selection, field) => application.levelStore.snapshot.camera[
      field.path as keyof typeof application.levelStore.snapshot.camera
    ] ?? 0,
    apply: (edit) => dispatchSingle(application, "camera/configure", {
      settings: { [edit.path]: edit.value },
    }, `Alterar câmera: ${edit.fieldId}`),
  });
}

function registerLightInspector(application: EditorWorkbenchApplication): void {
  application.inspector.register({
    id: "light.properties",
    label: "Luz",
    requiredCapabilities: [],
    supportedSelections: ["light"],
    fields: [
      readOnlyString("light-id", "lightId", "ID"),
      {
        id: "type",
        path: "type",
        kind: "enum",
        label: "Tipo",
        options: [
          { value: "directional", label: "Direcional" },
          { value: "point", label: "Pontual" },
          { value: "spot", label: "Spot" },
        ],
        applyMode: "immediate",
      },
      floatField("intensity", "Intensidade", { min: Number.EPSILON, step: 0.1 }),
      {
        id: "color",
        path: "color",
        kind: "color",
        label: "Cor",
        format: "linear",
        alpha: false,
        applyMode: "immediate",
      },
      {
        id: "position",
        path: "position",
        kind: "vector",
        label: "Posição",
        dimensions: 2,
        componentLabels: ["X", "Y"],
        unit: { symbol: "wu", label: "unidades de mundo", system: "world" },
        applyMode: "immediate",
      },
      floatField("radius", "Raio", { min: Number.EPSILON, step: 1 }, "wu", "unidades de mundo", "world"),
    ],
    read: (selection, field) => {
      const light = findLight(application, selection as LightSelection);
      if (field.id === "color") return light ? rgbToHex(light.color) : "#ffffff";
      if (field.id === "position") return light?.position ?? [0, 0];
      return light?.[field.path as keyof ProjectedLight] ?? (field.kind === "string" ? "" : 0);
    },
    apply: (edit) => applyLightEdit(application, edit),
  });
}

function registerAssetAndProblemInspectors(application: EditorWorkbenchApplication): void {
  application.inspector.register({
    id: "asset.summary",
    label: "Asset",
    requiredCapabilities: [],
    supportedSelections: ["asset"],
    fields: [
      readOnlyString("asset-id", "assetId", "ID"),
      readOnlyString("asset-type", "assetType", "Tipo"),
      {
        id: "reference",
        path: "assetId",
        kind: "asset-reference",
        label: "Referência",
        applyMode: "immediate",
        readOnly: true,
        allowNone: false,
      },
    ],
    read: (selection, field) => {
      if (field.id === "asset-type") return selection.kind === "asset" ? selection.assetType ?? "asset" : "";
      return selection.kind === "asset" ? selection.assetId : "";
    },
  });
  application.inspector.register({
    id: "problem.summary",
    label: "Problema",
    requiredCapabilities: [],
    supportedSelections: ["problem"],
    fields: [
      readOnlyString("problem-id", "problemId", "ID"),
      readOnlyString("severity", "severity", "Severidade"),
      readOnlyString("subject", "subjectId", "Objeto"),
    ],
    read: (selection, field) => selection.kind === "problem"
      ? (selection as unknown as Record<string, unknown>)[field.path] ?? "Projeto"
      : "",
  });
}

async function applyCellEdit(application: EditorWorkbenchApplication, edit: InspectorEdit): Promise<void> {
  application.assertProjectEditable();
  if (edit.fieldId !== "value" || typeof edit.value !== "number") return;
  const selections = edit.selections.filter((selection): selection is CellSelection => selection.kind === "cell");
  if (selections.length === 0) return;
  const levelId = selections[0]!.levelId;
  if (selections.some((selection) => selection.levelId !== levelId)) {
    throw new Error("A edição múltipla de células exige um único nível.");
  }
  const level = application.levelStore.snapshot.levels.find((candidate) => candidate.levelId === levelId);
  if (!level) throw new Error("O nível selecionado não está mais disponível.");
  const cells = selections.flatMap((selection) => selection.cells);
  if (cells.some((cell) => !isCellInside(cell.x, cell.y, level.width, level.height))) {
    throw new Error("A seleção contém células fora dos limites atuais do nível.");
  }
  const transactionId = crypto.randomUUID();
  level.intGrid.beginGesture(transactionId, "Alterar significado da célula");
  try {
    for (const cell of cells) level.intGrid.paint(cell.x, cell.y, edit.value);
  } catch (error) {
    level.intGrid.cancelGesture();
    throw error;
  }
  const gesture = level.intGrid.finishGesture();
  if (!gesture) return;
  application.api.beginEditGesture(transactionId);
  let uncertain = false;
  try {
    const outcome = await application.api.dispatch("level/patch", {
      levelId,
      changes: gesture.changes,
      transactionId,
      metadata: { label: gesture.label },
    }) as DispatchOutcome;
    application.recordDispatchOutcome(outcome);
    uncertain = !application.levelStore.applyAcknowledgement(outcome.event);
  } catch (error) {
    uncertain = isAvailabilityError(error);
    if (!uncertain) application.levelStore.rejectLevelPatch(levelId, transactionId);
    throw error;
  } finally {
    if (!uncertain) application.api.endEditGesture(transactionId);
  }
}

function isCellInside(x: number, y: number, width: number, height: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height;
}

async function applyEntityEdit(application: EditorWorkbenchApplication, edit: InspectorEdit): Promise<void> {
  const selections = edit.selections.filter(
    (selection): selection is EntityInstanceSelection => selection.kind === "entity-instance",
  );
  if (selections.length !== 1) {
    throw new Error("Edição múltipla de entidades aguarda um batch canônico atômico.");
  }
  const entity = application.levelStore.snapshot.entities.find(
    ({ entityId }) => entityId === selections[0]!.entityId,
  );
  if (!entity) throw new Error("A entidade selecionada não está mais disponível.");
  return edit.fieldId === "position"
    ? dispatchSingle(application, "entity/move", {
        entityId: entity.entityId,
        position: edit.value,
      }, `Mover ${entity.entityId}`)
    : dispatchSingle(application, "entity/properties", {
        entityId: entity.entityId,
        changes: [{ name: edit.path, before: entity.fields?.[edit.path], after: edit.value }],
      }, `Alterar ${edit.path}`);
}

async function applyLightEdit(application: EditorWorkbenchApplication, edit: InspectorEdit): Promise<void> {
  const selections = edit.selections.filter((selection): selection is LightSelection => selection.kind === "light");
  if (selections.length !== 1) {
    throw new Error("Edição múltipla de luzes aguarda um batch canônico atômico.");
  }
  const light = findLight(application, selections[0]!);
  if (!light) throw new Error("A luz selecionada não está mais disponível.");
  const value = edit.fieldId === "color" && typeof edit.value === "string"
    ? hexToRgb(edit.value)
    : edit.value;
  return dispatchSingle(application, "light/update", {
    ...light,
    [edit.path]: value,
  }, `Alterar luz ${light.lightId}`);
}

async function dispatchSingle(
  application: EditorWorkbenchApplication,
  kind: string,
  payload: Record<string, unknown>,
  label: string,
): Promise<void> {
  application.assertProjectEditable();
  const transactionId = crypto.randomUUID();
  application.api.beginEditGesture(transactionId);
  let uncertain = false;
  try {
    const outcome = await application.api.dispatch(kind, {
      ...payload,
      transactionId,
      metadata: { label },
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

function entityInspectorFields(application: EditorWorkbenchApplication): readonly InspectorFieldSchema[] {
  const selected = application.selection.current;
  const entity = selected?.kind === "entity-instance"
    ? application.levelStore.snapshot.entities.find(({ entityId }) => entityId === selected.entityId)
    : undefined;
  const definition = application.levelStore.snapshot.entityDefinitions.find(
    ({ entityDefId }) => entityDefId === entity?.entityDefId,
  );
  return [
    readOnlyString("entity-id", "entityId", "ID"),
    {
      id: "definition-id",
      path: "entityDefId",
      kind: "entity-reference",
      label: "Definição",
      definitionIds: application.levelStore.snapshot.entityDefinitions.map(({ entityDefId }) => entityDefId),
      applyMode: "restart",
      readOnly: true,
    },
    {
      id: "position",
      path: "position",
      kind: "vector",
      label: "Posição",
      dimensions: 2,
      componentLabels: ["X", "Y"],
      unit: { symbol: "wu", label: "unidades de mundo", system: "world" },
      applyMode: "immediate",
    },
    ...(definition?.fields ?? []).map(entityFieldSchema),
  ];
}

function entityFieldSchema(field: ProjectedEntityField): InspectorFieldSchema {
  const common = {
    id: `field-${field.name}`,
    path: field.name,
    label: field.name,
    defaultValue: field.default as never,
    reset: field.default !== undefined,
    applyMode: "immediate" as const,
  };
  if (field.type === "int") return { ...common, kind: "int", range: rangeOf(field) };
  if (field.type === "float") return { ...common, kind: "float", range: rangeOf(field) };
  if (field.type === "bool") return { ...common, kind: "bool" };
  if (field.type === "enum") return {
    ...common,
    kind: "enum",
    options: (field.options ?? []).map((value) => ({ value, label: value })),
  };
  if (field.type === "point") return {
    ...common,
    kind: "vector",
    dimensions: 2,
    componentLabels: ["X", "Y"],
    unit: { symbol: "wu", label: "unidades de mundo", system: "world" },
  };
  if (field.type === "color") return { ...common, kind: "color", format: "hex", alpha: true };
  return { ...common, kind: "string" };
}

function findLight(
  application: EditorWorkbenchApplication,
  selection: LightSelection,
): ProjectedLight | undefined {
  return application.levelStore.snapshot.lights.find(({ lightId }) => lightId === selection.lightId);
}

function readOnlyString(id: string, path: string, label: string): InspectorFieldSchema {
  return { id, path, kind: "string", label, applyMode: "immediate", readOnly: true };
}

function readOnlyInt(
  id: string,
  path: string,
  label: string,
  symbol?: string,
  unitLabel?: string,
  system?: string,
): InspectorFieldSchema {
  return {
    id,
    path,
    kind: "int",
    label,
    applyMode: "immediate",
    readOnly: true,
    ...(symbol && unitLabel ? { unit: { symbol, label: unitLabel, ...(system ? { system } : {}) } } : {}),
  };
}

function floatField(
  id: string,
  label: string,
  range: { readonly min?: number; readonly max?: number; readonly step?: number },
  symbol?: string,
  unitLabel?: string,
  system?: string,
): InspectorFieldSchema {
  return {
    id,
    path: id,
    kind: "float",
    label,
    range,
    applyMode: "immediate",
    ...(symbol && unitLabel ? { unit: { symbol, label: unitLabel, ...(system ? { system } : {}) } } : {}),
  };
}

function rangeOf(field: ProjectedEntityField) {
  return {
    ...(field.min !== undefined ? { min: field.min } : {}),
    ...(field.max !== undefined ? { max: field.max } : {}),
  };
}

function rgbToHex(color: readonly [number, number, number]): string {
  return `#${color.map((component) => Math.round(Math.max(0, Math.min(1, component)) * 255)
    .toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error("Informe a cor no formato #RRGGBB.");
  const encoded = match[1]!;
  return [0, 2, 4].map((index) => Number.parseInt(encoded.slice(index, index + 2), 16) / 255) as unknown as
    readonly [number, number, number];
}
