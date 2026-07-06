using P7m.Engine.Ipc.Protocol;
using P7m.Engine.Runtime;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

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
    public async Task Mesh_bind_accepts_layout_and_reports_deferred()
    {
        await _middleware.RequestAsync("skeleton/initialize", new
        {
            skeletonId = "rig",
            bones = new object[] { new { id = 0, parentId = -1, inverseBindMatrix = Identity } },
        }, _cts.Token);

        var result = await _middleware.RequestAsync("mesh/bind_shared_memory", new
        {
            meshId = "rig-mesh",
            skeletonId = "rig",
            sharedMemoryMapName = "p7m-mesh-rig",
            vertexCount = 128,
            strideInBytes = 32,
        }, _cts.Token);

        Assert.Equal("deferred", result.GetProperty("status").GetString());
        Assert.Equal(4096, result.GetProperty("mappedBytes").GetInt64());
        Assert.True(_service.MeshBindings.ContainsKey("rig-mesh"));
    }
}
