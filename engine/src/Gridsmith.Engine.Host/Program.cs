using Gridsmith.Engine.Host;
using Gridsmith.Engine.Ipc;
using Gridsmith.Engine.Ipc.Transport;
using Gridsmith.Engine.Runtime;

// Host GRÁFICO do Gridsmith: a janela que desenha o jogo.
//
// Uso:
//   dotnet run --project engine/src/Gridsmith.Engine.Host -- [--pipe <nome>]
//
// Diferença para o Gridsmith.Engine.Runtime: os dois atendem o MESMO plano de
// controle JSON-RPC sobre os mesmos stores DOD; este abre janela e desenha.
// Quem quer só o plano de controle sobe o Runtime e continua sem SDL, sem
// OpenGL e sem GPU — é a regra E4, e é o que mantém as fases 1–4 no CI.
//
// A conexão com o middleware roda em segundo plano: o loop de janela do
// MonoGame precisa da thread principal, e bloqueá-la esperando o pipe deixaria
// a janela sem responder até o middleware subir.

var pipeName = PipeTransport.DefaultPipeName;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--pipe":
            pipeName = args[++i];
            break;
        default:
            Console.Error.WriteLine($"[host] unknown argument: {args[i]}");
            return 2;
    }
}

using var shutdown = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    shutdown.Cancel();
};

var service = new EngineService();
var control = ControlPlane.RunAsync(service, pipeName, shutdown.Token);

try
{
    using var game = new GridsmithGame(service);
    game.Run();
}
finally
{
    // fechar a janela encerra o processo: o plano de controle não sobrevive à
    // janela, senão ficaria um servidor fantasma segurando o pipe
    shutdown.Cancel();
    try
    {
        await control;
    }
    catch (OperationCanceledException)
    {
        // encerramento normal
    }
}

return 0;

internal static class ControlPlane
{
    /// <summary>
    /// Mesmo laço de serviço do Runtime: conecta, faz handshake e mantém
    /// heartbeat, reconectando com backoff. Uma queda do middleware não fecha
    /// a janela — o usuário continua vendo o último estado desenhado.
    /// </summary>
    public static async Task RunAsync(EngineService service, string pipeName, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await using var channel = await EngineChannel.ConnectAsync(
                    pipeName, service.RegisterHandlers, ct, maxConnectAttempts: 10);
                var session = await channel.HandshakeAsync(
                    ["skeleton", "mesh", "shared-memory"], ct);
                Console.Error.WriteLine(
                    $"[host] session {session.SessionId} established with {session.ServerName} " +
                    $"(protocol {session.ProtocolVersion})");
                await channel.LogAsync("info", "graphics host online", "host", ct);

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
                Console.Error.WriteLine($"[host] channel lost ({ex.Message}); reconnecting");
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
    }
}
