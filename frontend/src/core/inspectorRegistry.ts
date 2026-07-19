import {
  ContributionUnavailableError,
  evaluateCapabilities,
  type ContributionAvailability,
} from "./capabilityRegistry.js";
import type { ContributionContext } from "./contributionContext.js";
import type { Selection, SelectionKind } from "./selectionService.js";

export type InspectorFieldKind =
  | "int"
  | "float"
  | "bool"
  | "enum"
  | "string"
  | "color"
  | "vector"
  | "asset-reference"
  | "entity-reference";

export type InspectorApplyMode = "immediate" | "restart";

export interface UnitDescriptor {
  readonly symbol: string;
  readonly label: string;
  readonly system?: "world" | "cell" | "pixel" | "angle" | "time" | string;
}

export interface NumericRange {
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface InspectorValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: "warning" | "error";
}

/** O conjunto de multi-edit vem exclusivamente do SelectionService. */
export interface InspectorContext extends ContributionContext {}

export interface InspectorFieldContext {
  readonly inspector: InspectorContext;
  readonly field: InspectorFieldSchema;
}

interface InspectorFieldBase<K extends InspectorFieldKind, TValue> {
  readonly id: string;
  /** Caminho semântico no modelo; não implica mutação direta pelo renderer. */
  readonly path: string;
  readonly kind: K;
  readonly label: string;
  readonly description?: string;
  readonly requiredCapabilities?: readonly string[];
  readonly unit?: UnitDescriptor;
  readonly defaultValue?: TValue;
  /** `true` usa defaultValue; callback deriva o reset do contexto corrente. */
  readonly reset?: boolean | ((context: InspectorFieldContext) => TValue);
  readonly readOnly?: boolean | ((context: InspectorFieldContext) => boolean);
  readonly multiEdit?: boolean;
  readonly applyMode: InspectorApplyMode;
  readonly visibleWhen?: (context: InspectorFieldContext) => boolean;
  readonly validate?: (
    value: TValue,
    context: InspectorFieldContext,
  ) => InspectorValidationIssue | readonly InspectorValidationIssue[] | undefined;
}

export interface IntegerInspectorField extends InspectorFieldBase<"int", number> {
  readonly range?: NumericRange;
}

export interface FloatInspectorField extends InspectorFieldBase<"float", number> {
  readonly range?: NumericRange;
  readonly precision?: number;
}

export interface BooleanInspectorField extends InspectorFieldBase<"bool", boolean> {}

export interface EnumOption {
  readonly value: string | number;
  readonly label: string;
  readonly description?: string;
}

export interface EnumInspectorField extends InspectorFieldBase<"enum", string | number> {
  readonly options: readonly EnumOption[];
}

export interface StringInspectorField extends InspectorFieldBase<"string", string> {
  readonly multiline?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Expressão regular serializável, sem delimitadores. */
  readonly pattern?: string;
}

export interface ColorValue {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

export interface ColorInspectorField extends InspectorFieldBase<"color", string | ColorValue> {
  readonly format?: "hex" | "srgb" | "linear";
  readonly alpha?: boolean;
}

export interface VectorInspectorField extends InspectorFieldBase<"vector", readonly number[]> {
  readonly dimensions: 2 | 3 | 4;
  readonly componentLabels?: readonly string[];
  readonly range?: NumericRange;
  readonly componentRanges?: readonly NumericRange[];
}

export interface AssetReferenceInspectorField extends InspectorFieldBase<"asset-reference", string | null> {
  readonly assetTypes?: readonly string[];
  readonly allowNone?: boolean;
}

export interface EntityReferenceInspectorField extends InspectorFieldBase<"entity-reference", string | null> {
  readonly definitionIds?: readonly string[];
  readonly allowNone?: boolean;
}

export type InspectorFieldSchema =
  | IntegerInspectorField
  | FloatInspectorField
  | BooleanInspectorField
  | EnumInspectorField
  | StringInspectorField
  | ColorInspectorField
  | VectorInspectorField
  | AssetReferenceInspectorField
  | EntityReferenceInspectorField;

export interface InspectorEdit {
  readonly contributionId: string;
  readonly fieldId: string;
  readonly path: string;
  readonly selections: readonly Selection[];
  readonly previousValues: readonly unknown[];
  readonly value: unknown;
  readonly applyMode: InspectorApplyMode;
}

export interface InspectorContribution {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly requiredCapabilities: readonly string[];
  readonly supportedSelections: readonly SelectionKind[];
  readonly visibleWhen?: (context: InspectorContext) => boolean;
  readonly fields: readonly InspectorFieldSchema[]
    | ((context: InspectorContext) => readonly InspectorFieldSchema[]);
  read(selection: Selection, field: InspectorFieldSchema, context: InspectorContext): unknown;
  apply?(edit: InspectorEdit, context: InspectorContext): void | Promise<void>;
}

export interface ResolvedInspectorField extends ContributionAvailability {
  readonly schema: InspectorFieldSchema;
  readonly value: unknown;
  readonly values: readonly unknown[];
  readonly mixed: boolean;
  readonly readOnly: boolean;
  readonly canReset: boolean;
  readonly issues: readonly InspectorValidationIssue[];
}

export interface ResolvedInspectorSection extends ContributionAvailability {
  readonly contribution: InspectorContribution;
  readonly fields: readonly ResolvedInspectorField[];
}

export interface InspectorResolveOptions {
  readonly includeHidden?: boolean;
  readonly includeDisabled?: boolean;
}

export interface InspectorApplyResult {
  readonly applied: boolean;
  readonly issues: readonly InspectorValidationIssue[];
  readonly applyMode: InspectorApplyMode;
  readonly restartRequired: boolean;
}

export class InspectorRegistry {
  private readonly contributions = new Map<string, InspectorContribution>();
  private readonly listeners = new Set<() => void>();

  register(contribution: InspectorContribution): () => void {
    assertInspectorContribution(contribution);
    if (this.contributions.has(contribution.id)) {
      throw new Error(`Inspector contribution “${contribution.id}” is already registered.`);
    }
    this.contributions.set(contribution.id, contribution);
    this.notify();
    return () => {
      if (this.contributions.get(contribution.id) !== contribution) return;
      this.contributions.delete(contribution.id);
      this.notify();
    };
  }

  get(id: string): InspectorContribution | undefined {
    return this.contributions.get(id);
  }

  resolve(
    context: InspectorContext,
    options: InspectorResolveOptions = {},
  ): ResolvedInspectorSection[] {
    return [...this.contributions.values()]
      .map((contribution) => this.resolveContribution(contribution, context))
      .filter((section) => options.includeHidden || section.visible)
      .filter((section) => options.includeDisabled !== false || section.enabled)
      .sort(compareInspectorSections);
  }

  async edit(
    contributionId: string,
    fieldId: string,
    value: unknown,
    context: InspectorContext,
  ): Promise<InspectorApplyResult> {
    const section = this.requireSection(contributionId, context);
    const field = section.fields.find(({ schema }) => schema.id === fieldId);
    if (!field) throw new Error(`Unknown inspector field “${fieldId}” in “${contributionId}”.`);

    if (!field.enabled) {
      return invalidApply(field.schema.applyMode, "field-unavailable", field.reason ?? "Campo indisponível.");
    }
    const issues = validateInspectorValue(field.schema, value, {
      inspector: context,
      field: field.schema,
    });
    if (issues.some(({ severity }) => severity === "error")) {
      return {
        applied: false,
        issues,
        applyMode: field.schema.applyMode,
        restartRequired: false,
      };
    }
    if (!section.contribution.apply) {
      return invalidApply(field.schema.applyMode, "read-only-section", "Esta seção é somente leitura.");
    }

    await section.contribution.apply({
      contributionId,
      fieldId,
      path: field.schema.path,
      selections: context.selection.selections,
      previousValues: field.values,
      value,
      applyMode: field.schema.applyMode,
    }, context);
    return {
      applied: true,
      issues,
      applyMode: field.schema.applyMode,
      restartRequired: field.schema.applyMode === "restart",
    };
  }

  async reset(
    contributionId: string,
    fieldId: string,
    context: InspectorContext,
  ): Promise<InspectorApplyResult> {
    const section = this.requireSection(contributionId, context);
    const field = section.fields.find(({ schema }) => schema.id === fieldId);
    if (!field) throw new Error(`Unknown inspector field “${fieldId}” in “${contributionId}”.`);
    if (!field.canReset) {
      return invalidApply(field.schema.applyMode, "reset-unavailable", "Este campo não possui valor de reset.");
    }
    const reset = field.schema.reset;
    const value = typeof reset === "function"
      ? reset({ inspector: context, field: field.schema })
      : field.schema.defaultValue;
    return this.edit(contributionId, fieldId, value, context);
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private resolveContribution(
    contribution: InspectorContribution,
    context: InspectorContext,
  ): ResolvedInspectorSection {
    const capability = evaluateCapabilities(contribution.requiredCapabilities, context.capabilities);
    const selections = context.selection.selections;
    const selectionSupported = selections.length > 0
      && selections.every(({ kind }) => contribution.supportedSelections.includes(kind));
    const visible = selectionSupported && (contribution.visibleWhen?.(context) ?? true);
    let fields = materializeFields(contribution, context)
      .map((field) => resolveField(contribution, field, context))
      .filter((field) => field.visible);
    if (!capability.enabled) {
      fields = fields.map((field) => ({
        ...field,
        enabled: false,
        ...(capability.reason ? { reason: capability.reason } : {}),
        missingCapabilities: [
          ...new Set([...field.missingCapabilities, ...capability.missingCapabilities]),
        ],
      }));
    }
    return {
      contribution,
      fields,
      visible,
      enabled: visible && capability.enabled,
      ...(!selectionSupported
        ? { reason: "O inspector não se aplica à seleção atual." }
        : capability.reason
          ? { reason: capability.reason }
          : {}),
      missingCapabilities: capability.missingCapabilities,
    };
  }

  private requireSection(id: string, context: InspectorContext): ResolvedInspectorSection {
    const contribution = this.contributions.get(id);
    if (!contribution) throw new Error(`Unknown inspector contribution “${id}”.`);
    const section = this.resolveContribution(contribution, context);
    if (!section.enabled) {
      throw new ContributionUnavailableError(
        id,
        section.reason ?? "O inspector não está disponível.",
        section.missingCapabilities,
      );
    }
    return section;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function materializeFields(
  contribution: InspectorContribution,
  context: InspectorContext,
): readonly InspectorFieldSchema[] {
  return typeof contribution.fields === "function" ? contribution.fields(context) : contribution.fields;
}

function resolveField(
  contribution: InspectorContribution,
  field: InspectorFieldSchema,
  context: InspectorContext,
): ResolvedInspectorField {
  const fieldContext: InspectorFieldContext = { inspector: context, field };
  const capability = evaluateCapabilities(field.requiredCapabilities ?? [], context.capabilities);
  const visible = field.visibleWhen?.(fieldContext) ?? true;
  const readOnly = typeof field.readOnly === "function" ? field.readOnly(fieldContext) : (field.readOnly ?? false);
  const selections = context.selection.selections;
  const multiBlocked = selections.length > 1 && field.multiEdit !== true;
  const values = selections.map((selection) => contribution.read(selection, field, context));
  const mixed = values.some((value) => !sameValue(value, values[0]));
  const issues = mixed ? [] : validateInspectorValue(field, values[0], fieldContext);
  const reason = capability.reason
    ?? (readOnly ? "Campo somente leitura." : undefined)
    ?? (multiBlocked ? "O campo não permite edição múltipla." : undefined);
  return {
    schema: field,
    value: values[0],
    values,
    mixed,
    readOnly,
    canReset: field.reset !== false
      && (field.reset === true || typeof field.reset === "function" || field.defaultValue !== undefined),
    issues,
    visible,
    enabled: visible && capability.enabled && !readOnly && !multiBlocked,
    ...(reason ? { reason } : {}),
    missingCapabilities: capability.missingCapabilities,
  };
}

export function validateInspectorValue(
  field: InspectorFieldSchema,
  value: unknown,
  context: InspectorFieldContext,
): InspectorValidationIssue[] {
  const issues = validateBuiltIn(field, value);
  if (issues.some(({ severity }) => severity === "error")) return issues;
  if (field.validate) {
    // O narrowing do discriminante não preserva a correlação de TValue ao
    // acessar a função pelo union; a validação estrutural acima garante o valor.
    const custom = (field.validate as (
      candidate: unknown,
      fieldContext: InspectorFieldContext,
    ) => InspectorValidationIssue | readonly InspectorValidationIssue[] | undefined)(value, context);
    if (custom) issues.push(...(Array.isArray(custom) ? custom : [custom]));
  }
  return issues;
}

function validateBuiltIn(field: InspectorFieldSchema, value: unknown): InspectorValidationIssue[] {
  switch (field.kind) {
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) return error("integer", "Informe um número inteiro.");
      return validateRange(value, field.range);
    case "float":
      if (typeof value !== "number" || !Number.isFinite(value)) return error("number", "Informe um número válido.");
      return validateRange(value, field.range);
    case "bool":
      return typeof value === "boolean" ? [] : error("boolean", "Escolha verdadeiro ou falso.");
    case "enum":
      return field.options.some((option) => Object.is(option.value, value))
        ? []
        : error("enum", "Escolha uma das opções disponíveis.");
    case "string": {
      if (typeof value !== "string") return error("string", "Informe um texto.");
      if (field.minLength !== undefined && value.length < field.minLength) {
        return error("min-length", `Use pelo menos ${field.minLength} caracteres.`);
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return error("max-length", `Use no máximo ${field.maxLength} caracteres.`);
      }
      if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
        return error("pattern", "O valor não corresponde ao formato esperado.");
      }
      return [];
    }
    case "color":
      return isColor(value, field.alpha ?? true) ? [] : error("color", "Informe uma cor válida.");
    case "vector": {
      if (!Array.isArray(value) || value.length !== field.dimensions
        || value.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
        return error("vector", `Informe um vetor com ${field.dimensions} componentes numéricos.`);
      }
      const issues: InspectorValidationIssue[] = [];
      for (let index = 0; index < value.length; index++) {
        const range = field.componentRanges?.[index] ?? field.range;
        issues.push(...validateRange(value[index]!, range, `component-${index}`));
      }
      return issues;
    }
    case "asset-reference":
      return validateReference(value, field.allowNone, "asset");
    case "entity-reference":
      return validateReference(value, field.allowNone, "entity");
  }
}

function validateRange(value: number, range: NumericRange | undefined, prefix = "range"): InspectorValidationIssue[] {
  if (range?.min !== undefined && value < range.min) {
    return error(`${prefix}-min`, `O valor mínimo é ${range.min}.`);
  }
  if (range?.max !== undefined && value > range.max) {
    return error(`${prefix}-max`, `O valor máximo é ${range.max}.`);
  }
  return [];
}

function validateReference(
  value: unknown,
  allowNone: boolean | undefined,
  kind: "asset" | "entity",
): InspectorValidationIssue[] {
  if (value === null && allowNone) return [];
  if (typeof value === "string" && value.trim().length > 0) return [];
  return error(`${kind}-reference`, "Selecione uma referência válida.");
}

function isColor(value: unknown, allowAlpha: boolean): boolean {
  if (typeof value === "string") {
    return allowAlpha
      ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)
      : /^#[0-9a-f]{6}$/i.test(value);
  }
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ColorValue>;
  const components = [candidate.r, candidate.g, candidate.b, ...(candidate.a === undefined ? [] : [candidate.a])];
  return components.every((component) =>
    typeof component === "number" && Number.isFinite(component) && component >= 0 && component <= 1)
    && (allowAlpha || candidate.a === undefined);
}

function error(code: string, message: string): InspectorValidationIssue[] {
  return [{ code, message, severity: "error" }];
}

function invalidApply(
  applyMode: InspectorApplyMode,
  code: string,
  message: string,
): InspectorApplyResult {
  return {
    applied: false,
    issues: error(code, message),
    applyMode,
    restartRequired: false,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertInspectorContribution(contribution: InspectorContribution): void {
  if (!contribution.id.trim()) throw new Error("Inspector contribution id must not be empty.");
  if (!contribution.label.trim()) {
    throw new Error(`Inspector contribution “${contribution.id}” must have a label.`);
  }
  if (contribution.supportedSelections.length === 0) {
    throw new Error(`Inspector contribution “${contribution.id}” must support at least one selection kind.`);
  }
  if (typeof contribution.fields !== "function") {
    const ids = new Set<string>();
    for (const field of contribution.fields) {
      if (ids.has(field.id)) throw new Error(`Duplicate inspector field “${field.id}”.`);
      ids.add(field.id);
    }
  }
}

function compareInspectorSections(
  left: ResolvedInspectorSection,
  right: ResolvedInspectorSection,
): number {
  return (left.contribution.order ?? 0) - (right.contribution.order ?? 0)
    || left.contribution.label.localeCompare(right.contribution.label, "pt-BR")
    || left.contribution.id.localeCompare(right.contribution.id);
}
