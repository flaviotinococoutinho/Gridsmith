using P7m.Engine.Core.Lighting;
using P7m.Engine.Ipc.Protocol;
using P7m.Engine.Runtime;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

/// <summary>Handlers de câmera e iluminação exercitados pelo canal JSON-RPC real.</summary>
public class EngineServiceCameraLightingTests : IAsyncLifetime
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
        _service = new EngineService(maxSkeletons: 2, maxLights: 8);
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
    public async Task Camera_configure_merges_partial_params()
    {
        var result = await _middleware.RequestAsync("camera/configure", new
        {
            frequency = 3.5f,
            damping = 0.8f,
        }, _cts.Token);

        Assert.Equal(3.5f, result.GetProperty("frequency").GetSingle());
        Assert.Equal(0.8f, result.GetProperty("damping").GetSingle());
        // campos não enviados preservam o default
        Assert.Equal(0.25f, result.GetProperty("anticipationSeconds").GetSingle());
        Assert.Equal(3.5f, _service.Camera.Config.Frequency);
    }

    [Fact]
    public async Task Camera_configure_rejects_invalid_frequency()
    {
        var ex = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("camera/configure", new { frequency = -1f }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, ex.Code);
    }

    [Fact]
    public async Task Camera_simulate_converges_and_is_deterministic()
    {
        await _middleware.RequestAsync("camera/configure", new { frequency = 2f, damping = 1f }, _cts.Token);

        object SimParams() => new
        {
            steps = 720,
            deltaSeconds = 1f / 120f,
            target = new[] { 100f, 40f },
            initial = new[] { 0f, 0f },
        };

        var first = await _middleware.RequestAsync("camera/simulate", SimParams(), _cts.Token);
        var second = await _middleware.RequestAsync("camera/simulate", SimParams(), _cts.Token);

        var final = first.GetProperty("final");
        Assert.Equal(100f, final[0].GetSingle(), 0.5f);
        Assert.Equal(40f, final[1].GetSingle(), 0.5f);
        Assert.True(first.GetProperty("samples").GetArrayLength() > 10);

        // determinismo: mesma config e entradas → trajetória idêntica
        Assert.Equal(first.GetProperty("final")[0].GetSingle(), second.GetProperty("final")[0].GetSingle());
        Assert.Equal(0f, first.GetProperty("maxShakeMagnitude").GetSingle()); // sem trauma
    }

    [Fact]
    public async Task Camera_simulate_with_trauma_reports_shake_and_decay()
    {
        var result = await _middleware.RequestAsync("camera/simulate", new
        {
            steps = 600,
            deltaSeconds = 1f / 60f,
            target = new[] { 0f, 0f },
            trauma = 1f,
        }, _cts.Token);

        Assert.True(result.GetProperty("maxShakeMagnitude").GetSingle() > 1f,
            "full trauma must produce visible shake");
        Assert.Equal(0f, result.GetProperty("finalTrauma").GetSingle()); // 10 s >> decaimento
    }

    [Fact]
    public async Task Camera_shake_requires_valid_trauma()
    {
        var ex = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("camera/shake", new { trauma = 2f }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, ex.Code);

        var ok = await _middleware.RequestAsync("camera/shake", new { trauma = 0.5f }, _cts.Token);
        Assert.Equal(0.5f, ok.GetProperty("trauma").GetSingle());
    }

    [Fact]
    public async Task Lighting_add_inspect_evaluate_remove_roundtrip()
    {
        var added = await _middleware.RequestAsync("lighting/add", new
        {
            type = "point",
            position = new[] { 0f, 0f },
            height = 50f,
            color = new[] { 1f, 0.5f, 0.25f },
            intensity = 2f,
            radius = 100f,
        }, _cts.Token);
        var lightId = added.GetProperty("lightId").GetInt32();

        var inspected = await _middleware.RequestAsync("lighting/inspect", null, _cts.Token);
        Assert.Equal(1, inspected.GetProperty("count").GetInt32());
        Assert.Equal("point", inspected.GetProperty("lights")[0].GetProperty("type").GetString());

        // avaliação bate com a referência de CPU (mesma equação do shader)
        var evaluated = await _middleware.RequestAsync("lighting/evaluate", new
        {
            surface = new[] { 0f, 0f },
            normal = new[] { 0f, 0f, 1f },
        }, _cts.Token);
        var expected = Lighting2D.EvaluatePoint(
            System.Numerics.Vector2.Zero, 50f, 100f,
            new System.Numerics.Vector3(1f, 0.5f, 0.25f), 2f,
            System.Numerics.Vector2.Zero, new System.Numerics.Vector3(0f, 0f, 1f));
        Assert.Equal(expected.X, evaluated.GetProperty("rgb")[0].GetSingle(), 4);
        Assert.Equal(expected.Y, evaluated.GetProperty("rgb")[1].GetSingle(), 4);

        await _middleware.RequestAsync("lighting/remove", new { lightId }, _cts.Token);
        var after = await _middleware.RequestAsync("lighting/inspect", null, _cts.Token);
        Assert.Equal(0, after.GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task Lighting_add_validates_spot_cone_and_type()
    {
        var badType = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("lighting/add", new
            {
                type = "laser",
                color = new[] { 1f, 1f, 1f },
                intensity = 1f,
            }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, badType.Code);

        var badCone = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("lighting/add", new
            {
                type = "spot",
                position = new[] { 0f, 0f },
                direction = new[] { 1f, 0f },
                color = new[] { 1f, 1f, 1f },
                intensity = 1f,
                radius = 100f,
                innerConeDegrees = 90f,
                outerConeDegrees = 30f, // externo menor que interno
            }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, badCone.Code);
    }

    [Fact]
    public async Task Lighting_remove_unknown_id_is_rejected()
    {
        var ex = await Assert.ThrowsAsync<JsonRpcException>(() =>
            _middleware.RequestAsync("lighting/remove", new { lightId = 5 }, _cts.Token));
        Assert.Equal(RpcErrorCode.InvalidParams, ex.Code);
    }
}
