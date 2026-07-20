/**
 * Serviço de pipeline de assets (escopo original, Subsistema 4): o catálogo
 * taxonômico é monitorado; um `.aseprite` novo/alterado dispara a exportação
 * via CLI do Aseprite, a normalização canônica (pipeline `aseprite-import` →
 * artefato versionável) e a compilação MGCB do spritesheet para `.xnb`.
 *
 * As ferramentas externas entram por um `ToolRunner` INJETÁVEL — os testes
 * usam um runner falso que materializa as saídas, então toda a orquestração
 * é verificada sem os binários. A taxonomia (tags) deriva da estrutura de
 * diretórios sob a raiz de assets (LDtk/painel taxonômico:
 * `characters/hero.aseprite` → tags ["characters"]).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactEnvelope } from "../canonical/ArtifactStore.js";
import type { HookBus } from "../canonical/HookBus.js";
import {
  ASEPRITE_PIPELINE,
  PipelineCancelledError,
  type PipelineRunner,
} from "../canonical/Pipeline.js";
import type { SpriteDocument } from "./AsepriteImporter.js";

const MAX_EXPORTED_METADATA_BYTES = 16 * 1024 * 1024;

export interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ToolRunOptions {
  readonly signal?: AbortSignal;
}

/** Executor de ferramentas externas — injetável (fake nos testes). */
export interface ToolRunner {
  run(command: string, args: readonly string[], options?: ToolRunOptions): Promise<ToolResult>;
}

/** Runner real via execFile (sem shell — argumentos nunca são interpretados). */
export class ExecToolRunner implements ToolRunner {
  run(command: string, args: readonly string[], options: ToolRunOptions = {}): Promise<ToolResult> {
    return new Promise((resolve) => {
      execFile(command, [...args], {
        maxBuffer: 16 * 1024 * 1024,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }, (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          // exit code numérico quando o processo rodou; 127 para comando ausente
          code = typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : 127;
        }
        resolve({ code, stdout, stderr });
      });
    });
  }
}

export class AssetToolError extends Error {
  constructor(
    readonly tool: string,
    readonly exitCode: number,
    stderr: string,
    readonly context: {
      readonly stage?: AssetIngestStage;
      readonly filePath?: string;
      readonly suggestedActions?: readonly string[];
    } = {},
  ) {
    super(`${tool} exited with code ${exitCode}: ${stderr.trim() || "(no stderr)"}`);
    this.name = "AssetToolError";
    this.stderr = stderr;
  }

  readonly stderr: string;

  get stage(): AssetIngestStage | undefined {
    return this.context.stage;
  }

  get filePath(): string | undefined {
    return this.context.filePath;
  }

  get suggestedActions(): readonly string[] {
    return this.context.suggestedActions ?? [];
  }
}

export class AssetPipelineCancelledError extends Error {
  constructor(
    readonly stage: AssetIngestStage,
    readonly filePath: string,
  ) {
    super(`Asset ingest was cancelled during ${stage}`);
    this.name = "AssetPipelineCancelledError";
  }
}

export interface AssetToolPaths {
  readonly asepritePath?: string;
  readonly mgcbPath?: string;
}

export type AssetIngestStage =
  | "validating"
  | "exporting"
  | "normalizing"
  | "compiling"
  | "completed";

export interface AssetIngestProgress {
  readonly stage: AssetIngestStage;
  readonly current: number;
  readonly total: number;
  readonly message: string;
}

export interface AssetToolDetection {
  readonly path: string;
  readonly available: true;
  readonly version?: string;
  readonly message: string;
}

export interface AssetToolDetectionResult {
  readonly aseprite: AssetToolDetection;
  readonly mgcb: AssetToolDetection;
}

export interface AssetIngestOptions {
  readonly signal?: AbortSignal;
  readonly tags?: readonly string[];
  /** False quando a camada de aplicacao ja resolveu taxonomia logica. */
  readonly deriveTags?: boolean;
  /** Namespace interno opcional; a camada de aplicacao usa projectId estavel. */
  readonly artifactId?: string;
  /** Fonte escolhida pelo usuario quando `filePath` e uma copia gerenciada. */
  readonly originSource?: string;
  readonly tools?: AssetToolPaths;
  readonly onProgress?: (progress: AssetIngestProgress) => void;
  /** Persistencia transacional da aplicacao antes de publicar ArtifactStore/hooks. */
  readonly beforePublish?: (candidate: AssetIngestCandidate) => void | Promise<void>;
}

export interface AssetPipelineOptions {
  /** Raiz do catálogo taxonômico de assets. */
  readonly assetsRoot: string;
  /** Raiz das saídas geradas (spritesheets, json, xnb). */
  readonly outputRoot: string;
  readonly runner: ToolRunner;
  readonly pipelines: PipelineRunner;
  readonly hooks: HookBus;
  readonly asepriteCommand?: string;
  readonly mgcbCommand?: string;
  readonly mgcbPlatform?: string;
}

export type AssetIngestResult =
  | {
      readonly status: "ingested";
      readonly artifactId: string;
      readonly revision: number;
      readonly tags: readonly string[];
      readonly spritesheetPng: string;
      readonly metadataJson: string;
      readonly compiledXnb: string;
      readonly clipCount: number;
    }
  | { readonly status: "ignored"; readonly reason: string };

export interface AssetIngestCandidate {
  readonly artifact: ArtifactEnvelope;
  readonly artifactId: string;
  readonly revision: number;
  readonly tags: readonly string[];
  readonly spritesheetPng: string;
  readonly metadataJson: string;
  readonly compiledXnb: string;
  readonly clipCount: number;
}

export class AssetPipelineService {
  private readonly options: Required<Pick<AssetPipelineOptions, "asepriteCommand" | "mgcbCommand" | "mgcbPlatform">> &
    AssetPipelineOptions;
  private watcher: fs.FSWatcher | undefined;

  constructor(options: AssetPipelineOptions) {
    const roots = validateAssetRoots(options.assetsRoot, options.outputRoot);
    this.options = {
      asepriteCommand: "aseprite",
      mgcbCommand: "mgcb",
      mgcbPlatform: "DesktopGL",
      ...options,
      assetsRoot: roots.assetsRoot,
      outputRoot: roots.outputRoot,
    };
  }

  get assetsRoot(): string {
    return path.resolve(this.options.assetsRoot);
  }

  get outputRoot(): string {
    return path.resolve(this.options.outputRoot);
  }

  get defaultTools(): Readonly<{ asepritePath: string; mgcbPath: string }> {
    return Object.freeze({
      asepritePath: this.options.asepriteCommand,
      mgcbPath: this.options.mgcbCommand,
    });
  }

  /** Tags derivadas dos diretórios sob a raiz (`characters/boss/x.ase` → [characters, boss]). */
  deriveTags(filePath: string): string[] {
    this.assertSourcePath(filePath);
    const relative = path.relative(this.options.assetsRoot, filePath);
    const segments = relative.split(path.sep);
    return segments.slice(0, -1).filter((s) => s.length > 0 && s !== "..");
  }

  /** Id canônico do artefato: caminho relativo POSIX sem extensão. */
  artifactIdFor(filePath: string): string {
    this.assertSourcePath(filePath);
    const relative = path.relative(this.options.assetsRoot, filePath);
    const withoutExt = relative.slice(0, relative.length - path.extname(relative).length);
    return `assets/${withoutExt.split(path.sep).join("/")}`;
  }

  /**
   * Processa um arquivo do catálogo: exporta (Aseprite CLI), normaliza
   * (pipeline canônico → artefato) e compila (MGCB → .xnb).
   */
  async ingest(filePath: string, options: AssetIngestOptions = {}): Promise<AssetIngestResult> {
    this.assertSourcePath(filePath);
    throwIfCancelled(options.signal, "validating", filePath);
    emitProgress(options.onProgress, "validating", 0, 4, `Validating ${path.basename(filePath)}`);
    const extension = path.extname(filePath).toLowerCase();
    if (extension !== ".aseprite" && extension !== ".ase") {
      return { status: "ignored", reason: `extension "${extension}" is not an Aseprite source` };
    }

    const relative = path.relative(this.options.assetsRoot, filePath);
    const baseOut = path.join(this.options.outputRoot, relative.slice(0, relative.length - extension.length));
    const sheetPng = `${baseOut}.png`;
    const dataJson = `${baseOut}.json`;
    ensureContainedDirectory(this.outputRoot, path.dirname(sheetPng));

    // 1. Exportação: spritesheet + metadados (frameTags, slices, durações)
    throwIfCancelled(options.signal, "exporting", filePath);
    emitProgress(options.onProgress, "exporting", 1, 4, "Exporting spritesheet with Aseprite");
    const asepritePath = options.tools?.asepritePath ?? this.options.asepriteCommand;
    const exportResult = await this.options.runner.run(asepritePath, [
      "-b",
      filePath,
      "--sheet",
      sheetPng,
      "--data",
      dataJson,
      "--format",
      "json-hash",
      "--list-tags",
      "--list-slices",
    ], options.signal !== undefined ? { signal: options.signal } : undefined);
    throwIfCancelled(options.signal, "exporting", filePath);
    if (exportResult.code !== 0) {
      throw new AssetToolError("aseprite", exportResult.code, exportResult.stderr, {
        stage: "exporting",
        filePath,
        suggestedActions: [
          "Verify the configured Aseprite executable",
          "Open the source in Aseprite and validate it",
        ],
      });
    }
    if (!isSafeRegularFile(dataJson, this.outputRoot, 1, MAX_EXPORTED_METADATA_BYTES)) {
      throw new AssetToolError("aseprite", 0, `export did not produce safe, bounded metadata at ${dataJson}`, {
        stage: "exporting",
        filePath,
        suggestedActions: ["Verify Aseprite CLI output, size, permissions and arguments"],
      });
    }
    if (!isValidPng(sheetPng, this.outputRoot)) {
      throw new AssetToolError("aseprite", 0, `export did not produce a valid PNG at ${sheetPng}`, {
        stage: "exporting",
        filePath,
        suggestedActions: ["Verify Aseprite CLI output and write permissions"],
      });
    }

    // 2. Normalização canônica → artefato versionável com taxonomia
    throwIfCancelled(options.signal, "normalizing", filePath);
    emitProgress(options.onProgress, "normalizing", 2, 4, "Normalizing sprite metadata");
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(dataJson, "utf8"));
    } catch (error) {
      throw new AssetToolError("aseprite", 0, `invalid export metadata: ${errorMessage(error)}`, {
        stage: "normalizing",
        filePath,
        suggestedActions: ["Re-export the source and inspect the Aseprite JSON output"],
      });
    }
    const tags = uniqueTags([
      ...(options.deriveTags === false ? [] : this.deriveTags(filePath)),
      ...(options.tags ?? []),
    ]);
    const artifactId = options.artifactId ?? this.artifactIdFor(filePath);
    let prepared: Awaited<ReturnType<PipelineRunner["prepare"]>>;
    try {
      prepared = await this.options.pipelines.prepare(ASEPRITE_PIPELINE.pipelineId, raw, {
        artifactId,
        tags,
        source: options.originSource ?? filePath,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof PipelineCancelledError || options.signal?.aborted) {
        throw new AssetPipelineCancelledError("normalizing", filePath);
      }
      throw error;
    }

    // 3. Compilação MGCB do spritesheet para .xnb nativo
    throwIfCancelled(options.signal, "compiling", filePath);
    emitProgress(options.onProgress, "compiling", 3, 4, "Compiling spritesheet with MGCB");
    const relativeWithoutExtension = relative.slice(0, relative.length - extension.length);
    const xnbDir = path.join(
      this.options.outputRoot,
      "compiled",
      path.dirname(relativeWithoutExtension),
    );
    ensureContainedDirectory(this.outputRoot, xnbDir);
    const intermediateDir = path.join(
      this.options.outputRoot,
      "obj",
      path.dirname(relativeWithoutExtension),
    );
    ensureContainedDirectory(this.outputRoot, intermediateDir);
    const mgcbPath = options.tools?.mgcbPath ?? this.options.mgcbCommand;
    const compileResult = await this.options.runner.run(mgcbPath, [
      `/platform:${this.options.mgcbPlatform}`,
      `/outputDir:${xnbDir}`,
      `/intermediateDir:${intermediateDir}`,
      `/build:${sheetPng}`,
    ], options.signal !== undefined ? { signal: options.signal } : undefined);
    throwIfCancelled(options.signal, "compiling", filePath);
    if (compileResult.code !== 0) {
      throw new AssetToolError("mgcb", compileResult.code, compileResult.stderr, {
        stage: "compiling",
        filePath,
        suggestedActions: [
          "Verify the configured MGCB executable",
          "Check the selected MGCB platform and write permissions",
        ],
      });
    }

    const compiledXnb = path.join(xnbDir, `${path.basename(sheetPng, ".png")}.xnb`);
    if (!isValidXnb(compiledXnb, this.outputRoot)) {
      throw new AssetToolError("mgcb", 0, `compile did not produce a valid XNB at ${compiledXnb}`, {
        stage: "compiling",
        filePath,
        suggestedActions: ["Verify MGCB output settings and filesystem permissions"],
      });
    }
    const candidate: AssetIngestCandidate = Object.freeze({
      artifact: prepared.candidate,
      artifactId: prepared.candidate.artifactId,
      revision: prepared.candidate.revision,
      tags,
      spritesheetPng: sheetPng,
      metadataJson: dataJson,
      compiledXnb,
      clipCount: (prepared.candidate.payload as SpriteDocument).clips?.length ?? 0,
    });
    await options.beforePublish?.(candidate);
    // O ArtifactStore/hooks so avancam apos saidas E manifesto da aplicacao.
    const envelope: ArtifactEnvelope = await prepared.commit();
    const result: AssetIngestResult = {
      status: "ingested",
      artifactId: envelope.artifactId,
      revision: envelope.revision,
      tags: candidate.tags,
      spritesheetPng: candidate.spritesheetPng,
      metadataJson: candidate.metadataJson,
      compiledXnb: candidate.compiledXnb,
      clipCount: candidate.clipCount,
    };
    emitProgress(options.onProgress, "completed", 4, 4, "Asset pipeline completed");
    await this.options.hooks.doAction("asset:ingested", result);
    return result;
  }

  /** Valida executaveis antes de persistir uma configuracao do usuario/projeto. */
  async validateTools(
    tools: AssetToolPaths,
    signal?: AbortSignal,
  ): Promise<AssetToolDetectionResult> {
    const checks: ReadonlyArray<{ name: "aseprite" | "mgcb"; command: string }> = [
      { name: "aseprite", command: tools.asepritePath ?? this.options.asepriteCommand },
      { name: "mgcb", command: tools.mgcbPath ?? this.options.mgcbCommand },
    ];
    const detections = new Map<"aseprite" | "mgcb", AssetToolDetection>();
    for (const check of checks) {
      throwIfCancelled(signal, "validating", check.command);
      const result = await this.options.runner.run(
        check.command,
        ["--version"],
        signal !== undefined ? { signal } : undefined,
      );
      throwIfCancelled(signal, "validating", check.command);
      if (result.code !== 0) {
        throw new AssetToolError(check.name, result.code, result.stderr, {
          stage: "validating",
          filePath: check.command,
          suggestedActions: [`Select a working ${check.name} executable`],
        });
      }
      const version = firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr);
      detections.set(check.name, Object.freeze({
        path: check.command,
        available: true,
        ...(version !== undefined ? { version } : {}),
        message: version ?? `${check.name} executable responded successfully`,
      }));
    }
    return Object.freeze({
      aseprite: detections.get("aseprite")!,
      mgcb: detections.get("mgcb")!,
    });
  }

  /** Últimas revisões dos artefatos de sprite, filtráveis por tag. */
  catalog(artifacts: readonly ArtifactEnvelope[], tag?: string): readonly ArtifactEnvelope[] {
    return artifacts.filter((a) => tag === undefined || (a.metadata.tags ?? []).includes(tag));
  }

  /** Observa a raiz do catálogo (fs.watch recursivo — Node ≥ 20 em todas as plataformas). */
  watch(
    onError?: (err: Error) => void,
    onFile?: (filePath: string) => void | Promise<void>,
  ): void {
    if (this.watcher) return;
    this.watcher = fs.watch(this.options.assetsRoot, { recursive: true }, (_eventType, fileName) => {
      if (!fileName) return;
      const full = path.join(this.options.assetsRoot, fileName.toString());
      if (!fs.existsSync(full)) return; // deleção/rename: ignora
      const task = onFile ? onFile(full) : this.ingest(full);
      void Promise.resolve(task).catch((err: Error) => onError?.(err));
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  private assertSourcePath(filePath: string): void {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("Asset source path must be a non-empty string");
    }
    const root = fs.realpathSync(this.assetsRoot);
    const lexical = path.resolve(filePath);
    const sourceStats = fs.lstatSync(lexical);
    if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
      throw new TypeError(`Asset source must be a regular, non-symlink file: ${filePath}`);
    }
    const resolved = fs.realpathSync(lexical);
    if (!isInside(root, resolved)) {
      throw new TypeError(`Asset source must be inside the configured assets root: ${filePath}`);
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function validateAssetRoots(
  assetsRootInput: string,
  outputRootInput: string,
): { readonly assetsRoot: string; readonly outputRoot: string } {
  const assetsRoot = ensureRootDirectory(assetsRootInput, "assetsRoot");
  const outputCandidate = path.resolve(outputRootInput);
  const outputRoot = isInside(assetsRoot, outputCandidate)
    ? ensureContainedDirectory(assetsRoot, outputCandidate)
    : ensureRootDirectory(outputCandidate, "outputRoot");
  return Object.freeze({ assetsRoot, outputRoot });
}

/** Cria somente segmentos reais sob a raiz; nenhum symlink pode trocar o destino. */
function ensureContainedDirectory(rootInput: string, targetInput: string): string {
  const root = fs.realpathSync(path.resolve(rootInput));
  const target = path.resolve(targetInput);
  if (!isInside(root, target)) {
    throw new TypeError(`Asset output directory escapes configured root: ${targetInput}`);
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new TypeError(`Asset directory must not be a symlink or file: ${current}`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  const realTarget = fs.realpathSync(target);
  if (!isInside(root, realTarget)) {
    throw new TypeError(`Asset output directory resolves outside configured root: ${targetInput}`);
  }
  return realTarget;
}

function ensureRootDirectory(input: string, label: string): string {
  const absolute = path.resolve(input);
  try {
    const existing = fs.lstatSync(absolute);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new TypeError(`${label} must be a real directory: ${absolute}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new TypeError(`${label} must be a real directory: ${absolute}`);
  }
  return fs.realpathSync(absolute);
}

function uniqueTags(tags: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function throwIfCancelled(
  signal: AbortSignal | undefined,
  stage: AssetIngestStage,
  filePath: string,
): void {
  if (signal?.aborted) throw new AssetPipelineCancelledError(stage, filePath);
}

function emitProgress(
  listener: AssetIngestOptions["onProgress"],
  stage: AssetIngestStage,
  current: number,
  total: number,
  message: string,
): void {
  try {
    listener?.(Object.freeze({ stage, current, total, message }));
  } catch {
    // Observabilidade nao interfere na ingestao.
  }
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
}

function isValidPng(filePath: string, root: string): boolean {
  return fileStartsWith(filePath, root, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function isValidXnb(filePath: string, root: string): boolean {
  return fileStartsWith(filePath, root, Buffer.from("XNB", "ascii"));
}

/** Valida somente o magic header; nunca carrega um output potencialmente enorme. */
function fileStartsWith(filePath: string, root: string, expected: Buffer): boolean {
  let descriptor: number | undefined;
  try {
    if (!isSafeRegularFile(filePath, root, expected.length)) return false;
    descriptor = fs.openSync(filePath, "r");
    const actual = Buffer.allocUnsafe(expected.length);
    return fs.readSync(descriptor, actual, 0, actual.length, 0) === expected.length
      && actual.equals(expected);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isSafeRegularFile(
  filePath: string,
  root: string,
  minimumBytes: number,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size < minimumBytes ||
      stats.size > maximumBytes
    ) return false;
    return isInside(fs.realpathSync(root), fs.realpathSync(filePath));
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
