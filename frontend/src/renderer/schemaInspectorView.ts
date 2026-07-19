/** Generic renderer for InspectorRegistry schemas. It never mutates projections directly. */

import {
  InspectorRegistry,
  type InspectorApplyResult,
  type InspectorFieldSchema,
  type ResolvedInspectorField,
  type ResolvedInspectorSection,
} from "../core/inspectorRegistry.js";
import type { ContributionContext } from "../core/contributionContext.js";
import { semanticSelectionSetIdentityKey } from "../core/selectionService.js";
import type { PanelInstance } from "../core/panelRegistry.js";

export interface SchemaInspectorViewOptions {
  readonly host: HTMLElement;
  readonly registry: InspectorRegistry;
  readonly context: () => ContributionContext;
  readonly trackCommit?: <T>(key: string, promise: Promise<T>) => Promise<T>;
  readonly onError?: (error: unknown) => void;
}

export function mountSchemaInspector(options: SchemaInspectorViewOptions): PanelInstance {
  const render = (): void => renderInspector(options);
  const releaseSelection = options.context().selection.subscribe(render);
  const releaseRegistry = options.registry.onDidChange(render);
  render();
  return {
    activate: render,
    focus: () => options.host.querySelector<HTMLElement>("input, select, textarea, button")?.focus(),
    dispose: () => {
      releaseSelection();
      releaseRegistry();
      options.host.replaceChildren();
    },
  };
}

function renderInspector(options: SchemaInspectorViewOptions): void {
  const focus = captureSemanticFocus(options.host);
  const context = options.context();
  const sections = options.registry.resolve(context, { includeDisabled: true });
  if (sections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = context.selection.current
      ? "Não há propriedades para esta seleção."
      : "Selecione um item no projeto ou no canvas.";
    options.host.replaceChildren(empty);
    return;
  }
  options.host.replaceChildren(...sections.map((section) => sectionView(section, options)));
  restoreSemanticFocus(options.host, focus);
}

function sectionView(
  section: ResolvedInspectorSection,
  options: SchemaInspectorViewOptions,
): HTMLElement {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "inspector-section";
  const legend = document.createElement("legend");
  legend.textContent = section.contribution.label;
  fieldset.append(legend);
  if (!section.enabled && section.reason) fieldset.append(reasonText(section.reason));
  for (const field of section.fields) fieldset.append(fieldView(section, field, options));
  return fieldset;
}

function fieldView(
  section: ResolvedInspectorSection,
  field: ResolvedInspectorField,
  options: SchemaInspectorViewOptions,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "inspector-field";
  row.dataset["fieldKind"] = field.schema.kind;
  const trackedCommitKey = schemaInspectorCommitKey(
    section.contribution.id,
    field.schema.id,
    options.context(),
  );
  const inputId = `inspector-${safeId(section.contribution.id)}-${safeId(field.schema.id)}`;
  const labelText = document.createElement("span");
  labelText.id = `${inputId}-label`;
  labelText.className = "inspector-field-label";
  labelText.textContent = field.schema.label;
  if (field.schema.unit) {
    const unit = document.createElement("abbr");
    unit.title = field.schema.unit.label;
    unit.textContent = field.schema.unit.symbol;
    labelText.append(" ", unit);
  }
  if (field.schema.applyMode === "restart") {
    const badge = document.createElement("span");
    badge.className = "apply-mode-badge";
    badge.textContent = "requer reinício";
    labelText.append(" ", badge);
  }
  const editor = editorFor(field);
  configureEditorLabels(editor, section, field, inputId, labelText);
  if (editor.controls.length === 1 && editor.root === editor.controls[0]) {
    const label = document.createElement("label");
    label.htmlFor = editor.controls[0]!.id;
    label.append(labelText, editor.root);
    row.append(label);
  } else {
    editor.root.id = `${inputId}-group`;
    editor.root.setAttribute("role", "group");
    editor.root.setAttribute("aria-labelledby", labelText.id);
    row.append(labelText, editor.root);
  }

  const feedback = document.createElement("div");
  feedback.id = `${inputId}-feedback`;
  feedback.className = "inspector-feedback";
  feedback.setAttribute("aria-live", "polite");
  if (field.issues.length > 0) feedback.textContent = field.issues.map(({ message }) => message).join(" ");
  else if (!field.enabled && field.reason) feedback.textContent = field.reason;
  else if (field.mixed) feedback.textContent = "Valores diferentes na seleção múltipla.";
  row.append(feedback);
  setEditorAccessibility(
    editor,
    feedback.id,
    field.issues.some(({ severity }) => severity === "error"),
    field.enabled,
    field.schema.description,
  );

  if (field.canReset) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "inspector-reset";
    reset.textContent = "Redefinir";
    reset.disabled = !field.enabled;
    reset.dataset["inspectorFocusKey"] = schemaInspectorFocusKey(
      section.contribution.id,
      field.schema.id,
      "reset",
    );
    reset.addEventListener("click", () => {
      const commit = requireAppliedInspectorCommit(options.registry.reset(
        section.contribution.id,
        field.schema.id,
        options.context(),
      ));
      void trackInspectorCommit(options, trackedCommitKey, commit).then((result) => {
        feedback.textContent = result.applied
          ? result.restartRequired ? "Valor redefinido; reinicie para aplicar." : "Valor redefinido."
          : result.issues.map(({ message }) => message).join(" ");
        setEditorInvalid(editor, !result.applied);
        if (result.applied) renderInspector(options);
      }).catch((error) => {
        setEditorInvalid(editor, true);
        reportError(error, feedback, options);
      });
    });
    row.append(reset);
  }

  editor.onCommit((value) => {
    const commit = requireAppliedInspectorCommit(options.registry.edit(
      section.contribution.id,
      field.schema.id,
      value,
      options.context(),
    ));
    void trackInspectorCommit(options, trackedCommitKey, commit).then((result) => {
      feedback.textContent = result.applied
        ? result.restartRequired ? "Alteração aceita; reinicie para aplicar." : "Alteração aplicada."
        : result.issues.map(({ message }) => message).join(" ");
      setEditorInvalid(editor, !result.applied);
      if (result.applied) renderInspector(options);
    }).catch((error) => {
      setEditorInvalid(editor, true);
      reportError(error, feedback, options);
    });
  });
  return row;
}

function trackInspectorCommit<T>(
  options: SchemaInspectorViewOptions,
  key: string,
  promise: Promise<T>,
): Promise<T> {
  return options.trackCommit?.(key, promise) ?? promise;
}

type InspectorControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface FieldEditor {
  readonly root: HTMLElement;
  readonly controls: readonly InspectorControl[];
  readonly controlParts: readonly string[];
  readonly controlLabels?: readonly string[];
  onCommit(listener: (value: unknown) => void): void;
}

function editorFor(field: ResolvedInspectorField): FieldEditor {
  switch (field.schema.kind) {
    case "bool": return booleanEditor(field);
    case "enum": return enumEditor(field);
    case "string": return stringEditor(field);
    case "color": return colorEditor(field);
    case "vector": return vectorEditor(field);
    case "asset-reference":
    case "entity-reference": return referenceEditor(field);
    case "int":
    case "float": return numberEditor(field);
  }
}

function numberEditor(field: ResolvedInspectorField): FieldEditor {
  const schema = field.schema.kind === "int" || field.schema.kind === "float" ? field.schema : undefined;
  const input = document.createElement("input");
  input.type = "number";
  if (schema?.range?.min !== undefined) input.min = String(schema.range.min);
  if (schema?.range?.max !== undefined) input.max = String(schema.range.max);
  input.step = String(schema?.range?.step ?? (schema?.kind === "int" ? 1 : "any"));
  if (!field.mixed && typeof field.value === "number") input.value = String(field.value);
  else input.placeholder = "Vários valores";
  return commitOnChange(input, () => input.valueAsNumber);
}

function booleanEditor(field: ResolvedInspectorField): FieldEditor {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = field.value === true;
  input.indeterminate = field.mixed;
  return commitOnChange(input, () => input.checked);
}

function enumEditor(field: ResolvedInspectorField): FieldEditor {
  const select = document.createElement("select");
  if (field.mixed) {
    const mixed = document.createElement("option");
    mixed.textContent = "— Vários valores —";
    mixed.value = "";
    select.append(mixed);
  }
  const schema = field.schema.kind === "enum" ? field.schema : undefined;
  for (const option of schema?.options ?? []) {
    const element = document.createElement("option");
    element.value = JSON.stringify(option.value);
    element.textContent = option.label;
    element.title = option.description ?? "";
    element.selected = !field.mixed && Object.is(option.value, field.value);
    select.append(element);
  }
  return commitOnChange(select, () => JSON.parse(select.value) as unknown);
}

function stringEditor(field: ResolvedInspectorField): FieldEditor {
  const schema = field.schema.kind === "string" ? field.schema : undefined;
  const input = schema?.multiline ? document.createElement("textarea") : document.createElement("input");
  if (input instanceof HTMLInputElement) input.type = "text";
  if (!field.mixed && typeof field.value === "string") input.value = field.value;
  else input.placeholder = "Vários valores";
  if (schema?.minLength !== undefined) input.minLength = schema.minLength;
  if (schema?.maxLength !== undefined) input.maxLength = schema.maxLength;
  if (schema?.pattern && input instanceof HTMLInputElement) input.pattern = schema.pattern;
  return commitOnChange(input, () => input.value);
}

function colorEditor(field: ResolvedInspectorField): FieldEditor {
  const wrapper = document.createElement("span");
  wrapper.className = "color-editor";
  const input = document.createElement("input");
  input.type = "color";
  const text = document.createElement("input");
  text.type = "text";
  const value = typeof field.value === "string" ? field.value.slice(0, 7) : "#000000";
  input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  text.value = field.mixed ? "" : typeof field.value === "string" ? field.value : value;
  text.placeholder = field.mixed ? "Várias cores" : "#RRGGBB";
  wrapper.append(input, text);
  return {
    root: wrapper,
    controls: [input, text],
    controlParts: ["visual", "text"],
    controlLabels: ["Seletor visual", "Valor textual"],
    onCommit(listener): void {
      input.addEventListener("change", () => { text.value = input.value; listener(input.value); });
      text.addEventListener("change", () => listener(text.value));
    },
  };
}

function vectorEditor(field: ResolvedInspectorField): FieldEditor {
  const wrapper = document.createElement("span");
  wrapper.className = "vector-editor";
  const schema = field.schema.kind === "vector" ? field.schema : undefined;
  const values = Array.isArray(field.value) ? field.value : [];
  const inputs: HTMLInputElement[] = [];
  for (let index = 0; index < (schema?.dimensions ?? 2); index++) {
    const component = document.createElement("label");
    component.textContent = schema?.componentLabels?.[index] ?? String(index + 1);
    const input = document.createElement("input");
    input.type = "number";
    input.step = String(schema?.componentRanges?.[index]?.step ?? schema?.range?.step ?? "any");
    const range = schema?.componentRanges?.[index] ?? schema?.range;
    if (range?.min !== undefined) input.min = String(range.min);
    if (range?.max !== undefined) input.max = String(range.max);
    if (!field.mixed && typeof values[index] === "number") input.value = String(values[index]);
    component.append(input);
    wrapper.append(component);
    inputs.push(input);
  }
  return {
    root: wrapper,
    controls: inputs,
    controlParts: inputs.map((_input, index) => `component-${index}`),
    controlLabels: inputs.map(
      (_input, index) => schema?.componentLabels?.[index] ?? `Componente ${index + 1}`,
    ),
    onCommit(listener): void {
      inputs.forEach((input) => input.addEventListener("change", () =>
        listener(inputs.map((candidate) => candidate.valueAsNumber))));
    },
  };
}

function referenceEditor(field: ResolvedInspectorField): FieldEditor {
  const input = document.createElement("input");
  input.type = "text";
  if (!field.mixed && typeof field.value === "string") input.value = field.value;
  else input.placeholder = field.mixed ? "Várias referências" : "Nenhuma";
  return commitOnChange(input, () => input.value.trim() || null);
}

function commitOnChange<T extends InspectorControl>(root: T, value: () => unknown): FieldEditor {
  return {
    root,
    controls: [root],
    controlParts: ["value"],
    onCommit(listener): void {
      root.addEventListener("change", () => listener(value()));
    },
  };
}

function configureEditorLabels(
  editor: FieldEditor,
  section: ResolvedInspectorSection,
  field: ResolvedInspectorField,
  inputId: string,
  labelText: HTMLElement,
): void {
  const composite = editor.controls.length > 1 || editor.root !== editor.controls[0];
  editor.controls.forEach((control, index) => {
    const part = editor.controlParts[index] ?? `control-${index}`;
    control.id = composite ? `${inputId}-${safeId(part)}` : inputId;
    control.dataset["inspectorFocusKey"] = schemaInspectorFocusKey(
      section.contribution.id,
      field.schema.id,
      part,
    );
    if (composite) {
      const partLabel = editor.controlLabels?.[index] ?? `Controle ${index + 1}`;
      control.setAttribute("aria-label", `${field.schema.label}: ${partLabel}`);
    }
  });
  if (composite) editor.root.setAttribute("aria-labelledby", labelText.id);
}

function setEditorAccessibility(
  editor: FieldEditor,
  describedBy: string,
  invalid: boolean,
  enabled: boolean,
  description: string | undefined,
): void {
  for (const control of editor.controls) {
    control.setAttribute("aria-describedby", describedBy);
    control.setAttribute("aria-invalid", String(invalid));
    control.disabled = !enabled;
    control.setAttribute("aria-disabled", String(!enabled));
    if (description) control.title = description;
  }
  editor.root.setAttribute("aria-disabled", String(!enabled));
  if (description) editor.root.title = description;
}

function setEditorInvalid(editor: FieldEditor, invalid: boolean): void {
  for (const control of editor.controls) {
    control.setAttribute("aria-invalid", String(invalid));
  }
}

/** Chave opaca e sem colisão por delimitador para restaurar foco após rerender. */
export function schemaInspectorFocusKey(
  contributionId: string,
  fieldId: string,
  part: string,
): string {
  return JSON.stringify([contributionId, fieldId, part]);
}

/** Identidade de commit inclui sessão e seleção; falhas de A não são limpas por B. */
export function schemaInspectorCommitKey(
  contributionId: string,
  fieldId: string,
  context: ContributionContext,
): string {
  return JSON.stringify([
    context.selection.projectSessionId ?? null,
    contributionId,
    fieldId,
    semanticSelectionSetIdentityKey(context.selection.selections),
  ]);
}

export class InspectorCommitRejectedError extends Error {
  readonly result: InspectorApplyResult;

  constructor(result: InspectorApplyResult) {
    super(result.issues.map(({ message }) => message).join(" ") || "A alteração foi rejeitada pelo Inspector.");
    this.name = "InspectorCommitRejectedError";
    this.result = result;
  }
}

/** Converte validação recusada em falha durável para o boundary de Save/Close. */
export async function requireAppliedInspectorCommit(
  operation: Promise<InspectorApplyResult>,
): Promise<InspectorApplyResult> {
  const result = await operation;
  if (!result.applied) throw new InspectorCommitRejectedError(result);
  return result;
}

interface SemanticFocusSnapshot {
  readonly key: string;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
  readonly selectionDirection?: "forward" | "backward" | "none";
}

function captureSemanticFocus(host: HTMLElement): SemanticFocusSnapshot | undefined {
  const active = host.ownerDocument.activeElement;
  if (!isFocusableHtmlElement(active) || !host.contains(active)) return undefined;
  const key = active.dataset["inspectorFocusKey"];
  if (!key) return undefined;
  const selection = textSelectionOf(active);
  return {
    key,
    ...(selection ?? {}),
  };
}

function restoreSemanticFocus(
  host: HTMLElement,
  snapshot: SemanticFocusSnapshot | undefined,
): void {
  if (!snapshot) return;
  const target = Array.from(
    host.querySelectorAll<HTMLElement>("[data-inspector-focus-key]"),
  ).find((candidate) => candidate.dataset["inspectorFocusKey"] === snapshot.key);
  if (!target) return;
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
  if (
    snapshot.selectionStart !== undefined &&
    snapshot.selectionEnd !== undefined &&
    "setSelectionRange" in target &&
    typeof target.setSelectionRange === "function"
  ) {
    try {
      target.setSelectionRange(
        snapshot.selectionStart,
        snapshot.selectionEnd,
        snapshot.selectionDirection,
      );
    } catch {
      // Tipos como color/number não suportam seleção textual; foco já foi restaurado.
    }
  }
}

function isFocusableHtmlElement(value: Element | null): value is HTMLElement {
  return value !== null && "dataset" in value && typeof (value as HTMLElement).focus === "function";
}

function textSelectionOf(element: HTMLElement): Omit<SemanticFocusSnapshot, "key"> | undefined {
  if (!("selectionStart" in element) || !("selectionEnd" in element)) return undefined;
  try {
    const selectionStart = (element as HTMLInputElement | HTMLTextAreaElement).selectionStart;
    const selectionEnd = (element as HTMLInputElement | HTMLTextAreaElement).selectionEnd;
    if (selectionStart === null || selectionEnd === null) return undefined;
    const direction = (element as HTMLInputElement | HTMLTextAreaElement).selectionDirection;
    return {
      selectionStart,
      selectionEnd,
      ...(direction ? { selectionDirection: direction } : {}),
    };
  } catch {
    return undefined;
  }
}

function reasonText(reason: string): HTMLElement {
  const paragraph = document.createElement("p");
  paragraph.className = "contribution-reason";
  paragraph.textContent = reason;
  return paragraph;
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-");
}

function reportError(
  error: unknown,
  feedback: HTMLElement,
  options: SchemaInspectorViewOptions,
): void {
  feedback.textContent = error instanceof Error ? error.message : String(error);
  options.onError?.(error);
}
