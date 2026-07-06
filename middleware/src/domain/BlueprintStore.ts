/**
 * Estado declarativo (AST/Blueprint) do projeto, mantido no middleware.
 *
 * CQRS: toda mutação entra como um Comando imutável, é validada, aplicada
 * ao estado e emitida como evento para os assinantes (UI, ponte da engine).
 * Leituras são projeções somente-leitura — nunca expõem referências mutáveis.
 */

import { EventEmitter } from "node:events";
import { JsonRpcError, RpcErrorCode } from "../protocol/jsonrpc.js";

export interface BoneDefinition {
  readonly id: number;
  readonly parentId: number; // -1 = raiz
  /** Matriz afim 2D coluna-maior: m11, m12, m21, m22, m31, m32 */
  readonly inverseBindMatrix: readonly number[];
}

export interface SkeletonBlueprint {
  readonly skeletonId: string;
  readonly bones: readonly BoneDefinition[];
}

export interface MeshBinding {
  readonly meshId: string;
  readonly skeletonId: string;
  readonly sharedMemoryMapName: string;
  readonly vertexCount: number;
  readonly strideInBytes: number;
}

export type BlueprintCommand =
  | { readonly kind: "skeleton/define"; readonly skeleton: SkeletonBlueprint }
  | { readonly kind: "mesh/bind"; readonly binding: MeshBinding };

export type BlueprintEvent =
  | { readonly kind: "skeletonDefined"; readonly skeleton: SkeletonBlueprint }
  | { readonly kind: "meshBound"; readonly binding: MeshBinding };

/**
 * Eventos: "event" (BlueprintEvent) após cada comando aplicado com sucesso.
 */
export class BlueprintStore extends EventEmitter {
  private readonly skeletons = new Map<string, SkeletonBlueprint>();
  private readonly meshes = new Map<string, MeshBinding>();

  apply(command: BlueprintCommand): BlueprintEvent {
    switch (command.kind) {
      case "skeleton/define": {
        const s = command.skeleton;
        validateSkeleton(s);
        if (this.skeletons.has(s.skeletonId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Skeleton "${s.skeletonId}" is already defined`);
        }
        this.skeletons.set(s.skeletonId, deepFreezeSkeleton(s));
        const event: BlueprintEvent = { kind: "skeletonDefined", skeleton: s };
        this.emit("event", event);
        return event;
      }
      case "mesh/bind": {
        const b = command.binding;
        validateBinding(b);
        if (!this.skeletons.has(b.skeletonId)) {
          throw new JsonRpcError(RpcErrorCode.UnknownSkeleton, `Skeleton "${b.skeletonId}" is not defined`);
        }
        if (this.meshes.has(b.meshId)) {
          throw new JsonRpcError(RpcErrorCode.DuplicateId, `Mesh "${b.meshId}" is already bound`);
        }
        this.meshes.set(b.meshId, Object.freeze({ ...b }));
        const event: BlueprintEvent = { kind: "meshBound", binding: b };
        this.emit("event", event);
        return event;
      }
    }
  }

  // ---- Projeções (Query) ----

  getSkeleton(skeletonId: string): SkeletonBlueprint | undefined {
    return this.skeletons.get(skeletonId);
  }

  listSkeletons(): readonly SkeletonBlueprint[] {
    return [...this.skeletons.values()];
  }

  getMesh(meshId: string): MeshBinding | undefined {
    return this.meshes.get(meshId);
  }

  listMeshes(): readonly MeshBinding[] {
    return [...this.meshes.values()];
  }
}

function validateSkeleton(s: SkeletonBlueprint): void {
  if (typeof s.skeletonId !== "string" || s.skeletonId.length === 0) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"skeletonId" must be a non-empty string`);
  }
  if (!Array.isArray(s.bones) || s.bones.length === 0 || s.bones.length > 256) {
    throw new JsonRpcError(RpcErrorCode.InvalidParams, `"bones" must contain between 1 and 256 entries`);
  }
  const ids = new Set<number>();
  for (const bone of s.bones) {
    if (!Number.isInteger(bone.id) || bone.id < 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Bone id must be a non-negative integer`);
    }
    if (ids.has(bone.id)) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Duplicate bone id ${bone.id}`);
    }
    ids.add(bone.id);
    if (!Number.isInteger(bone.parentId) || bone.parentId < -1) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Bone ${bone.id}: parentId must be >= -1`);
    }
    if (!Array.isArray(bone.inverseBindMatrix) || bone.inverseBindMatrix.length !== 6) {
      throw new JsonRpcError(
        RpcErrorCode.InvalidParams,
        `Bone ${bone.id}: inverseBindMatrix must contain exactly 6 floats (2D affine, column-major)`,
      );
    }
  }
  for (const bone of s.bones) {
    if (bone.parentId !== -1 && !ids.has(bone.parentId)) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `Bone ${bone.id}: parentId ${bone.parentId} does not exist`);
    }
  }
}

function validateBinding(b: MeshBinding): void {
  for (const field of ["meshId", "skeletonId", "sharedMemoryMapName"] as const) {
    if (typeof b[field] !== "string" || b[field].length === 0) {
      throw new JsonRpcError(RpcErrorCode.InvalidParams, `"${field}" must be a non-empty string`);
    }
  }
  if (!Number.isInteger(b.vertexCount) || b.vertexCount < 1) {
    throw new JsonRpcError(RpcErrorCode.InvalidBinaryLayout, `"vertexCount" must be a positive integer`);
  }
  if (!Number.isInteger(b.strideInBytes) || b.strideInBytes < 4) {
    throw new JsonRpcError(RpcErrorCode.InvalidBinaryLayout, `"strideInBytes" must be an integer >= 4`);
  }
}

function deepFreezeSkeleton(s: SkeletonBlueprint): SkeletonBlueprint {
  for (const bone of s.bones) {
    Object.freeze(bone.inverseBindMatrix);
    Object.freeze(bone);
  }
  Object.freeze(s.bones);
  return Object.freeze(s);
}
