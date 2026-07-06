using System.Text.Json;
using P7m.Engine.Ipc.Protocol;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

public class JsonRpcConnectionTests : IAsyncLifetime
{
    private JsonRpcConnection _sideA = null!;
    private JsonRpcConnection _sideB = null!;
    private CancellationTokenSource _cts = null!;

    public async Task InitializeAsync()
    {
        var (streamA, streamB) = await LoopbackStreamPair.CreateAsync();
        _sideA = new JsonRpcConnection(streamA, "A", TimeSpan.FromSeconds(5));
        _sideB = new JsonRpcConnection(streamB, "B", TimeSpan.FromSeconds(5));
        _cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
    }

    public async Task DisposeAsync()
    {
        await _sideA.DisposeAsync();
        await _sideB.DisposeAsync();
        _cts.Dispose();
    }

    private void StartLoops()
    {
        _ = Task.Run(() => _sideA.RunAsync(_cts.Token));
        _ = Task.Run(() => _sideB.RunAsync(_cts.Token));
    }

    [Fact]
    public async Task Request_response_roundtrip()
    {
        _sideB.RegisterMethod("math/add", (params_, _) =>
        {
            var x = params_!.Value.GetProperty("x").GetInt32();
            var y = params_.Value.GetProperty("y").GetInt32();
            return ValueTask.FromResult<object?>(new { sum = x + y });
        });
        StartLoops();

        var result = await _sideA.RequestAsync("math/add", new { x = 2, y = 3 }, _cts.Token);
        Assert.Equal(5, result.GetProperty("sum").GetInt32());
    }

    [Fact]
    public async Task Channel_is_symmetric_both_sides_originate_requests()
    {
        _sideA.RegisterMethod("echo", (params_, _) => ValueTask.FromResult<object?>(params_));
        _sideB.RegisterMethod("echo", (params_, _) => ValueTask.FromResult<object?>(params_));
        StartLoops();

        var fromA = _sideA.RequestAsync("echo", new { origin = "A" }, _cts.Token);
        var fromB = _sideB.RequestAsync("echo", new { origin = "B" }, _cts.Token);
        await Task.WhenAll(fromA, fromB);

        Assert.Equal("A", fromA.Result.GetProperty("origin").GetString());
        Assert.Equal("B", fromB.Result.GetProperty("origin").GetString());
    }

    [Fact]
    public async Task Concurrent_requests_are_correlated_by_id()
    {
        _sideB.RegisterMethod("slow/identity", async (params_, ct) =>
        {
            var n = params_!.Value.GetProperty("n").GetInt32();
            await Task.Delay((5 - n) * 20, ct); // conclusão em ordem inversa
            return n;
        });
        StartLoops();

        var tasks = Enumerable.Range(0, 5)
            .Select(n => _sideA.RequestAsync("slow/identity", new { n }, _cts.Token))
            .ToArray();
        var results = await Task.WhenAll(tasks);

        Assert.Equal([0, 1, 2, 3, 4], results.Select(r => r.GetInt32()).ToArray());
    }

    [Fact]
    public async Task Unknown_method_yields_method_not_found()
    {
        StartLoops();
        var ex = await Assert.ThrowsAsync<JsonRpcException>(
            () => _sideA.RequestAsync("nao/existe", null, _cts.Token));
        Assert.Equal(RpcErrorCode.MethodNotFound, ex.Code);
    }

    [Fact]
    public async Task Typed_handler_error_propagates_code_and_message()
    {
        _sideB.RegisterMethod("fail/typed", (_, _) =>
            throw new JsonRpcException(RpcErrorCode.UnknownSkeleton, "skeleton missing"));
        StartLoops();

        var ex = await Assert.ThrowsAsync<JsonRpcException>(
            () => _sideA.RequestAsync("fail/typed", null, _cts.Token));
        Assert.Equal(RpcErrorCode.UnknownSkeleton, ex.Code);
        Assert.Equal("skeleton missing", ex.Message);
    }

    [Fact]
    public async Task Generic_handler_error_becomes_internal_error_and_peer_survives()
    {
        _sideB.RegisterMethod("fail/generic", (_, _) => throw new InvalidOperationException("boom"));
        _sideB.RegisterMethod("ok", (_, _) => ValueTask.FromResult<object?>("still alive"));
        StartLoops();

        var ex = await Assert.ThrowsAsync<JsonRpcException>(
            () => _sideA.RequestAsync("fail/generic", null, _cts.Token));
        Assert.Equal(RpcErrorCode.InternalError, ex.Code);

        var ok = await _sideA.RequestAsync("ok", null, _cts.Token);
        Assert.Equal("still alive", ok.GetString());
    }

    [Fact]
    public async Task Notification_is_delivered_without_response()
    {
        var received = new TaskCompletionSource<JsonElement>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        _sideB.RegisterMethod("engine/log", (params_, _) =>
        {
            received.TrySetResult(params_!.Value);
            return ValueTask.FromResult<object?>(null);
        });
        StartLoops();

        await _sideA.NotifyAsync("engine/log", new { level = "info", message = "olá" }, _cts.Token);
        var payload = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("olá", payload.GetProperty("message").GetString());
    }

    [Fact]
    public async Task Closing_transport_rejects_pending_requests()
    {
        _sideB.RegisterMethod("never/answers", async (_, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return null;
        });
        StartLoops();

        var pending = _sideA.RequestAsync("never/answers", null, _cts.Token);
        await Task.Delay(100);
        await _sideB.DisposeAsync();

        await Assert.ThrowsAnyAsync<Exception>(() => pending);
    }
}
