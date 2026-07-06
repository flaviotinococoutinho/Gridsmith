using System.Text.Json;
using P7m.Engine.Ipc.Protocol;
using P7m.Engine.Ipc.Transport;

namespace P7m.Engine.Ipc;

/// <summary>Resposta do middleware ao <c>engine/handshake</c>.</summary>
public sealed record HandshakeResult(
    string SessionId,
    string ServerName,
    string ProtocolVersion,
    string[]? AcceptedCapabilities);

/// <summary>Resposta a <c>engine/ping</c> (ambas as direções).</summary>
public sealed record PingResult(string Echo, long? ReceivedAtUnixMs);

/// <summary>
/// Canal de alto nível engine → middleware: conexão, handshake de protocolo
/// e métodos tipados sobre o <see cref="JsonRpcConnection"/> cru.
/// </summary>
public sealed class EngineChannel : IAsyncDisposable
{
    public const string ClientName = "P7m.Engine.Runtime";
    public const string ClientVersion = "0.1.0";

    private readonly JsonRpcConnection _connection;
    private readonly Task _readLoop;
    private readonly CancellationTokenSource _lifetime;

    public HandshakeResult? Session { get; private set; }
    public JsonRpcConnection Connection => _connection;

    private EngineChannel(JsonRpcConnection connection, Task readLoop, CancellationTokenSource lifetime)
    {
        _connection = connection;
        _readLoop = readLoop;
        _lifetime = lifetime;
    }

    /// <summary>
    /// Conecta ao middleware (com retry/backoff) e registra os handlers ANTES
    /// de iniciar o loop de leitura — nenhum request do middleware pode chegar
    /// a um peer sem handlers.
    /// </summary>
    public static async Task<EngineChannel> ConnectAsync(
        string pipeName,
        Action<JsonRpcConnection> registerHandlers,
        CancellationToken ct,
        int maxConnectAttempts = 5)
    {
        var stream = await PipeTransport.ConnectWithRetryAsync(pipeName, maxConnectAttempts, ct)
            .ConfigureAwait(false);
        var connection = new JsonRpcConnection(stream, label: $"engine:{pipeName}");
        registerHandlers(connection);

        var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var readLoop = Task.Run(() => connection.RunAsync(lifetime.Token), CancellationToken.None);
        return new EngineChannel(connection, readLoop, lifetime);
    }

    /// <summary>Executa o handshake e valida a versão MAJOR do protocolo.</summary>
    public async Task<HandshakeResult> HandshakeAsync(string[] capabilities, CancellationToken ct)
    {
        var result = await _connection.RequestAsync<HandshakeResult>("engine/handshake", new
        {
            clientName = ClientName,
            clientVersion = ClientVersion,
            protocolVersion = JsonRpcProtocol.ProtocolVersion,
            capabilities,
        }, ct).ConfigureAwait(false);

        var serverMajor = result.ProtocolVersion.Split('.')[0];
        var localMajor = JsonRpcProtocol.ProtocolVersion.Split('.')[0];
        if (serverMajor != localMajor)
        {
            throw new JsonRpcException(
                RpcErrorCode.ProtocolMismatch,
                $"Protocol major version mismatch: middleware={result.ProtocolVersion}, engine={JsonRpcProtocol.ProtocolVersion}");
        }

        Session = result;
        return result;
    }

    /// <summary>Round-trip de vitalidade engine → middleware.</summary>
    public Task<PingResult> PingAsync(string payload, CancellationToken ct) =>
        _connection.RequestAsync<PingResult>("engine/ping", new
        {
            payload,
            sentAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }, ct);

    /// <summary>Encaminha um log estruturado ao middleware (notification).</summary>
    public ValueTask LogAsync(string level, string message, string? category, CancellationToken ct) =>
        _connection.NotifyAsync("engine/log", new
        {
            level,
            message,
            category,
            unixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        }, ct);

    public async ValueTask DisposeAsync()
    {
        await _lifetime.CancelAsync().ConfigureAwait(false);
        await _connection.DisposeAsync().ConfigureAwait(false);
        try
        {
            await _readLoop.ConfigureAwait(false);
        }
        catch
        {
            // encerramento: falhas do loop de leitura já foram propagadas aos requests pendentes
        }

        _lifetime.Dispose();
    }
}
