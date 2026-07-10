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
import { ASEPRITE_PIPELINE, type PipelineRunner } from "../canonical/Pipeline.js";
import type { SpriteDocument } from "./AsepriteImporter.js";

export interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Executor de ferramentas externas — injetável (fake nos testes). */
export interface ToolRunner {
  run(command: string, args: readonly string[]): Promise<ToolResult>;
}

/** Runner real via execFile (sem shell — argumentos nunca são interpretados). */
export class ExecToolRunner implements ToolRunner {
  run(command: string, args: readonly string[]): Promise<ToolResult> {
    return new Promise((resolve) => {
      execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
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
  ) {
    super(`${tool} exited with code ${exitCode}: ${stderr.trim() || "(no stderr)"}`);
    this.name = "AssetToolError";
  }
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
      readonly compiledXnb: string;
      readonly clipCount: number;
    }
  | { readonly status: "ignored"; readonly reason: string };

export class AssetPipelineService {
  private readonly options: Required<Pick<AssetPipelineOptions, "asepriteCommand" | "mgcbCommand" | "mgcbPlatform">> &
    AssetPipelineOptions;
  private watcher: fs.FSWatcher | undefined;

  constructor(options: AssetPipelineOptions) {
    this.options = {
      asepriteCommand: "aseprite",
      mgcbCommand: "mgcb",
      mgcbPlatform: "DesktopGL",
      ...options,
    };
  }

  /** Tags derivadas dos diretórios sob a raiz (`characters/boss/x.ase` → [characters, boss]). */
  deriveTags(filePath: string): string[] {
    const relative = path.relative(this.options.assetsRoot, filePath);
    const segments = relative.split(path.sep);
    return segments.slice(0, -1).filter((s) => s.length > 0 && s !== "..");
  }

  /** Id canônico do artefato: caminho relativo POSIX sem extensão. */
  artifactIdFor(filePath: string): string {
    const relative = path.relative(this.options.assetsRoot, filePath);
    const withoutExt = relative.slice(0, relative.length - path.extname(relative).length);
    return `assets/${withoutExt.split(path.sep).join("/")}`;
  }

  /**
   * Processa um arquivo do catálogo: exporta (Aseprite CLI), normaliza
   * (pipeline canônico → artefato) e compila (MGCB → .xnb).
   */
  async ingest(filePath: string): Promise<AssetIngestResult> {
    const extension = path.extname(filePath).toLowerCase();
    if (extension !== ".aseprite" && extension !== ".ase") {
      return { status: "ignored", reason: `extension "${extension}" is not an Aseprite source` };
    }

    const relative = path.relative(this.options.assetsRoot, filePath);
    const baseOut = path.join(this.options.outputRoot, relative.slice(0, relative.length - extension.length));
    const sheetPng = `${baseOut}.png`;
    const dataJson = `${baseOut}.json`;
    fs.mkdirSync(path.dirname(sheetPng), { recursive: true });

    // 1. Exportação: spritesheet + metadados (frameTags, slices, durações)
    const exportResult = await this.options.runner.run(this.options.asepriteCommand, [
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
    ]);
    if (exportResult.code !== 0) {
      throw new AssetToolError("aseprite", exportResult.code, exportResult.stderr);
    }
    if (!fs.existsSync(dataJson)) {
      throw new AssetToolError("aseprite", 0, `export did not produce ${dataJson}`);
    }

    // 2. Normalização canônica → artefato versionável com taxonomia
    const raw: unknown = JSON.parse(fs.readFileSync(dataJson, "utf8"));
    const tags = this.deriveTags(filePath);
    const artifactId = this.artifactIdFor(filePath);
    const envelope = await this.options.pipelines.run(ASEPRITE_PIPELINE.pipelineId, raw, {
      artifactId,
      tags,
      source: filePath,
    });

    // 3. Compilação MGCB do spritesheet para .xnb nativo
    const xnbDir = path.join(this.options.outputRoot, "compiled");
    const compileResult = await this.options.runner.run(this.options.mgcbCommand, [
      `/platform:${this.options.mgcbPlatform}`,
      `/outputDir:${xnbDir}`,
      `/intermediateDir:${path.join(this.options.outputRoot, "obj")}`,
      `/build:${sheetPng}`,
    ]);
    if (compileResult.code !== 0) {
      throw new AssetToolError("mgcb", compileResult.code, compileResult.stderr);
    }

    const compiledXnb = path.join(xnbDir, `${path.basename(sheetPng, ".png")}.xnb`);
    const result: AssetIngestResult = {
      status: "ingested",
      artifactId: envelope.artifactId,
      revision: envelope.revision,
      tags,
      spritesheetPng: sheetPng,
      compiledXnb,
      clipCount: (envelope.payload as SpriteDocument).clips?.length ?? 0,
    };
    await this.options.hooks.doAction("asset:ingested", result);
    return result;
  }

  /** Últimas revisões dos artefatos de sprite, filtráveis por tag. */
  catalog(artifacts: readonly ArtifactEnvelope[], tag?: string): readonly ArtifactEnvelope[] {
    return artifacts.filter((a) => tag === undefined || (a.metadata.tags ?? []).includes(tag));
  }

  /** Observa a raiz do catálogo (fs.watch recursivo — Node ≥ 20 em todas as plataformas). */
  watch(onError?: (err: Error) => void): void {
    if (this.watcher) return;
    this.watcher = fs.watch(this.options.assetsRoot, { recursive: true }, (_eventType, fileName) => {
      if (!fileName) return;
      const full = path.join(this.options.assetsRoot, fileName.toString());
      if (!fs.existsSync(full)) return; // deleção/rename: ignora
      void this.ingest(full).catch((err: Error) => onError?.(err));
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
}
