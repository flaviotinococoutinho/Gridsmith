using Gridsmith.Engine.Ipc;
using Gridsmith.Engine.Ipc.Transport;
using Gridsmith.Engine.Runtime;

// Host do serviço de engine Gridsmith.
//
// Uso:
//   dotnet run -- [--pipe <nome>] [--self-test]
//
// Modo serviço (default): conecta ao middleware, faz handshake e permanece
// atendendo o plano de controle com heartbeat; reconecta com backoff se o
// canal cair. O game loop MonoGame acopla-se aqui na Fase 3.
//
// Modo --self-test: prova de vida da Fase 1 — valida o fluxo JSON-RPC 2.0
// bidirecional contra um middleware em execução e encerra com exit code 0/1.

var pipeName = PipeTransport.DefaultPipeName;
var selfTest = false;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--pipe":
            pipeName = args[++i];
            break;
        case "--self-test":
            selfTest = true;
            break;
        case "--describe-frame":
            // paridade visual (ADR-022): compõe um frame via FrameComposer a
            // partir de um cenário JSON e sai — Core puro, sem GPU, sem pipe
            return FrameDescriber.Run(args[++i]);
        default:
            Console.Error.WriteLine($"[engine] unknown argument: {args[i]}");
            return 2;
    }
}

using var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    shutdown.Cancel();
};

return selfTest
    ? await SelfTest.RunAsync(pipeName, shutdown.Token)
    : await ServiceHost.RunAsync(pipeName, shutdown.Token);

internal static class ServiceHost
{
    public static async Task<int> RunAsync(string pipeName, CancellationToken ct)
    {
        var service = new EngineService();
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await using var channel = await EngineChannel.ConnectAsync(
                    pipeName, service.RegisterHandlers, ct, maxConnectAttempts: 10);
                var session = await channel.HandshakeAsync(
                    ["skeleton", "mesh", "shared-memory"], ct);
                Console.Error.WriteLine(
                    $"[engine] session {session.SessionId} established with {session.ServerName} " +
                    $"(protocol {session.ProtocolVersion})");
                await channel.LogAsync("info", "engine service online", "runtime", ct);

                // Heartbeat de vitalidade até o canal cair ou o serviço encerrar.
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(TimeSpan.FromSeconds(15), ct);
                    await channel.PingAsync("heartbeat", ct);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[engine] channel lost ({ex.Message}); reconnecting");
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), ct);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        Console.Error.WriteLine("[engine] service stopped");
        return 0;
    }
}

internal static class SelfTest
{
    public static async Task<int> RunAsync(string pipeName, CancellationToken outerCt)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(outerCt);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        var ct = timeout.Token;

        try
        {
            var service = new EngineService();

            // O middleware pinga cada sessão nova (middleware → engine);
            // o self-test só passa depois de atender esse request.
            var middlewarePinged = new TaskCompletionSource<string>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            service.PingReceived += payload => middlewarePinged.TrySetResult(payload);

            await using var channel = await EngineChannel.ConnectAsync(
                pipeName, service.RegisterHandlers, ct, maxConnectAttempts: 5);

            Step("connect", $"transport established on \"{pipeName}\"");

            var session = await channel.HandshakeAsync(["skeleton", "mesh", "shared-memory"], ct);
            Assert(session.SessionId.Length > 0, "handshake returned a sessionId");
            Assert(session.ServerName == "gridsmith-middleware", $"server identified as {session.ServerName}");
            Step("handshake", $"session {session.SessionId}, protocol {session.ProtocolVersion}");

            // Direção engine → middleware (request + resposta correlacionada)
            var pong = await channel.PingAsync("marco-polo", ct);
            Assert(pong.Echo == "marco-polo", "engine→middleware ping echoed payload");
            Step("ping →", $"echo \"{pong.Echo}\" received");

            // Direção engine → middleware (notification)
            await channel.LogAsync("info", "self-test notification", "selftest", ct);
            Step("log →", "structured log notification sent");

            // Direção middleware → engine: aguarda o ping de boas-vindas do middleware
            var welcome = await middlewarePinged.Task.WaitAsync(TimeSpan.FromSeconds(10), ct);
            Step("ping ←", $"answered middleware→engine ping request (payload \"{welcome}\")");

            Console.WriteLine("SELF-TEST PASS: bidirectional JSON-RPC 2.0 flow verified");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"SELF-TEST FAIL: {ex.Message}");
            return 1;
        }
    }

    private static void Step(string label, string message) =>
        Console.WriteLine($"  [{label,-10}] {message}");

    private static void Assert(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"assertion failed: {what}");
        }

        Step("assert", what);
    }
}
