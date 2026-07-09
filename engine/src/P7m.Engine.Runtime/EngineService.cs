using System.Numerics;
using System.Text.Json;
using P7m.Engine.Core.Camera;
using P7m.Engine.Core.Level;
using P7m.Engine.Core.Lighting;
using P7m.Engine.Core.Rigging;
using P7m.Engine.Core.SharedMemory;
using P7m.Engine.Ipc;
using P7m.Engine.Ipc.Protocol;

namespace P7m.Engine.Runtime;

/// <summary>
/// Serviço da engine: registra os handlers JSON-RPC do plano de controle e
/// materializa os comandos do middleware no núcleo Data-Oriented.
///
/// Na Fase 3 o host MonoGame (Game loop, GraphicsDevice) acopla-se a esta
/// classe consumindo <see cref="Skeletons"/> e <see cref="MeshReaders"/>;
/// o plano de controle permanece inalterado.
/// </summary>
public sealed class EngineService : IDisposable
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

    public SkeletonStore Skeletons { get; }

    /// <summary>Câmera cinemática do serviço (Fase 3).</summary>
    public CinematicCamera Camera { get; }

    /// <summary>Luzes do pipeline deferred (Fase 3).</summary>
    public LightStore Lights { get; }

    /// <summary>Tilemaps resolvidos pelo middleware (subsistema de níveis).</summary>
    public TilemapStore Tilemaps { get; }

    /// <summary>Binds de shared memory aceitos.</summary>
    public IReadOnlyDictionary<string, MeshBindParams> MeshBindings => _meshBindings;

    /// <summary>Leitores mapeados do plano de dados, por meshId.</summary>
    public IReadOnlyDictionary<string, MeshSharedMemoryReader> MeshReaders => _meshReaders;

    private readonly Dictionary<string, MeshBindParams> _meshBindings = new(StringComparer.Ordinal);
    private readonly Dictionary<string, MeshSharedMemoryReader> _meshReaders = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    /// <summary>Disparado quando um <c>engine/ping</c> originado no middleware é atendido.</summary>
    public event Action<string>? PingReceived;

    public EngineService(int maxSkeletons = 64, int maxLights = 256, int maxTilemaps = 8)
    {
        Skeletons = new SkeletonStore(maxSkeletons);
        Camera = new CinematicCamera(CameraConfig.Default);
        Lights = new LightStore(maxLights);
        Tilemaps = new TilemapStore(maxTilemaps);
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

                if (_meshBindings.ContainsKey(p.MeshId!))
                {
                    throw new JsonRpcException(RpcErrorCode.DuplicateId, $"Mesh \"{p.MeshId}\" is already bound");
                }

                MeshSharedMemoryReader reader;
                try
                {
                    reader = MeshSharedMemoryReader.Open(
                        p.SharedMemoryMapName!, p.VertexCount, p.StrideInBytes);
                }
                catch (SharedMemoryLayoutException ex)
                {
                    throw new JsonRpcException(RpcErrorCode.InvalidBinaryLayout, ex.Message);
                }
                catch (Exception ex) when (ex is IOException or FileNotFoundException or UnauthorizedAccessException)
                {
                    throw new JsonRpcException(
                        RpcErrorCode.SharedMemoryUnavailable,
                        $"Cannot map \"{p.SharedMemoryMapName}\": {ex.Message}");
                }

                _meshBindings.Add(p.MeshId!, p);
                _meshReaders.Add(p.MeshId!, reader);

                return ValueTask.FromResult<object?>(new
                {
                    meshId = p.MeshId,
                    mappedBytes = reader.MappedBytes,
                    status = "bound",
                });
            }
        });

        connection.RegisterMethod("engine/describe", (_, _) =>
            ValueTask.FromResult<object?>(EngineDescriptor.BuildManifest(Skeletons, Lights, Tilemaps)));

        RegisterCameraHandlers(connection);
        RegisterLightingHandlers(connection);
        RegisterTilemapHandlers(connection);

        connection.RegisterMethod("mesh/inspect", (params_, _) =>
        {
            var p = Deserialize<MeshInspectParams>(params_);
            MeshSharedMemoryReader? reader;
            lock (_gate)
            {
                if (string.IsNullOrEmpty(p.MeshId) || !_meshReaders.TryGetValue(p.MeshId, out reader))
                {
                    throw new JsonRpcException(RpcErrorCode.UnknownMesh, $"Mesh \"{p.MeshId}\" is not bound");
                }
            }

            if (!reader.TryReadStable(out var snapshot))
            {
                throw new JsonRpcException(
                    RpcErrorCode.SharedMemoryUnavailable,
                    $"Mesh \"{p.MeshId}\": could not take a stable snapshot (writer busy)");
            }

            var sampleIndex = Math.Clamp(p.SampleIndex, 0, reader.VertexCount - 1);
            var v = reader.Vertices[sampleIndex];
            return ValueTask.FromResult<object?>(new
            {
                meshId = p.MeshId,
                vertexCount = reader.VertexCount,
                strideInBytes = reader.StrideInBytes,
                frameIndex = snapshot.FrameIndex,
                checksumFnv1a = reader.ComputeChecksum(),
                sample = new
                {
                    index = sampleIndex,
                    position = new[] { v.Position.X, v.Position.Y },
                    uv = new[] { v.Uv.X, v.Uv.Y },
                    boneIndices = new int[] { v.BoneIndex(0), v.BoneIndex(1), v.BoneIndex(2), v.BoneIndex(3) },
                    boneWeights = new[] { v.BoneWeights.X, v.BoneWeights.Y, v.BoneWeights.Z, v.BoneWeights.W },
                },
            });
        });
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var reader in _meshReaders.Values)
            {
                reader.Dispose();
            }

            _meshReaders.Clear();
        }
    }

    private void RegisterCameraHandlers(JsonRpcConnection connection)
    {
        connection.RegisterMethod("camera/configure", (params_, _) =>
        {
            var p = Deserialize<CameraConfigureParams>(params_);
            CameraConfig config;
            lock (_gate)
            {
                config = MergeConfig(Camera.Config, p);
                Camera.Reconfigure(config);
            }

            return ValueTask.FromResult<object?>(ConfigToWire(config));
        });

        connection.RegisterMethod("camera/shake", (params_, _) =>
        {
            var p = Deserialize<CameraShakeParams>(params_);
            if (p.Trauma is not (> 0f and <= 1f))
            {
                throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"trauma\" must be in (0, 1]");
            }

            lock (_gate)
            {
                Camera.AddTrauma(p.Trauma);
                return ValueTask.FromResult<object?>(new { trauma = Camera.Trauma });
            }
        });

        connection.RegisterMethod("camera/simulate", (params_, _) =>
        {
            var p = Deserialize<CameraSimulateParams>(params_);
            if (p.Steps is < 1 or > 100_000)
            {
                throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"steps\" must be in [1, 100000]");
            }

            if (p.DeltaSeconds is not (> 0f and <= 1f))
            {
                throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"deltaSeconds\" must be in (0, 1]");
            }

            var target = ToVector2(p.Target, "target");
            var velocity = p.TargetVelocity is null ? Vector2.Zero : ToVector2(p.TargetVelocity, "targetVelocity");
            var initial = p.Initial is null ? Vector2.Zero : ToVector2(p.Initial, "initial");

            // Simulação determinística em uma câmera efêmera com a config
            // corrente — não perturba a câmera viva do serviço.
            CameraConfig config;
            lock (_gate)
            {
                config = Camera.Config;
            }

            var sim = new CinematicCamera(config, initial);
            sim.Snap(initial);
            if (p.Trauma is > 0f)
            {
                sim.AddTrauma(Math.Clamp(p.Trauma.Value, 0f, 1f));
            }

            var sampleEvery = Math.Max(1, p.Steps / 64);
            var samples = new List<float[]>(70);
            var maxShakeMagnitude = 0f;
            for (var step = 0; step < p.Steps; step++)
            {
                sim.Update(p.DeltaSeconds, target, velocity);
                maxShakeMagnitude = MathF.Max(maxShakeMagnitude, sim.ShakeOffset.Length());
                if (step % sampleEvery == 0 || step == p.Steps - 1)
                {
                    samples.Add([sim.Position.X, sim.Position.Y]);
                }
            }

            return ValueTask.FromResult<object?>(new
            {
                final = new[] { sim.Position.X, sim.Position.Y },
                finalVelocity = new[] { sim.Velocity.X, sim.Velocity.Y },
                samples,
                maxShakeMagnitude,
                finalTrauma = sim.Trauma,
            });
        });
    }

    private void RegisterLightingHandlers(JsonRpcConnection connection)
    {
        connection.RegisterMethod("lighting/add", (params_, _) =>
        {
            var p = Deserialize<LightingAddParams>(params_);
            var data = ToLightData(p);
            lock (_gate)
            {
                LightHandle handle;
                try
                {
                    handle = Lights.Add(data);
                }
                catch (InvalidOperationException ex)
                {
                    throw new JsonRpcException(RpcErrorCode.InternalError, ex.Message);
                }

                return ValueTask.FromResult<object?>(new { lightId = handle.Slot });
            }
        });

        connection.RegisterMethod("lighting/remove", (params_, _) =>
        {
            var p = Deserialize<LightingRemoveParams>(params_);
            lock (_gate)
            {
                var handle = new LightHandle(p.LightId);
                if (!Lights.IsActive(handle))
                {
                    throw new JsonRpcException(RpcErrorCode.InvalidParams, $"Light {p.LightId} is not active");
                }

                Lights.Remove(handle);
                return ValueTask.FromResult<object?>(new { removed = p.LightId });
            }
        });

        connection.RegisterMethod("lighting/inspect", (_, _) =>
        {
            lock (_gate)
            {
                var lights = new List<object>(Lights.LiveCount);
                for (var slot = 0; slot < Lights.Capacity; slot++)
                {
                    var handle = new LightHandle(slot);
                    if (!Lights.IsActive(handle))
                    {
                        continue;
                    }

                    var d = Lights.Get(handle);
                    lights.Add(new
                    {
                        lightId = slot,
                        type = d.Type.ToString().ToLowerInvariant(),
                        position = new[] { d.Position.X, d.Position.Y },
                        height = d.Height,
                        direction = new[] { d.Direction.X, d.Direction.Y },
                        color = new[] { d.Color.X, d.Color.Y, d.Color.Z },
                        intensity = d.Intensity,
                        radius = d.Radius,
                    });
                }

                return ValueTask.FromResult<object?>(new
                {
                    count = Lights.LiveCount,
                    capacity = Lights.Capacity,
                    lights,
                });
            }
        });

        connection.RegisterMethod("lighting/evaluate", (params_, _) =>
        {
            var p = Deserialize<LightingEvaluateParams>(params_);
            var surface = ToVector2(p.Surface, "surface");
            if (p.Normal is not { Length: 3 })
            {
                throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"normal\" must contain 3 floats");
            }

            var normal = new Vector3(p.Normal[0], p.Normal[1], p.Normal[2]);
            lock (_gate)
            {
                var rgb = Lights.Accumulate(surface, normal);
                return ValueTask.FromResult<object?>(new { rgb = new[] { rgb.X, rgb.Y, rgb.Z } });
            }
        });
    }

    private void RegisterTilemapHandlers(JsonRpcConnection connection)
    {
        connection.RegisterMethod("tilemap/define", (params_, _) =>
        {
            var p = Deserialize<TilemapDefineParams>(params_);
            if (string.IsNullOrEmpty(p.TilemapId))
            {
                throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"tilemapId\" must be a non-empty string");
            }

            if (p.Width < 1 || p.Height < 1 || (long)p.Width * p.Height > TilemapStore.MaxCells)
            {
                throw new JsonRpcException(
                    RpcErrorCode.InvalidParams,
                    $"tilemap must have between 1 and {TilemapStore.MaxCells} cells");
            }

            var cellCount = p.Width * p.Height;
            if (p.IntGrid is null || p.IntGrid.Length != cellCount ||
                p.Tiles is null || p.Tiles.Length != cellCount)
            {
                throw new JsonRpcException(
                    RpcErrorCode.InvalidBinaryLayout,
                    $"\"intGrid\" and \"tiles\" must have exactly {cellCount} cells");
            }

            lock (_gate)
            {
                if (Tilemaps.Find(p.TilemapId).IsValid)
                {
                    throw new JsonRpcException(RpcErrorCode.DuplicateId, $"Tilemap \"{p.TilemapId}\" is already defined");
                }

                TilemapHandle handle;
                try
                {
                    handle = Tilemaps.Define(
                        p.TilemapId, p.Width, p.Height, p.TileSize > 0 ? p.TileSize : 16,
                        p.IntGrid, p.Tiles);
                }
                catch (InvalidOperationException ex)
                {
                    throw new JsonRpcException(RpcErrorCode.InternalError, ex.Message);
                }

                return ValueTask.FromResult<object?>(new
                {
                    tilemapId = p.TilemapId,
                    nonEmptyTiles = Tilemaps.NonEmptyTiles(handle),
                    checksumFnv1a = Tilemaps.ComputeChecksum(handle),
                    // consolidação: um único buffer estático por tilemap
                    staticBatches = 1,
                    status = "defined",
                });
            }
        });

        connection.RegisterMethod("tilemap/inspect", (params_, _) =>
        {
            var p = Deserialize<TilemapInspectParams>(params_);
            lock (_gate)
            {
                var handle = Tilemaps.Find(p.TilemapId ?? "");
                if (!handle.IsValid)
                {
                    throw new JsonRpcException(RpcErrorCode.InvalidParams, $"Tilemap \"{p.TilemapId}\" is not defined");
                }

                object? cell = null;
                if (p.Cell is { Length: 2 })
                {
                    var x = p.Cell[0];
                    var y = p.Cell[1];
                    if (x < 0 || y < 0 || x >= Tilemaps.Width(handle) || y >= Tilemaps.Height(handle))
                    {
                        throw new JsonRpcException(RpcErrorCode.InvalidParams, $"cell ({x}, {y}) out of bounds");
                    }

                    cell = new
                    {
                        x,
                        y,
                        intGridValue = (int)Tilemaps.IntGridAt(handle, x, y),
                        tileId = Tilemaps.TileAt(handle, x, y),
                    };
                }

                return ValueTask.FromResult<object?>(new
                {
                    tilemapId = p.TilemapId,
                    width = Tilemaps.Width(handle),
                    height = Tilemaps.Height(handle),
                    tileSize = Tilemaps.TileSize(handle),
                    nonEmptyTiles = Tilemaps.NonEmptyTiles(handle),
                    checksumFnv1a = Tilemaps.ComputeChecksum(handle),
                    cell,
                });
            }
        });
    }

    private static CameraConfig MergeConfig(in CameraConfig current, CameraConfigureParams p)
    {
        var config = current with
        {
            Frequency = p.Frequency ?? current.Frequency,
            Damping = p.Damping ?? current.Damping,
            Response = p.Response ?? current.Response,
            AnticipationSeconds = p.AnticipationSeconds ?? current.AnticipationSeconds,
            ShakeFrequencyHz = p.ShakeFrequencyHz ?? current.ShakeFrequencyHz,
            ShakeMaxOffset = p.ShakeMaxOffset ?? current.ShakeMaxOffset,
            ShakeMaxRotationRadians = p.ShakeMaxRotationRadians ?? current.ShakeMaxRotationRadians,
            ShakeTraumaDecayPerSecond = p.ShakeTraumaDecayPerSecond ?? current.ShakeTraumaDecayPerSecond,
            ShakeSeed = p.ShakeSeed ?? current.ShakeSeed,
        };

        if (config.Frequency <= 0f || config.Damping < 0f)
        {
            throw new JsonRpcException(
                RpcErrorCode.InvalidParams, "\"frequency\" must be > 0 and \"damping\" >= 0");
        }

        return config;
    }

    private static object ConfigToWire(in CameraConfig c) => new
    {
        frequency = c.Frequency,
        damping = c.Damping,
        response = c.Response,
        anticipationSeconds = c.AnticipationSeconds,
        shakeFrequencyHz = c.ShakeFrequencyHz,
        shakeMaxOffset = c.ShakeMaxOffset,
        shakeMaxRotationRadians = c.ShakeMaxRotationRadians,
        shakeTraumaDecayPerSecond = c.ShakeTraumaDecayPerSecond,
        shakeSeed = c.ShakeSeed,
    };

    private static LightData ToLightData(LightingAddParams p)
    {
        var type = p.Type switch
        {
            "directional" => LightType.Directional,
            "point" => LightType.Point,
            "spot" => LightType.Spot,
            _ => throw new JsonRpcException(
                RpcErrorCode.InvalidParams, "\"type\" must be \"directional\", \"point\" or \"spot\""),
        };

        if (p.Color is not { Length: 3 })
        {
            throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"color\" must contain 3 floats");
        }

        if (p.Intensity is not > 0f)
        {
            throw new JsonRpcException(RpcErrorCode.InvalidParams, "\"intensity\" must be > 0");
        }

        var position = p.Position is null ? Vector2.Zero : ToVector2(p.Position, "position");
        var direction = p.Direction is null ? new Vector2(0f, -1f) : ToVector2(p.Direction, "direction");

        if (type is LightType.Point or LightType.Spot && p.Radius is not > 0f)
        {
            throw new JsonRpcException(
                RpcErrorCode.InvalidParams, $"\"radius\" must be > 0 for {p.Type} lights");
        }

        var innerCos = 1f;
        var outerCos = 0f;
        if (type is LightType.Spot)
        {
            if (p.InnerConeDegrees is not (> 0f and < 180f) ||
                p.OuterConeDegrees is not (> 0f and < 180f) ||
                p.OuterConeDegrees < p.InnerConeDegrees)
            {
                throw new JsonRpcException(
                    RpcErrorCode.InvalidParams,
                    "spot lights require 0 < innerConeDegrees <= outerConeDegrees < 180");
            }

            innerCos = MathF.Cos(p.InnerConeDegrees.Value * MathF.PI / 180f / 2f);
            outerCos = MathF.Cos(p.OuterConeDegrees.Value * MathF.PI / 180f / 2f);
        }

        return new LightData(
            type,
            position,
            p.Height ?? 0f,
            direction,
            new Vector3(p.Color[0], p.Color[1], p.Color[2]),
            p.Intensity.Value,
            p.Radius ?? 0f,
            innerCos,
            outerCos);
    }

    private static Vector2 ToVector2(float[]? values, string field)
    {
        if (values is not { Length: 2 })
        {
            throw new JsonRpcException(RpcErrorCode.InvalidParams, $"\"{field}\" must contain 2 floats");
        }

        return new Vector2(values[0], values[1]);
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

    public sealed record MeshInspectParams(string? MeshId, int SampleIndex);

    public sealed record CameraConfigureParams(
        float? Frequency,
        float? Damping,
        float? Response,
        float? AnticipationSeconds,
        float? ShakeFrequencyHz,
        float? ShakeMaxOffset,
        float? ShakeMaxRotationRadians,
        float? ShakeTraumaDecayPerSecond,
        uint? ShakeSeed);

    public sealed record CameraShakeParams(float Trauma);

    public sealed record CameraSimulateParams(
        int Steps,
        float DeltaSeconds,
        float[]? Target,
        float[]? TargetVelocity,
        float[]? Initial,
        float? Trauma);

    public sealed record LightingAddParams(
        string? Type,
        float[]? Position,
        float? Height,
        float[]? Direction,
        float[]? Color,
        float? Intensity,
        float? Radius,
        float? InnerConeDegrees,
        float? OuterConeDegrees);

    public sealed record LightingRemoveParams(int LightId);

    public sealed record LightingEvaluateParams(float[]? Surface, float[]? Normal);

    public sealed record TilemapDefineParams(
        string? TilemapId,
        int Width,
        int Height,
        int TileSize,
        short[]? IntGrid,
        int[]? Tiles);

    public sealed record TilemapInspectParams(string? TilemapId, int[]? Cell);
}
