/**
 * Artefatos versionáveis do modelo canônico (docs/CANONICAL-MODEL.md §1).
 *
 * Um artefato é um envelope endereçável e auditável: id + kind +
 * schemaVersion + revisão monotônica + hash de conteúdo estável. Revisões
 * são append-only (histórico completo consultável); publicar um payload
 * idêntico ao da última revisão NÃO gera revisão nova (dedup por hash).
 *
 * `metadata.createdBy` registra a proveniência — humano, agente LLM ou
 * pipeline — requisito de auditoria da geração assistida.
 */

import { EventEmitter } from "node:events";
import { fnv1a } from "../util/fnv1a.js";

export interface ArtifactMetadata {
  /** Proveniência: "user:<nome>", "agent:<modelo>", "pipeline:<id>"... */
  readonly createdBy: string;
  readonly label?: string;
  readonly source?: string;
  readonly tags?: readonly string[];
}

export interface ArtifactEnvelope {
  readonly artifactId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly revision: number;
  /** FNV-1a (hex) da serialização estável do payload. */
  readonly contentHash: string;
  readonly payload: unknown;
  readonly metadata: ArtifactMetadata;
  readonly createdAtUnixMs: number;
}

export interface PublishInput {
  readonly artifactId: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly metadata: ArtifactMetadata;
}

export interface PreparedArtifactPublication {
  readonly candidate: ArtifactEnvelope;
  commit(): ArtifactEnvelope;
}

/**
 * Serialização determinística: chaves de objeto ordenadas em toda a árvore.
 * Garante que o hash de conteúdo seja estável entre execuções e runtimes.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function contentHashOf(payload: unknown): string {
  return fnv1a(Buffer.from(stableStringify(payload), "utf8")).toString(16).padStart(8, "0");
}

/**
 * Eventos: "published" (envelope: ArtifactEnvelope) a cada revisão nova.
 */
export class ArtifactStore extends EventEmitter {
  private readonly revisions = new Map<string, ArtifactEnvelope[]>();
  /** Tombstones mantem o historico append-only sem expor um artefato removido como ativo. */
  private readonly retired = new Set<string>();
  private readonly activeRevisions = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  /**
   * Publica uma revisão. Se o payload for idêntico ao da última revisão do
   * mesmo artefato (mesmo hash), retorna a revisão existente sem criar nova.
   */
  publish(input: PublishInput): ArtifactEnvelope {
    return this.preparePublish(input).commit();
  }

  /** Prepara envelope/revisao sem torna-lo observavel ate commit(). */
  preparePublish(input: PublishInput): PreparedArtifactPublication {
    validateInput(input);
    const history = this.revisions.get(input.artifactId) ?? [];
    const latest = history.at(-1);

    if (latest && latest.kind !== input.kind) {
      throw new Error(
        `Artifact "${input.artifactId}" is of kind "${latest.kind}"; cannot republish as "${input.kind}"`,
      );
    }

    const contentHash = contentHashOf(input.payload);
    const deduplicated = latest?.contentHash === contentHash && latest.schemaVersion === input.schemaVersion;
    const candidate: ArtifactEnvelope = deduplicated ? latest : Object.freeze({
      artifactId: input.artifactId,
      kind: input.kind,
      schemaVersion: input.schemaVersion,
      revision: (latest?.revision ?? 0) + 1,
      contentHash,
      payload: input.payload,
      metadata: Object.freeze({ ...input.metadata }),
      createdAtUnixMs: this.now(),
    });
    const baselineRevision = latest?.revision;
    let committed: ArtifactEnvelope | undefined;
    return Object.freeze({
      candidate,
      commit: (): ArtifactEnvelope => {
        if (committed) return committed;
        const currentHistory = this.revisions.get(input.artifactId) ?? [];
        if (currentHistory.at(-1)?.revision !== baselineRevision) {
          throw new Error(`Artifact "${input.artifactId}" changed before prepared publication commit`);
        }
        const wasRetired = this.retired.delete(input.artifactId);
        if (!deduplicated) {
          currentHistory.push(candidate);
          this.revisions.set(input.artifactId, currentHistory);
        }
        this.activeRevisions.set(input.artifactId, candidate.revision);
        if (!deduplicated || wasRetired) this.emit("published", candidate);
        committed = candidate;
        return candidate;
      },
    });
  }

  /** Última revisão (ou uma revisão específica). */
  get(artifactId: string, revision?: number): ArtifactEnvelope | undefined {
    const history = this.revisions.get(artifactId);
    if (!history) return undefined;
    if (revision === undefined && this.retired.has(artifactId)) return undefined;
    if (revision === undefined) {
      const activeRevision = this.activeRevisions.get(artifactId);
      return activeRevision === undefined
        ? history.at(-1)
        : history.find((entry) => entry.revision === activeRevision);
    }
    return history.find((e) => e.revision === revision);
  }

  /**
   * Retira o artefato do catalogo ativo sem apagar revisoes auditaveis. Uma
   * publicacao futura do mesmo id o ativa novamente.
   */
  retire(artifactId: string): ArtifactEnvelope | undefined {
    const latest = this.revisions.get(artifactId)?.at(-1);
    if (!latest || this.retired.has(artifactId)) return undefined;
    this.retired.add(artifactId);
    this.activeRevisions.delete(artifactId);
    this.emit("retired", latest);
    return latest;
  }

  /**
   * Reidrata a ultima revisao de um manifesto duravel. O hash e a progressao
   * sao validados; gaps de revisao sao aceitos porque o manifesto guarda
   * apenas o head ativo, nao substitui o log historico externo.
   */
  restore(input: ArtifactEnvelope): ArtifactEnvelope {
    validateRestoredEnvelope(input);
    const history = this.revisions.get(input.artifactId) ?? [];
    const latest = history.at(-1);
    if (latest && latest.revision === input.revision) {
      if (latest.contentHash !== input.contentHash || latest.kind !== input.kind) {
        throw new Error(`Artifact "${input.artifactId}" revision ${input.revision} conflicts with restored data`);
      }
      this.retired.delete(input.artifactId);
      this.activeRevisions.set(input.artifactId, latest.revision);
      return latest;
    }
    if (latest && latest.revision > input.revision) return latest;
    const envelope: ArtifactEnvelope = Object.freeze({
      artifactId: input.artifactId,
      kind: input.kind,
      schemaVersion: input.schemaVersion,
      revision: input.revision,
      contentHash: input.contentHash,
      payload: input.payload,
      metadata: Object.freeze({ ...input.metadata }),
      createdAtUnixMs: input.createdAtUnixMs,
    });
    history.push(envelope);
    this.revisions.set(input.artifactId, history);
    this.retired.delete(input.artifactId);
    this.activeRevisions.set(input.artifactId, envelope.revision);
    this.emit("published", envelope);
    return envelope;
  }

  isRetired(artifactId: string): boolean {
    return this.retired.has(artifactId);
  }

  /** Seleciona uma revisao historica como head ativo durante rollback de aplicacao. */
  activate(artifactId: string, revision: number): ArtifactEnvelope {
    const envelope = this.get(artifactId, revision);
    if (!envelope) throw new Error(`Unknown artifact "${artifactId}" revision ${revision}`);
    this.retired.delete(artifactId);
    this.activeRevisions.set(artifactId, revision);
    this.emit("published", envelope);
    return envelope;
  }

  /** Histórico completo (append-only) de um artefato. */
  history(artifactId: string): readonly ArtifactEnvelope[] {
    return this.revisions.get(artifactId) ?? [];
  }

  /** Últimas revisões de todos os artefatos, opcionalmente por kind. */
  list(kind?: string): readonly ArtifactEnvelope[] {
    const latest = [...this.revisions.keys()]
      .map((artifactId) => this.get(artifactId))
      .filter((entry): entry is ArtifactEnvelope => entry !== undefined)
      .filter((e) => kind === undefined || e.kind === kind);
    return latest;
  }
}

function validateInput(input: PublishInput): void {
  if (!input.artifactId) throw new Error(`"artifactId" must be a non-empty string`);
  if (!input.kind) throw new Error(`"kind" must be a non-empty string`);
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new Error(`"schemaVersion" must be a positive integer`);
  }
  if (!input.metadata?.createdBy) {
    throw new Error(`"metadata.createdBy" is required (provenance)`);
  }
}

function validateRestoredEnvelope(input: ArtifactEnvelope): void {
  validateInput(input);
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new Error(`"revision" must be a positive integer`);
  }
  if (!Number.isFinite(input.createdAtUnixMs) || input.createdAtUnixMs < 0) {
    throw new Error(`"createdAtUnixMs" must be a non-negative number`);
  }
  if (contentHashOf(input.payload) !== input.contentHash) {
    throw new Error(`Restored artifact "${input.artifactId}" has an invalid contentHash`);
  }
}
