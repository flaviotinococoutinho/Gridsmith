using System.Numerics;
using P7m.Engine.Core.Camera;
using P7m.Engine.Core.SharedMemory;
using P7m.Engine.Runtime;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

/// <summary>
/// Prova que uma troca de projeto limpa o agregado inteiro da engine em uma
/// única operação do plano de controle, inclusive recursos nativos de malha.
/// </summary>
public sealed class EngineSessionResetTests : IAsyncLifetime
{
    private static readonly float[] Identity = [1, 0, 0, 1, 0, 0];

    private JsonRpcConnection _middleware = null!;
    private JsonRpcConnection _engine = null!;
    private EngineService _service = null!;
    private CancellationTokenSource _cts = null!;

    public async Task InitializeAsync()
    {
        var (middlewareSide, engineSide) = await LoopbackStreamPair.CreateAsync();
        _middleware = new JsonRpcConnection(middlewareSide, "middleware", TimeSpan.FromSeconds(5));
        _engine = new JsonRpcConnection(engineSide, "engine", TimeSpan.FromSeconds(5));
        _service = new EngineService(maxSkeletons: 2, maxLights: 4, maxTilemaps: 2, maxActors: 4);
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
    public async Task Reset_session_clears_every_project_subsystem_and_allows_id_reuse()
    {
        await _middleware.RequestAsync("skeleton/initialize", Skeleton("rig"), _cts.Token);

        using var meshFile = new MeshFileBuilder($"p7m-reset-{Guid.NewGuid():N}");
        meshFile.Create(1).Publish(new SkinnedVertex2D());
        await _middleware.RequestAsync("mesh/bind_shared_memory", new
        {
            meshId = "mesh",
            skeletonId = "rig",
            sharedMemoryMapName = meshFile.MapName,
            vertexCount = 1,
            strideInBytes = 36,
        }, _cts.Token);
        var oldReader = _service.MeshReaders["mesh"];

        await _middleware.RequestAsync("camera/configure", new
        {
            frequency = 7f,
            damping = 0.4f,
        }, _cts.Token);
        await _middleware.RequestAsync("camera/shake", new { trauma = 0.8f }, _cts.Token);
        _service.Camera.Snap(new Vector2(40f, -12f));

        await _middleware.RequestAsync("lighting/add", Light(), _cts.Token);
        await _middleware.RequestAsync("tilemap/define", Tilemap("level"), _cts.Token);
        await _middleware.RequestAsync("entity/spawn", Actor("player"), _cts.Token);

        Assert.Equal(1, _service.Skeletons.LiveCount);
        Assert.Single(_service.MeshReaders);
        Assert.Equal(1, _service.Lights.LiveCount);
        Assert.Equal(1, _service.Tilemaps.LiveCount);
        Assert.Equal(1, _service.Actors.LiveCount);

        var reset = await _middleware.RequestAsync("engine/reset_session", new { }, _cts.Token);

        Assert.Equal("reset", reset.GetProperty("status").GetString());
        Assert.Equal(0, reset.GetProperty("skeletons").GetInt32());
        Assert.Equal(0, reset.GetProperty("meshes").GetInt32());
        Assert.Equal(0, reset.GetProperty("lights").GetInt32());
        Assert.Equal(0, reset.GetProperty("tilemaps").GetInt32());
        Assert.Equal(0, reset.GetProperty("actors").GetInt32());

        Assert.Equal(0, _service.Skeletons.LiveCount);
        Assert.Empty(_service.MeshBindings);
        Assert.Empty(_service.MeshReaders);
        Assert.Equal(CameraConfig.Default, _service.Camera.Config);
        Assert.Equal(Vector2.Zero, _service.Camera.Position);
        Assert.Equal(0f, _service.Camera.Trauma);
        Assert.Equal(0, _service.Lights.LiveCount);
        Assert.Equal(0, _service.Tilemaps.LiveCount);
        Assert.Equal(0, _service.Actors.LiveCount);
        Assert.Throws<ObjectDisposedException>(() => oldReader.TryReadStable(out _));

        // O reset troca a sessão; os mesmos ids do projeto anterior voltam a
        // ser válidos, provando que nenhum registro residual ficou acessível.
        await _middleware.RequestAsync("skeleton/initialize", Skeleton("rig"), _cts.Token);
        await _middleware.RequestAsync("mesh/bind_shared_memory", new
        {
            meshId = "mesh",
            skeletonId = "rig",
            sharedMemoryMapName = meshFile.MapName,
            vertexCount = 1,
            strideInBytes = 36,
        }, _cts.Token);
        await _middleware.RequestAsync("lighting/add", Light(), _cts.Token);
        await _middleware.RequestAsync("tilemap/define", Tilemap("level"), _cts.Token);
        await _middleware.RequestAsync("entity/spawn", Actor("player"), _cts.Token);

        Assert.Equal(1, _service.Skeletons.LiveCount);
        Assert.Single(_service.MeshReaders);
        Assert.Equal(1, _service.Lights.LiveCount);
        Assert.Equal(1, _service.Tilemaps.LiveCount);
        Assert.Equal(1, _service.Actors.LiveCount);
    }

    private static object Skeleton(string id) => new
    {
        skeletonId = id,
        bones = new object[] { new { id = 0, parentId = -1, inverseBindMatrix = Identity } },
    };

    private static object Light() => new
    {
        type = "point",
        position = new[] { 0f, 0f },
        height = 4f,
        color = new[] { 1f, 1f, 1f },
        intensity = 1f,
        radius = 20f,
    };

    private static object Tilemap(string id) => new
    {
        tilemapId = id,
        width = 1,
        height = 1,
        tileSize = 16,
        intGrid = new[] { 1 },
        tiles = new[] { 3 },
    };

    private static object Actor(string id) => new
    {
        entityId = id,
        archetypeId = "hero",
        position = new[] { 2f, 3f },
    };
}
