using System.Numerics;
using System.Text.Json;
using P7m.Engine.Core.Rigging;
using P7m.Engine.Ipc;
using P7m.Engine.Ipc.Protocol;

namespace P7m.Engine.Runtime;

/// <summary>
/// Serviço da engine: registra os handlers JSON-RPC do plano de controle e
/// materializa os comandos do middleware no núcleo Data-Oriented.
///
/// Na Fase 3 o host MonoGame (Game loop, GraphicsDevice) acopla-se a esta
/// classe consumindo <see cref="Skeletons"/>; o plano de controle permanece
/// inalterado.
/// </summary>
public sealed class EngineService
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

    public SkeletonStore Skeletons { get; }

    /// <summary>Binds de shared memory aceitos (mapeamento efetivo do MMF é a Fase 2).</summary>
    public IReadOnlyDictionary<string, MeshBindParams> MeshBindings => _meshBindings;

    private readonly Dictionary<string, MeshBindParams> _meshBindings = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    /// <summary>Disparado quando um <c>engine/ping</c> originado no middleware é atendido.</summary>
    public event Action<string>? PingReceived;

    public EngineService(int maxSkeletons = 64)
    {
        Skeletons = new SkeletonStore(maxSkeletons);
    }

    public void RegisterHandlers(JsonRpcConnection connection)
    {
        connection.RegisterMethod("engine/ping", (params_, _) =>
        {
            var p = Deserialize<PingParams>(params_);
            var payload = p.Payload
                          ?? throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"payload\" must be a string");
            PingReceived?.Invoke(payload);
            return ValueTask.FromResult<object?>(new
            {
                echo = payload,
                receivedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            });
        });

        connection.RegisterMethod("skeleton/initialize", (params_, _) =>
        {
            var p = Deserialize<SkeletonInitializeParams>(params_);
            ValidateSkeleton(p);
            lock (_gate)
            {
                RegisterSkeleton(p);
            }

            return ValueTask.FromResult<object?>(new
            {
                skeletonId = p.SkeletonId,
                boneCount = p.Bones!.Length,
                status = "initialized",
            });
        });

        connection.RegisterMethod("mesh/bind_shared_memory", (params_, _) =>
        {
            var p = Deserialize<MeshBindParams>(params_);
            ValidateMeshBind(p);
            lock (_gate)
            {
                if (Skeletons.Find(p.SkeletonId!) is { IsValid: false })
                {
                    throw new JsonRpcException(
                        RpcErrorCode.UnknownSkeleton, $"Skeleton \"{p.SkeletonId}\" is not initialized");
                }

                if (!_meshBindings.TryAdd(p.MeshId!, p))
                {
                    throw new JsonRpcException(RpcErrorCode.DuplicateId, $"Mesh \"{p.MeshId}\" is already bound");
                }
            }

            // O mapeamento físico do memory-mapped file entra na Fase 2;
            // o contrato prevê exatamente este estado intermediário.
            return ValueTask.FromResult<object?>(new
            {
                meshId = p.MeshId,
                mappedBytes = (long)p.VertexCount * p.StrideInBytes,
                status = "deferred",
            });
        });
    }

    private void RegisterSkeleton(SkeletonInitializeParams p)
    {
        var bones = p.Bones!;
        var order = TopologicalOrder(bones, p.SkeletonId!);

        Span<int> parents = stackalloc int[bones.Length];
        var inverseBind = new Matrix3x2[bones.Length];
        var indexById = new Dictionary<int, int>(bones.Length);
        for (var i = 0; i < order.Length; i++)
        {
            indexById[bones[order[i]].Id] = i;
        }

        for (var i = 0; i < order.Length; i++)
        {
            var bone = bones[order[i]];
            parents[i] = bone.ParentId < 0 ? -1 : indexById[bone.ParentId];
            var m = bone.InverseBindMatrix!;
            inverseBind[i] = new Matrix3x2(m[0], m[1], m[2], m[3], m[4], m[5]);
        }

        if (Skeletons.Find(p.SkeletonId!).IsValid)
        {
            throw new JsonRpcException(RpcErrorCode.DuplicateId, $"Skeleton \"{p.SkeletonId}\" is already initialized");
        }

        var handle = Skeletons.Register(p.SkeletonId!, parents, inverseBind);
        Skeletons.ComputeWorldPoses(handle); // pose de bind resolvida imediatamente
    }

    /// <summary>
    /// Ordena os ossos com pai antes do filho (o contrato permite qualquer ordem
    /// no fio; o SoA exige ordem topológica para a passada linear única).
    /// </summary>
    private static int[] TopologicalOrder(BoneParams[] bones, string skeletonId)
    {
        var indexById = new Dictionary<int, int>(bones.Length);
        for (var i = 0; i < bones.Length; i++)
        {
            if (!indexById.TryAdd(bones[i].Id, i))
            {
                throw new JsonRpcException(RpcErrorCode.InvalidParams, $"Duplicate bone id {bones[i].Id}");
            }
        }

        var order = new int[bones.Length];
        var visited = new int[bones.Length]; // 0=não visitado, 1=em progresso, 2=pronto
        var count = 0;

        for (var i = 0; i < bones.Length; i++)
        {
            Visit(i);
        }

        return order;

        void Visit(int index)
        {
            if (visited[index] == 2)
            {
                return;
            }

            if (visited[index] == 1)
            {
                throw new JsonRpcException(
                    RpcErrorCode.InvalidParams, $"Skeleton \"{skeletonId}\" contains a bone parent cycle");
            }

            visited[index] = 1;
            var parentId = bones[index].ParentId;
            if (parentId >= 0)
            {
                if (!indexById.TryGetValue(parentId, out var parentIndex))
                {
                    throw new JsonRpcException(
                        RpcErrorCode.InvalidParams,
                        $"Bone {bones[index].Id}: parentId {parentId} does not exist");
                }

                Visit(parentIndex);
            }

            visited[index] = 2;
            order[count++] = index;
        }
    }

    private static void ValidateSkeleton(SkeletonInitializeParams p)
    {
        if (string.IsNullOrEmpty(p.SkeletonId))
        {
            throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"skeletonId\" must be a non-empty string");
        }

        if (p.Bones is not { Length: >= 1 and <= SkeletonStore.MaxBonesPerSkeleton })
        {
            throw new JsonRpcException(
                RpcErrorCode.InvalidParams,
                $"\"bones\" must contain between 1 and {SkeletonStore.MaxBonesPerSkeleton} entries");
        }

        foreach (var bone in p.Bones)
        {
            if (bone.InverseBindMatrix is not { Length: 6 })
            {
                throw new JsonRpcException(
                    RpcErrorCode.InvalidParams,
                    $"Bone {bone.Id}: inverseBindMatrix must contain exactly 6 floats (2D affine, column-major)");
            }
        }
    }

    private static void ValidateMeshBind(MeshBindParams p)
    {
        if (string.IsNullOrEmpty(p.MeshId) ||
            string.IsNullOrEmpty(p.SkeletonId) ||
            string.IsNullOrEmpty(p.SharedMemoryMapName))
        {
            throw new JsonRpcException(
                RpcErrorCode.InvalidParams,
                "\"meshId\", \"skeletonId\" and \"sharedMemoryMapName\" must be non-empty strings");
        }

        if (p.VertexCount < 1 || p.StrideInBytes < 4)
        {
            throw new JsonRpcException(
                RpcErrorCode.InvalidBinaryLayout,
                "\"vertexCount\" must be >= 1 and \"strideInBytes\" >= 4");
        }
    }

    private static T Deserialize<T>(JsonElement? params_)
    {
        if (params_ is null)
        {
            throw new JsonRpcException(RpcErrorCode.InvalidParams, "params are required");
        }

        try
        {
            return params_.Value.Deserialize<T>(SerializerOptions)
                   ?? throw new JsonRpcException(RpcErrorCode.InvalidParams, "params deserialized to null");
        }
        catch (JsonException ex)
        {
            throw new JsonRpcException(RpcErrorCode.InvalidParams, $"Invalid params: {ex.Message}");
        }
    }

    // ---- DTOs do fio (espelham contracts/schemas) ----

    public sealed record PingParams(string? Payload, long? SentAtUnixMs);

    public sealed record BoneParams(int Id, int ParentId, float[]? InverseBindMatrix);

    public sealed record SkeletonInitializeParams(string? SkeletonId, BoneParams[]? Bones);

    public sealed record MeshBindParams(
        string? MeshId,
        string? SkeletonId,
        string? SharedMemoryMapName,
        int VertexCount,
        int StrideInBytes);
}
