using System.Collections.Concurrent;
using System.Text.Json;
using Gridsmith.Engine.Ipc.Protocol;

namespace Gridsmith.Engine.Ipc;

/// <summary>Handler de método registrado no peer. Recebe os params crus (ou null).</summary>
public delegate ValueTask<object?> RpcHandler(JsonElement? @params, CancellationToken ct);

/// <summary>
/// Peer JSON-RPC 2.0 full-duplex e simétrico sobre um stream (Named Pipe /
/// Unix Socket / par loopback em testes). Contraparte exata de
/// middleware/src/ipc/JsonRpcPeer.ts: ambos os lados originam requests
/// (correlacionados por id) e notifications (fire-and-forget).
///
/// Este peer vive fora do hot loop do jogo — alocações aqui são aceitáveis;
/// o plano de dados de alta frequência usa shared memory, não JSON.
/// </summary>
public sealed class JsonRpcConnection : IAsyncDisposable
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web);

    private readonly Stream _stream;
    private readonly ConcurrentDictionary<string, RpcHandler> _handlers = new();
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> _pending = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly TimeSpan _requestTimeout;
    private long _nextId;
    private volatile bool _closed;

    public string Label { get; }

    public JsonRpcConnection(Stream stream, string label = "engine", TimeSpan? requestTimeout = null)
    {
        _stream = stream;
        Label = label;
        _requestTimeout = requestTimeout ?? TimeSpan.FromSeconds(10);
    }

    /// <summary>Registra o handler de um método. Registro duplicado é erro de programação.</summary>
    public void RegisterMethod(string method, RpcHandler handler)
    {
        if (!_handlers.TryAdd(method, handler))
        {
            throw new InvalidOperationException($"Handler already registered for method \"{method}\"");
        }
    }

    /// <summary>
    /// Loop de leitura: consome frames até EOF/cancelamento e despacha requests,
    /// notifications e respostas. Deve rodar em uma task dedicada.
    /// </summary>
    public async Task RunAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var frame = await FrameCodec.ReadFrameAsync(_stream, ct).ConfigureAwait(false);
                if (frame is null)
                {
                    break; // EOF limpo
                }

                // Despacho sem await: handlers lentos não bloqueiam o loop de leitura.
                _ = DispatchAsync(frame, ct);
            }
        }
        finally
        {
            Teardown(new IOException($"{Label}: transport closed"));
        }
    }

    /// <summary>Envia um request e aguarda a resposta correlacionada.</summary>
    public async Task<JsonElement> RequestAsync(string method, object? @params, CancellationToken ct)
    {
        if (_closed)
        {
            throw new IOException($"{Label}: connection is closed");
        }

        var id = Interlocked.Increment(ref _nextId);
        var tcs = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;

        try
        {
            await SendAsync(new
            {
                jsonrpc = JsonRpcProtocol.JsonRpcVersion,
                method,
                @params,
                id,
            }, ct).ConfigureAwait(false);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(_requestTimeout);
            await using var registration = timeoutCts.Token.Register(() => tcs.TrySetCanceled(timeoutCts.Token));
            return await tcs.Task.ConfigureAwait(false);
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    /// <summary>Request tipado: desserializa o result para <typeparamref name="T"/>.</summary>
    public async Task<T> RequestAsync<T>(string method, object? @params, CancellationToken ct)
    {
        var result = await RequestAsync(method, @params, ct).ConfigureAwait(false);
        return result.Deserialize<T>(SerializerOptions)
               ?? throw new JsonException($"Response to \"{method}\" deserialized to null");
    }

    /// <summary>Envia uma notification (sem id, sem resposta).</summary>
    public ValueTask NotifyAsync(string method, object? @params, CancellationToken ct)
    {
        if (_closed)
        {
            return ValueTask.CompletedTask;
        }

        return new ValueTask(SendAsync(new
        {
            jsonrpc = JsonRpcProtocol.JsonRpcVersion,
            method,
            @params,
        }, ct));
    }

    private async Task SendAsync(object message, CancellationToken ct)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(message, SerializerOptions);
        await _writeLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await FrameCodec.WriteFrameAsync(_stream, payload, ct).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private async Task DispatchAsync(byte[] frame, CancellationToken ct)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(frame);
        }
        catch (JsonException)
        {
            await SendErrorAsync(null, RpcErrorCode.ParseError, "Parse error", ct).ConfigureAwait(false);
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                await SendErrorAsync(null, RpcErrorCode.InvalidRequest, "Message must be a JSON object", ct)
                    .ConfigureAwait(false);
                return;
            }

            if (root.TryGetProperty("method", out var methodElement))
            {
                await HandleIncomingCallAsync(root, methodElement.GetString() ?? "", ct).ConfigureAwait(false);
            }
            else
            {
                HandleResponse(root);
            }
        }
    }

    private async Task HandleIncomingCallAsync(JsonElement root, string method, CancellationToken ct)
    {
        var hasId = root.TryGetProperty("id", out var idElement);
        long? id = hasId && idElement.ValueKind == JsonValueKind.Number ? idElement.GetInt64() : null;
        JsonElement? @params = root.TryGetProperty("params", out var p) ? p.Clone() : null;

        if (!_handlers.TryGetValue(method, out var handler))
        {
            if (id is not null)
            {
                await SendErrorAsync(id, RpcErrorCode.MethodNotFound, $"Method not found: \"{method}\"", ct)
                    .ConfigureAwait(false);
            }

            return; // notifications desconhecidas são ignoradas por contrato
        }

        try
        {
            var result = await handler(@params, ct).ConfigureAwait(false);
            if (id is not null)
            {
                await SendAsync(new
                {
                    jsonrpc = JsonRpcProtocol.JsonRpcVersion,
                    result = result ?? (object?)null,
                    id,
                }, ct).ConfigureAwait(false);
            }
        }
        catch (JsonRpcException ex) when (id is not null)
        {
            await SendErrorAsync(id, ex.Code, ex.Message, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (id is not null)
        {
            await SendErrorAsync(id, RpcErrorCode.InternalError, ex.Message, ct).ConfigureAwait(false);
        }
        catch
        {
            // exceção em notification: sem canal de resposta, apenas engole
        }
    }

    private void HandleResponse(JsonElement root)
    {
        if (!root.TryGetProperty("id", out var idElement) || idElement.ValueKind != JsonValueKind.Number)
        {
            return; // resposta não correlacionável (ex.: parse error remoto)
        }

        if (!_pending.TryRemove(idElement.GetInt64(), out var tcs))
        {
            return; // resposta tardia de request expirado
        }

        if (root.TryGetProperty("error", out var error))
        {
            var code = error.TryGetProperty("code", out var c) ? c.GetInt32() : RpcErrorCode.InternalError;
            var message = error.TryGetProperty("message", out var m) ? m.GetString() ?? "error" : "error";
            tcs.TrySetException(new JsonRpcException(code, message));
        }
        else if (root.TryGetProperty("result", out var result))
        {
            tcs.TrySetResult(result.Clone());
        }
    }

    private Task SendErrorAsync(long? id, int code, string message, CancellationToken ct) =>
        SendAsync(new
        {
            jsonrpc = JsonRpcProtocol.JsonRpcVersion,
            error = new { code, message },
            id,
        }, ct);

    private void Teardown(Exception reason)
    {
        if (_closed)
        {
            return;
        }

        _closed = true;
        foreach (var (_, tcs) in _pending)
        {
            tcs.TrySetException(reason);
        }

        _pending.Clear();
    }

    public async ValueTask DisposeAsync()
    {
        Teardown(new IOException($"{Label}: disposed"));
        await _stream.DisposeAsync().ConfigureAwait(false);
        _writeLock.Dispose();
    }
}
