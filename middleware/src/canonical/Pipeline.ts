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

import type { ArtifactEnvelope, ArtifactStore } from "./ArtifactStore.js";
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

  /** Executa os estágios sobre `input` e publica o resultado como artefato. */
  async run(pipelineId: string, input: unknown, options: PipelineRunOptions): Promise<ArtifactEnvelope> {
    const definition = this.definitions.get(pipelineId);
    if (!definition) {
      throw new Error(`Pipeline "${pipelineId}" is not registered`);
    }

    await this.hooks.doAction("pipeline:started", { pipelineId, artifactId: options.artifactId });

    let value = input;
    for (const stage of definition.stages) {
      value = await this.hooks.applyFilters(`pipeline:${pipelineId}:${stage}`, value);
      await this.hooks.doAction("pipeline:stage:completed", { pipelineId, stage });
    }

    const envelope = this.artifacts.publish({
      artifactId: options.artifactId,
      kind: definition.output.kind,
      schemaVersion: definition.output.schemaVersion,
      payload: value,
      metadata: {
        createdBy: options.requestedBy ?? `pipeline:${pipelineId}`,
        source: pipelineId,
      },
    });

    await this.hooks.doAction("pipeline:completed", {
      pipelineId,
      artifactId: envelope.artifactId,
      revision: envelope.revision,
      contentHash: envelope.contentHash,
    });
    return envelope;
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
