/**
 * Pipelines do modelo canônico (docs/CANONICAL-MODEL.md §1).
 *
 * Um pipeline é uma sequência nomeada de estágios; cada estágio é uma cadeia
 * de FILTERS no HookBus (`pipeline:<id>:<estágio>`), então plugins e agentes
 * estendem qualquer estágio sem tocar no pipeline. O resultado é publicado
 * como ARTEFATO versionável com proveniência `pipeline:<id>`.
 *
 * Actions emitidas: `pipeline:started`, `pipeline:stage:completed`,
 * `pipeline:completed` — observabilidade para watchers e agentes.
 */

import type {
  ArtifactEnvelope,
  ArtifactStore,
  PreparedArtifactPublication,
} from "./ArtifactStore.js";
import type { HookBus } from "./HookBus.js";

export interface PipelineDefinition {
  readonly pipelineId: string;
  readonly description: string;
  /** Nomes dos estágios, executados em ordem. */
  readonly stages: readonly string[];
  /** Kind e versão do artefato de saída. */
  readonly output: { readonly kind: string; readonly schemaVersion: number };
}

export interface PipelineRunOptions {
  /** Id do artefato de saída. */
  readonly artifactId: string;
  /** Proveniência adicional (default: "pipeline:<id>"). */
  readonly requestedBy?: string;
  /** Taxonomia anexada ao artefato (painel de assets). */
  readonly tags?: readonly string[];
  /** Origem legível (ex.: caminho do arquivo fonte). */
  readonly source?: string;
  /** Cancelamento cooperativo entre estagios e antes da publicacao. */
  readonly signal?: AbortSignal;
  /** Observabilidade direta para a camada de aplicacao. */
  readonly onProgress?: (progress: PipelineProgress) => void;
}

export interface PipelineProgress {
  readonly pipelineId: string;
  readonly artifactId: string;
  readonly phase: "started" | "stage" | "publishing" | "completed";
  readonly completed: number;
  readonly total: number;
  readonly stage?: string;
}

export class PipelineCancelledError extends Error {
  constructor(readonly pipelineId: string) {
    super(`Pipeline "${pipelineId}" was cancelled`);
    this.name = "PipelineCancelledError";
  }
}

export interface PreparedPipelineRun {
  readonly pipelineId: string;
  readonly artifactId: string;
  readonly candidate: ArtifactEnvelope;
  /** Publicacao idempotente; so deve ser chamada apos efeitos externos validarem. */
  commit(): Promise<ArtifactEnvelope>;
}

export class PipelineRunner {
  private readonly definitions = new Map<string, PipelineDefinition>();

  constructor(
    private readonly hooks: HookBus,
    private readonly artifacts: ArtifactStore,
  ) {}

  register(definition: PipelineDefinition): void {
    if (!definition.pipelineId || definition.stages.length === 0) {
      throw new Error("Pipeline requires a pipelineId and at least one stage");
    }
    if (this.definitions.has(definition.pipelineId)) {
      throw new Error(`Pipeline "${definition.pipelineId}" is already registered`);
    }
    this.definitions.set(definition.pipelineId, definition);
  }

  list(): readonly PipelineDefinition[] {
    return [...this.definitions.values()];
  }

  /** Compatibilidade: prepara e publica imediatamente. */
  async run(pipelineId: string, input: unknown, options: PipelineRunOptions): Promise<ArtifactEnvelope> {
    return await (await this.prepare(pipelineId, input, options)).commit();
  }

  /**
   * Executa filtros sem publicar. A camada que possui efeitos externos pode
   * validar/compilar primeiro e chamar commit somente no ponto transacional.
   */
  async prepare(
    pipelineId: string,
    input: unknown,
    options: PipelineRunOptions,
  ): Promise<PreparedPipelineRun> {
    const definition = this.definitions.get(pipelineId);
    if (!definition) {
      throw new Error(`Pipeline "${pipelineId}" is not registered`);
    }

    throwIfCancelled(options.signal, pipelineId);
    const total = definition.stages.length + 1;
    notifyProgress(options.onProgress, {
      pipelineId,
      artifactId: options.artifactId,
      phase: "started",
      completed: 0,
      total,
    });
    await this.hooks.doAction("pipeline:started", { pipelineId, artifactId: options.artifactId });

    let value = input;
    for (const [index, stage] of definition.stages.entries()) {
      throwIfCancelled(options.signal, pipelineId);
      value = await this.hooks.applyFilters(`pipeline:${pipelineId}:${stage}`, value);
      throwIfCancelled(options.signal, pipelineId);
      await this.hooks.doAction("pipeline:stage:completed", { pipelineId, stage });
      notifyProgress(options.onProgress, {
        pipelineId,
        artifactId: options.artifactId,
        phase: "stage",
        stage,
        completed: index + 1,
        total,
      });
    }

    const publication = this.artifacts.preparePublish({
      artifactId: options.artifactId,
      kind: definition.output.kind,
      schemaVersion: definition.output.schemaVersion,
      payload: value,
      metadata: {
        createdBy: options.requestedBy ?? `pipeline:${pipelineId}`,
        source: options.source ?? pipelineId,
        ...(options.tags !== undefined ? { tags: options.tags } : {}),
      },
    });
    let committed: Promise<ArtifactEnvelope> | undefined;
    const commit = (): Promise<ArtifactEnvelope> => {
      committed ??= this.commitPrepared(pipelineId, definition, publication, options, total);
      return committed;
    };
    return Object.freeze({
      pipelineId,
      artifactId: options.artifactId,
      candidate: publication.candidate,
      commit,
    });
  }

  private async commitPrepared(
    pipelineId: string,
    definition: PipelineDefinition,
    publication: PreparedArtifactPublication,
    options: PipelineRunOptions,
    total: number,
  ): Promise<ArtifactEnvelope> {
    throwIfCancelled(options.signal, pipelineId);
    notifyProgress(options.onProgress, {
      pipelineId,
      artifactId: options.artifactId,
      phase: "publishing",
      completed: definition.stages.length,
      total,
    });
    const envelope = publication.commit();
    await this.hooks.doAction("pipeline:completed", {
      pipelineId,
      artifactId: envelope.artifactId,
      revision: envelope.revision,
      contentHash: envelope.contentHash,
    });
    notifyProgress(options.onProgress, {
      pipelineId,
      artifactId: options.artifactId,
      phase: "completed",
      completed: total,
      total,
    });
    return envelope;
  }
}

function throwIfCancelled(signal: AbortSignal | undefined, pipelineId: string): void {
  if (signal?.aborted) throw new PipelineCancelledError(pipelineId);
}

/** Progresso e telemetria nunca podem alterar o resultado do pipeline. */
function notifyProgress(
  listener: PipelineRunOptions["onProgress"],
  progress: PipelineProgress,
): void {
  try {
    listener?.(Object.freeze(progress));
  } catch {
    // Observadores sao isolados como actions do HookBus.
  }
}

/**
 * Pipeline padrão de ingestão Aseprite: o estágio "parse" normaliza o export
 * CLI (via filter registrado na composição) e "publish" fecha o documento.
 */
export const ASEPRITE_PIPELINE: PipelineDefinition = {
  pipelineId: "aseprite-import",
  description: "Normaliza o export CLI do Aseprite em um sprite-document canônico",
  stages: ["parse", "enrich"],
  output: { kind: "sprite-document", schemaVersion: 1 },
};
