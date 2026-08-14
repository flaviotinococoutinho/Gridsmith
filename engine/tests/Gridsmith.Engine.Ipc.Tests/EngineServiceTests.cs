using Gridsmith.Engine.Core.SharedMemory;
using Gridsmith.Engine.Ipc.Protocol;
using Gridsmith.Engine.Runtime;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// Exercita os handlers do serviço através de um canal JSON-RPC real
/// (loopback), como o middleware faria.
/// </summary>
public class EngineServiceTests : IAsyncLifetime
{
    private JsonRpcConnection _middleware = null!;
    private JsonRpcConnection _engine = null!;
    private EngineService _service = null!;
    private CancellationTokenSource _cts = null!;

    private static readonly float[] Identity = [1, 0, 0, 1, 0, 0];

    public async Task InitializeAsync()
    {
        var (middlewareSide, engineSide) = await LoopbackStreamPair.CreateAsync();
        _middleware = new JsonRpcConnection(middlewareSide, "middleware", TimeSpan.FromSeconds(5));
        _engine = new JsonRpcConnection(engineSide, "engine", TimeSpan.FromSeconds(5));
        _service = new EngineService(maxSkeletons: 4);
        _service.RegisterHandlers(_engine);
        _cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        _ = Task.Run(() => _middleware.RunAsync(_cts.Token));
        _ = Task.Run(() => _engine.RunAsync(_cts.Token));
    }

    public async Task DisposeAsync()
    {
        await _middleware.DisposeAsync();
        await _engine.DisposeAsync();
        _service.Dispose();
        _cts.Dispose();
    }

    [Fact]
    public async Task Ping_echoes_payload_and_raises_event()
    {
        string? seen = null;
        _service.PingReceived += p => seen = p;

        var result = await _middleware.RequestAsync("engine/ping", new { payload = "marco" }, _cts.Token);

        Assert.Equal("marco", result.GetProperty("echo").GetString());
        Assert.Equal("marco", seen);
    }

    [Fact]
    public async Task Skeleton_initialize_registers_topology_out_of_order()
    {
        // Filho declarado antes do pai: o serviço deve reordenar topologicamente.
        var result = await _middleware.RequestAsync("skeleton/initialize", new
        {
            skeletonId = "hero-rig",
            bones = new object[]
            {
                new { id = 7, parentId = 3, inverseBindMatrix = Identity },
                new { id = 3, parentId = -1, inverseBindMatrix = Identity },
            },
        }, _cts.Token);

        Assert.Equal("initialized", result.GetProperty("status").GetString());
        Assert.Equal(2, result.GetProperty("boneCount").GetInt32());
        Assert.True(_service.Skeletons.Find("hero-rig").IsValid);
    }

    [Fact]
    public async Task Skeleton_with_parent_cycle_is_rejected()
    {
        var ex = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("skeleton/initialize", new
            {
                skeletonId = "cyclic",
                bones = new object[]
                {
                    new { id = 0, parentId = 1, inverseBindMatrix = Identity },
                    new { id = 1, parentId = 0, inverseBindMatrix = Identity },
                },
            }, _cts.Token));

        Assert.Equal(RpcErrorCode.InvalidParams, ex.Code);
        Assert.Contains("cycle", ex.Message);
    }

    [Fact]
    public async Task Duplicate_skeleton_id_is_rejected()
    {
        object MakeParams() => new
        {
            skeletonId = "dup",
            bones = new object[] { new { id = 0, parentId = -1, inverseBindMatrix = Identity } },
        };

        await _middleware.RequestAsync("skeleton/initialize", MakeParams(), _cts.Token);
        var ex = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("skeleton/initialize", MakeParams(), _cts.Token));
        Assert.Equal(RpcErrorCode.DuplicateId, ex.Code);
    }

    [Fact]
    public async Task Mesh_bind_requires_initialized_skeleton()
    {
        var ex = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("mesh/bind_shared_memory", new
            {
                meshId = "orphan",
                skeletonId = "missing",
                sharedMemoryMapName = "map",
                vertexCount = 8,
                strideInBytes = 32,
            }, _cts.Token));
        Assert.Equal(RpcErrorCode.UnknownSkeleton, ex.Code);
    }

    [Fact]
    public async Task Mesh_bind_maps_published_file_and_reports_bound()
    {
        await _middleware.RequestAsync("skeleton/initialize", new
        {
            skeletonId = "rig",
            bones = new object[] { new { id = 0, parentId = -1, inverseBindMatrix = Identity } },
        }, _cts.Token);

        using var builder = new MeshFileBuilder($"gridsmith-test-svc-{Guid.NewGuid():N}");
        builder.Create(128).Publish(new SkinnedVertex2D[128]);

        var result = await _middleware.RequestAsync("mesh/bind_shared_memory", new
        {
            meshId = "rig-mesh",
            skeletonId = "rig",
            sharedMemoryMapName = builder.MapName,
            vertexCount = 128,
            strideInBytes = 36,
        }, _cts.Token);

        Assert.Equal("bound", result.GetProperty("status").GetString());
        Assert.Equal(64 + 128 * 36, result.GetProperty("mappedBytes").GetInt64());
        Assert.True(_service.MeshBindings.ContainsKey("rig-mesh"));
        Assert.True(_service.MeshReaders.ContainsKey("rig-mesh"));
    }

    [Fact]
    public async Task Mesh_bind_without_published_file_reports_shared_memory_unavailable()
    {
        await _middleware.RequestAsync("skeleton/initialize", new
        {
            skeletonId = "rig2",
            bones = new object[] { new { id = 0, parentId = -1, inverseBindMatrix = Identity } },
        }, _cts.Token);

        var ex = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("mesh/bind_shared_memory", new
            {
                meshId = "ghost-mesh",
                skeletonId = "rig2",
                sharedMemoryMapName = $"gridsmith-missing-{Guid.NewGuid():N}",
                vertexCount = 8,
                strideInBytes = 36,
            }, _cts.Token));
        Assert.Equal(RpcErrorCode.SharedMemoryUnavailable, ex.Code);
    }

    [Fact]
    public async Task Describe_publishes_capability_manifest_with_real_struct_offsets()
    {
        var manifest = await _middleware.RequestAsync("engine/describe", null, _cts.Token);

        var engine = manifest.GetProperty("engine");
        Assert.Equal("Gridsmith.Engine.Runtime", engine.GetProperty("name").GetString());
        // identidade do runtime hospedeiro: alimenta a resolução de perfil no middleware
        var runtime = engine.GetProperty("runtime");
        Assert.Equal("monogame", runtime.GetProperty("family").GetString());
        Assert.Matches(@"^\d+\.\d+", runtime.GetProperty("version").GetString());
        var subsystems = manifest.GetProperty("subsystems");

        var rigging = subsystems.GetProperty("rigging");
        Assert.Equal("available", rigging.GetProperty("status").GetString());
        Assert.Equal(256, rigging.GetProperty("limits").GetProperty("maxBonesPerSkeleton").GetInt32());
        Assert.Equal("rig-editor", rigging.GetProperty("editor").GetProperty("panel").GetString());

        var layout = subsystems.GetProperty("sharedMemory").GetProperty("vertexLayouts")[0];
        Assert.Equal("SkinnedVertex2D", layout.GetProperty("name").GetString());
        Assert.Equal(36, layout.GetProperty("strideInBytes").GetInt32());
        var fields = layout.GetProperty("fields").EnumerateArray()
            .ToDictionary(f => f.GetProperty("name").GetString()!, f => f.GetProperty("offset").GetInt32());
        Assert.Equal(0, fields["position"]);
        Assert.Equal(8, fields["uv"]);
        Assert.Equal(16, fields["boneIndices"]);
        Assert.Equal(20, fields["boneWeights"]);

        // Fase 3 entregue: câmera e iluminação disponíveis com hints de edição
        Assert.Equal("available", subsystems.GetProperty("camera").GetProperty("status").GetString());
        Assert.Equal("available", subsystems.GetProperty("lighting").GetProperty("status").GetString());
        Assert.Equal(256, subsystems.GetProperty("lighting").GetProperty("limits").GetProperty("maxLights").GetInt32());

        // subsistemas futuros seguem como "planned" com a fase do roteiro
        Assert.Equal("planned", subsystems.GetProperty("assets").GetProperty("status").GetString());
        Assert.Equal(4, subsystems.GetProperty("assets").GetProperty("phase").GetInt32());
    }

    [Fact]
    public async Task Inspect_returns_checksum_and_sample_of_live_buffer()
    {
        await _middleware.RequestAsync("skeleton/initialize", new
        {
            skeletonId = "rig3",
            bones = new object[] { new { id = 0, parentId = -1, inverseBindMatrix = Identity } },
        }, _cts.Token);

        using var builder = new MeshFileBuilder($"gridsmith-test-inspect-{Guid.NewGuid():N}");
        var vertex = new SkinnedVertex2D
        {
            Position = new System.Numerics.Vector2(11, -4),
            Uv = new System.Numerics.Vector2(0.5f, 0.25f),
            BoneIndices = SkinnedVertex2D.PackBoneIndices(0, 2, 0, 0),
            BoneWeights = new System.Numerics.Vector4(0.6f, 0.4f, 0, 0),
        };
        builder.Create(1).Publish(vertex);

        await _middleware.RequestAsync("mesh/bind_shared_memory", new
        {
            meshId = "live-mesh",
            skeletonId = "rig3",
            sharedMemoryMapName = builder.MapName,
            vertexCount = 1,
            strideInBytes = 36,
        }, _cts.Token);

        var inspect = await _middleware.RequestAsync("mesh/inspect", new { meshId = "live-mesh" }, _cts.Token);
        Assert.Equal(1u, inspect.GetProperty("frameIndex").GetUInt32());
        var sample = inspect.GetProperty("sample");
        Assert.Equal(11, sample.GetProperty("position")[0].GetSingle());
        Assert.Equal(-4, sample.GetProperty("position")[1].GetSingle());
        Assert.Equal(2, sample.GetProperty("boneIndices")[1].GetInt32());

        var checksumBefore = inspect.GetProperty("checksumFnv1a").GetUInt32();

        // republica com outro conteúdo: a engine deve enxergar sem re-bind
        vertex.Position = new System.Numerics.Vector2(99, 99);
        builder.Publish(vertex);
        var again = await _middleware.RequestAsync("mesh/inspect", new { meshId = "live-mesh" }, _cts.Token);
        Assert.Equal(2u, again.GetProperty("frameIndex").GetUInt32());
        Assert.NotEqual(checksumBefore, again.GetProperty("checksumFnv1a").GetUInt32());
        Assert.Equal(99, again.GetProperty("sample").GetProperty("position")[0].GetSingle());
    }

    [Fact]
    public async Task Inspect_unknown_mesh_yields_unknown_mesh_error()
    {
        var ex = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("mesh/inspect", new { meshId = "nope" }, _cts.Token));
        Assert.Equal(RpcErrorCode.UnknownMesh, ex.Code);
    }
}
