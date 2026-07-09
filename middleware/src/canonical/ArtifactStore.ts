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
import { fnv1a } from "../sharedmem/vertexLayout.js";

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

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  /**
   * Publica uma revisão. Se o payload for idêntico ao da última revisão do
   * mesmo artefato (mesmo hash), retorna a revisão existente sem criar nova.
   */
  publish(input: PublishInput): ArtifactEnvelope {
    validateInput(input);
    const history = this.revisions.get(input.artifactId) ?? [];
    const latest = history.at(-1);

    if (latest && latest.kind !== input.kind) {
      throw new Error(
        `Artifact "${input.artifactId}" is of kind "${latest.kind}"; cannot republish as "${input.kind}"`,
      );
    }

    const contentHash = contentHashOf(input.payload);
    if (latest && latest.contentHash === contentHash && latest.schemaVersion === input.schemaVersion) {
      return latest; // dedup: nada mudou
    }

    const envelope: ArtifactEnvelope = Object.freeze({
      artifactId: input.artifactId,
      kind: input.kind,
      schemaVersion: input.schemaVersion,
      revision: (latest?.revision ?? 0) + 1,
      contentHash,
      payload: input.payload,
      metadata: Object.freeze({ ...input.metadata }),
      createdAtUnixMs: this.now(),
    });
    history.push(envelope);
    this.revisions.set(input.artifactId, history);
    this.emit("published", envelope);
    return envelope;
  }

  /** Última revisão (ou uma revisão específica). */
  get(artifactId: string, revision?: number): ArtifactEnvelope | undefined {
    const history = this.revisions.get(artifactId);
    if (!history) return undefined;
    if (revision === undefined) return history.at(-1);
    return history.find((e) => e.revision === revision);
  }

  /** Histórico completo (append-only) de um artefato. */
  history(artifactId: string): readonly ArtifactEnvelope[] {
    return this.revisions.get(artifactId) ?? [];
  }

  /** Últimas revisões de todos os artefatos, opcionalmente por kind. */
  list(kind?: string): readonly ArtifactEnvelope[] {
    const latest = [...this.revisions.values()]
      .map((history) => history.at(-1)!)
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
