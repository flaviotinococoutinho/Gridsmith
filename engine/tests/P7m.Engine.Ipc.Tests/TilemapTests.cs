using P7m.Engine.Core.Level;
using P7m.Engine.Ipc.Protocol;
using P7m.Engine.Runtime;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

public class TilemapStoreTests
{
    private static (short[] IntGrid, int[] Tiles) MakeCells(int count, Func<int, short> grid, Func<int, int> tile)
    {
        var intGrid = new short[count];
        var tiles = new int[count];
        for (var i = 0; i < count; i++)
        {
            intGrid[i] = grid(i);
            tiles[i] = tile(i);
        }

        return (intGrid, tiles);
    }

    [Fact]
    public void Define_and_query_cells_roundtrip()
    {
        var store = new TilemapStore(2);
        var (intGrid, tiles) = MakeCells(6, i => (short)(i % 2), i => i % 2 == 0 ? -1 : 40 + i);
        var handle = store.Define("level-1", width: 3, height: 2, tileSize: 16, intGrid, tiles);

        Assert.True(handle.IsValid);
        Assert.Equal(handle, store.Find("level-1"));
        Assert.Equal(3, store.Width(handle));
        Assert.Equal(2, store.Height(handle));
        Assert.Equal(3, store.NonEmptyTiles(handle)); // células ímpares têm tile
        Assert.Equal(1, store.IntGridAt(handle, 1, 0));
        Assert.Equal(41, store.TileAt(handle, 1, 0));
        Assert.Equal(-1, store.TileAt(handle, 0, 0));
    }

    [Fact]
    public void Define_rejects_wrong_cell_counts_and_duplicates()
    {
        var store = new TilemapStore(2);
        Assert.Throws<ArgumentException>(() =>
            store.Define("bad", 2, 2, 16, new short[3], new int[4]));

        var (grid, tiles) = MakeCells(4, _ => 0, _ => -1);
        store.Define("dup", 2, 2, 16, grid, tiles);
        Assert.Throws<InvalidOperationException>(() =>
            store.Define("dup", 2, 2, 16, grid, tiles));
    }

    [Fact]
    public void Remove_frees_the_slot_for_reuse()
    {
        var store = new TilemapStore(1);
        var (grid, tiles) = MakeCells(4, _ => 1, i => i);
        var handle = store.Define("first", 2, 2, 16, grid, tiles);

        store.Remove(handle);
        Assert.Equal(0, store.LiveCount);
        Assert.False(store.Find("first").IsValid);
        Assert.Throws<InvalidOperationException>(() => store.Remove(handle)); // já liberado

        // capacidade fixa: o slot liberado é reutilizado
        var reused = store.Define("second", 2, 2, 16, grid, tiles);
        Assert.Equal(handle.Slot, reused.Slot);
    }

    [Fact]
    public void Checksum_is_deterministic_and_content_sensitive()
    {
        var store = new TilemapStore(3);
        var (grid, tiles) = MakeCells(4, _ => 1, i => i);
        var a = store.Define("a", 2, 2, 16, grid, tiles);
        var b = store.Define("b", 2, 2, 16, grid, tiles);
        Assert.Equal(store.ComputeChecksum(a), store.ComputeChecksum(b));

        tiles[3] = 99;
        var c = store.Define("c", 2, 2, 16, grid, tiles);
        Assert.NotEqual(store.ComputeChecksum(a), store.ComputeChecksum(c));
    }

    [Fact]
    public void Queries_and_checksum_are_allocation_free()
    {
        var store = new TilemapStore(1);
        var (grid, tiles) = MakeCells(64 * 64, i => (short)(i % 3), i => i % 5 - 1);
        var handle = store.Define("hot", 64, 64, 16, grid, tiles);
        for (var w = 0; w < 200; w++) // aquecimento além do tiered JIT
        {
            store.ComputeChecksum(handle);
            store.TileAt(handle, w % 64, (w * 7) % 64);
            store.IntGridAt(handle, (w * 3) % 64, w % 64);
        }

        var before = GC.GetAllocatedBytesForCurrentThread();
        long sum = 0;
        for (var frame = 0; frame < 100; frame++)
        {
            sum += store.ComputeChecksum(handle);
            sum += store.TileAt(handle, frame % 64, (frame * 7) % 64);
            sum += store.IntGridAt(handle, (frame * 3) % 64, frame % 64);
        }

        Assert.Equal(0, GC.GetAllocatedBytesForCurrentThread() - before);
        Assert.NotEqual(0, sum);
    }
}

public class EngineServiceTilemapTests : IAsyncLifetime
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
        _service = new EngineService(maxTilemaps: 2);
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
    public async Task Define_reports_consolidation_and_inspect_reads_cells()
    {
        var defined = await _middleware.RequestAsync("tilemap/define", new
        {
            tilemapId = "dungeon",
            width = 3,
            height = 2,
            tileSize = 16,
            intGrid = new[] { 1, 1, 0, 1, 0, 0 },
            tiles = new[] { 10, 11, -1, 12, -1, -1 },
        }, _cts.Token);

        Assert.Equal("defined", defined.GetProperty("status").GetString());
        Assert.Equal(3, defined.GetProperty("nonEmptyTiles").GetInt32());
        Assert.Equal(1, defined.GetProperty("staticBatches").GetInt32());

        var inspected = await _middleware.RequestAsync("tilemap/inspect", new
        {
            tilemapId = "dungeon",
            cell = new[] { 1, 0 },
        }, _cts.Token);

        Assert.Equal(3, inspected.GetProperty("width").GetInt32());
        var cell = inspected.GetProperty("cell");
        Assert.Equal(1, cell.GetProperty("intGridValue").GetInt32());
        Assert.Equal(11, cell.GetProperty("tileId").GetInt32());
        Assert.Equal(
            defined.GetProperty("checksumFnv1a").GetUInt32(),
            inspected.GetProperty("checksumFnv1a").GetUInt32());
    }

    [Fact]
    public async Task Define_validates_cell_count_and_duplicate()
    {
        var wrongCount = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("tilemap/define", new
            {
                tilemapId = "bad",
                width = 2,
                height = 2,
                tileSize = 16,
                intGrid = new[] { 1 },
                tiles = new[] { 1, 2, 3, 4 },
            }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidBinaryLayout, wrongCount.Code);

        object Valid() => new
        {
            tilemapId = "dup",
            width = 1,
            height = 1,
            tileSize = 16,
            intGrid = new[] { 1 },
            tiles = new[] { 5 },
        };
        await _middleware.RequestAsync("tilemap/define", Valid(), _cts.Token);
        var dup = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("tilemap/define", Valid(), _cts.Token));
        Assert.Equal(RpcErrorCode.DuplicateId, dup.Code);
    }

    [Fact]
    public async Task Remove_via_rpc_completes_the_lifecycle()
    {
        object Params() => new
        {
            tilemapId = "temp",
            width = 1,
            height = 1,
            tileSize = 16,
            intGrid = new[] { 1 },
            tiles = new[] { 3 },
        };
        await _middleware.RequestAsync("tilemap/define", Params(), _cts.Token);
        var removed = await _middleware.RequestAsync("tilemap/remove", new { tilemapId = "temp" }, _cts.Token);
        Assert.Equal("temp", removed.GetProperty("removed").GetString());

        // redefinir após remover é permitido (slot reciclado)
        await _middleware.RequestAsync("tilemap/define", Params(), _cts.Token);

        var unknown = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("tilemap/remove", new { tilemapId = "ghost" }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, unknown.Code);
    }

    [Fact]
    public async Task Describe_announces_level_subsystem()
    {
        var manifest = await _middleware.RequestAsync("engine/describe", null, _cts.Token);
        var level = manifest.GetProperty("subsystems").GetProperty("level");
        Assert.Equal("available", level.GetProperty("status").GetString());
        Assert.Equal(2, level.GetProperty("limits").GetProperty("maxTilemaps").GetInt32());
        Assert.Equal("level-editor", level.GetProperty("editor").GetProperty("panel").GetString());

        // conceitos da pesquisa registrados no manifesto
        var stateMachines = manifest.GetProperty("subsystems").GetProperty("stateMachines");
        Assert.Equal("planned", stateMachines.GetProperty("status").GetString());
        var assets = manifest.GetProperty("subsystems").GetProperty("assets");
        Assert.Contains(
            "aseprite-import",
            assets.GetProperty("features").EnumerateArray().Select(f => f.GetString()));
    }
}
