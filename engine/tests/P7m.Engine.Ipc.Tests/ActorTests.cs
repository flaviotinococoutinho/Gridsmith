using P7m.Engine.Core.Actors;
using P7m.Engine.Ipc.Protocol;
using P7m.Engine.Runtime;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

public class ActorStoreTests
{
    [Fact]
    public void Spawn_and_query_roundtrip()
    {
        var store = new ActorStore(4);
        var handle = store.Spawn("player-1", "player", 48f, 336f);

        Assert.True(handle.IsValid);
        Assert.Equal(handle, store.Find("player-1"));
        Assert.Equal("player-1", store.EntityId(handle));
        Assert.Equal("player", store.ArchetypeId(handle));
        Assert.Equal(48f, store.PositionX(handle));
        Assert.Equal(336f, store.PositionY(handle));
        Assert.Equal(1, store.LiveCount);
    }

    [Fact]
    public void Spawn_rejects_duplicates_and_full_store()
    {
        var store = new ActorStore(1);
        store.Spawn("only", "player", 0f, 0f);
        Assert.Throws<InvalidOperationException>(() => store.Spawn("only", "player", 1f, 1f));
        Assert.Throws<InvalidOperationException>(() => store.Spawn("other", "player", 1f, 1f));
    }

    [Fact]
    public void Despawn_frees_the_slot_for_reuse()
    {
        var store = new ActorStore(1);
        var handle = store.Spawn("first", "player", 0f, 0f);

        store.Despawn(handle);
        Assert.Equal(0, store.LiveCount);
        Assert.False(store.Find("first").IsValid);
        Assert.Throws<InvalidOperationException>(() => store.Despawn(handle)); // já liberado

        // capacidade fixa: o slot liberado é reutilizado
        var reused = store.Spawn("second", "enemy", 2f, 3f);
        Assert.Equal(handle.Slot, reused.Slot);
        Assert.Equal("enemy", store.ArchetypeId(reused));
    }

    [Fact]
    public void MoveTo_updates_position_of_live_actor_only()
    {
        var store = new ActorStore(2);
        var handle = store.Spawn("mover", "player", 0f, 0f);

        store.MoveTo(handle, 10f, 20f);
        Assert.Equal(10f, store.PositionX(handle));
        Assert.Equal(20f, store.PositionY(handle));

        store.Despawn(handle);
        Assert.Throws<InvalidOperationException>(() => store.MoveTo(handle, 1f, 1f));
    }

    [Fact]
    public void Find_and_MoveTo_are_allocation_free()
    {
        var store = new ActorStore(8);
        var handle = store.Spawn("hot", "player", 0f, 0f);
        for (var w = 0; w < 1000; w++) // aquecimento além do tiered JIT
        {
            store.Find("hot");
            store.MoveTo(handle, w, w);
        }

        float sum = 0;
        var allocated = AllocationProbe.MinimumAllocatedBytes(() =>
        {
            for (var frame = 0; frame < 100; frame++)
            {
                store.MoveTo(handle, frame, frame * 2f);
                sum += store.PositionX(store.Find("hot"));
            }
        });

        Assert.Equal(0, allocated);
        Assert.NotEqual(0f, sum);
    }
}

public class EngineServiceActorTests : IAsyncLifetime
{
    private JsonRpcConnection _middleware = null!;
    private JsonRpcConnection _engine = null!;
    private EngineService _service = null!;
    private CancellationTokenSource _cts = null!;

    public async Task InitializeAsync()
    {
        var (middlewareSide, engineSide) = await LoopbackStreamPair.CreateAsync();
        _middleware = new JsonRpcConnection(middlewareSide, "middleware", TimeSpan.FromSeconds(5));
        _engine = new JsonRpcConnection(engineSide, "engine", TimeSpan.FromSeconds(5));
        _service = new EngineService(maxActors: 2);
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
    public async Task Spawn_inspect_despawn_lifecycle()
    {
        var spawned = await _middleware.RequestAsync("entity/spawn", new
        {
            entityId = "player-1",
            archetypeId = "player",
            position = new[] { 48f, 336f },
        }, _cts.Token);

        Assert.Equal("spawned", spawned.GetProperty("status").GetString());
        Assert.Equal(1, spawned.GetProperty("liveActors").GetInt32());

        var inspected = await _middleware.RequestAsync("entity/inspect", new { entityId = "player-1" }, _cts.Token);
        Assert.Equal("player", inspected.GetProperty("archetypeId").GetString());
        Assert.Equal(48f, inspected.GetProperty("position")[0].GetSingle());
        Assert.Equal(336f, inspected.GetProperty("position")[1].GetSingle());

        var moved = await _middleware.RequestAsync("entity/move", new
        {
            entityId = "player-1",
            position = new[] { 96f, 320f },
        }, _cts.Token);
        Assert.Equal("moved", moved.GetProperty("status").GetString());
        Assert.Equal(96f, moved.GetProperty("position")[0].GetSingle());

        var reinspected = await _middleware.RequestAsync("entity/inspect", new { entityId = "player-1" }, _cts.Token);
        Assert.Equal(320f, reinspected.GetProperty("position")[1].GetSingle());

        var despawned = await _middleware.RequestAsync("entity/despawn", new { entityId = "player-1" }, _cts.Token);
        Assert.Equal("player-1", despawned.GetProperty("despawned").GetString());
        Assert.Equal(0, despawned.GetProperty("liveActors").GetInt32());

        // referência estável: respawn com o mesmo id volta a funcionar
        await _middleware.RequestAsync("entity/spawn", new
        {
            entityId = "player-1",
            archetypeId = "player",
            position = new[] { 0f, 0f },
        }, _cts.Token);
    }

    [Fact]
    public async Task Spawn_validates_params_and_duplicates()
    {
        var missingArchetype = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("entity/spawn", new
            {
                entityId = "x",
                position = new[] { 0f, 0f },
            }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, missingArchetype.Code);

        object Valid() => new { entityId = "dup", archetypeId = "player", position = new[] { 0f, 0f } };
        await _middleware.RequestAsync("entity/spawn", Valid(), _cts.Token);
        var dup = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("entity/spawn", Valid(), _cts.Token));
        Assert.Equal(RpcErrorCode.DuplicateId, dup.Code);

        var ghost = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("entity/despawn", new { entityId = "ghost" }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, ghost.Code);

        var moveGhost = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("entity/move", new { entityId = "ghost", position = new[] { 0f, 0f } }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, moveGhost.Code);
    }

    [Fact]
    public async Task Describe_announces_actor_subsystem()
    {
        var manifest = await _middleware.RequestAsync("engine/describe", null, _cts.Token);
        var actors = manifest.GetProperty("subsystems").GetProperty("actors");
        Assert.Equal("available", actors.GetProperty("status").GetString());
        Assert.Equal(2, actors.GetProperty("limits").GetProperty("maxActors").GetInt32());
        Assert.Contains(
            "archetype-spawn",
            actors.GetProperty("features").EnumerateArray().Select(f => f.GetString()));
    }

    [Fact]
    public async Task Manifest_editor_property_types_respect_the_published_contract()
    {
        // engine.describe.schema.json restringe o hint "type" a este enum; o
        // manifesto inteiro é validado para o drift não passar despercebido
        var allowed = new[] { "float", "int", "bool", "enum", "curve", "color" };
        var manifest = await _middleware.RequestAsync("engine/describe", null, _cts.Token);

        foreach (var subsystem in manifest.GetProperty("subsystems").EnumerateObject())
        {
            if (!subsystem.Value.TryGetProperty("editor", out var editor) ||
                !editor.TryGetProperty("properties", out var properties))
            {
                continue;
            }

            foreach (var property in properties.EnumerateArray())
            {
                var type = property.GetProperty("type").GetString();
                Assert.Contains(type, allowed);
            }
        }
    }
}
