using System.IO.Pipes;
using System.Net.Sockets;

namespace Gridsmith.Engine.Ipc.Transport;

/// <summary>
/// Resolve o nome lógico do canal para o endpoint físico da plataforma e
/// conecta ao middleware. Espelha middleware/src/ipc/PipeEndpoint.ts:
/// <list type="bullet">
///   <item>Windows: Named Pipe <c>\\.\pipe\&lt;nome&gt;</c></item>
///   <item>Linux/macOS: Unix Domain Socket em <c>$XDG_RUNTIME_DIR</c> (ou tmp)</item>
/// </list>
/// </summary>
public static class PipeTransport
{
    public const string DefaultPipeName = "gridsmith-engine";

    public static string ResolvePipePath(string pipeName = DefaultPipeName)
    {
        if (OperatingSystem.IsWindows())
        {
            return $@"\\.\pipe\{pipeName}";
        }

        var runtimeDir = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR") ?? Path.GetTempPath();
        return Path.Combine(runtimeDir, $"{pipeName}.sock");
    }

    /// <summary>Conecta ao endpoint do middleware e retorna o stream full-duplex.</summary>
    public static async Task<Stream> ConnectAsync(string pipeName, CancellationToken ct)
    {
        if (OperatingSystem.IsWindows())
        {
            var pipe = new NamedPipeClientStream(
                ".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                await pipe.ConnectAsync(ct).ConfigureAwait(false);
                return pipe;
            }
            catch
            {
                await pipe.DisposeAsync().ConfigureAwait(false);
                throw;
            }
        }

        var socketPath = ResolvePipePath(pipeName);
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), ct).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Conecta com backoff exponencial (2s, 4s, 8s, ... até <paramref name="maxAttempts"/>),
    /// para tolerar o middleware subindo depois da engine.
    /// </summary>
    public static async Task<Stream> ConnectWithRetryAsync(
        string pipeName, int maxAttempts, CancellationToken ct)
    {
        var delay = TimeSpan.FromSeconds(2);
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await ConnectAsync(pipeName, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or SocketException or TimeoutException
                                       && attempt < maxAttempts)
            {
                await Task.Delay(delay, ct).ConfigureAwait(false);
                delay *= 2;
            }
        }
    }
}
