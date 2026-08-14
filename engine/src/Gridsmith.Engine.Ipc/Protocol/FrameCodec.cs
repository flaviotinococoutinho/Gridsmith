using System.Buffers.Binary;

namespace Gridsmith.Engine.Ipc.Protocol;

/// <summary>
/// Framing binário-seguro do plano de controle: cada frame é
/// <c>uint32 LE (tamanho do body)</c> + <c>body UTF-8 (JSON-RPC 2.0)</c>.
/// Idêntico ao codec do middleware (middleware/src/protocol/framing.ts).
/// </summary>
public static class FrameCodec
{
    public const int HeaderBytes = 4;

    /// <summary>Frames de controle acima disso indicam uso indevido do canal
    /// (dados em massa pertencem ao plano de shared memory).</summary>
    public const int MaxFrameBytes = 16 * 1024 * 1024;

    public static async ValueTask WriteFrameAsync(
        Stream stream, ReadOnlyMemory<byte> payload, CancellationToken ct)
    {
        if (payload.Length > MaxFrameBytes)
        {
            throw new FrameProtocolException(
                $"Frame of {payload.Length} bytes exceeds MaxFrameBytes ({MaxFrameBytes})");
        }

        var header = new byte[HeaderBytes];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)payload.Length);
        await stream.WriteAsync(header, ct).ConfigureAwait(false);
        await stream.WriteAsync(payload, ct).ConfigureAwait(false);
        await stream.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Lê exatamente um frame. Retorna <c>null</c> em EOF limpo (conexão encerrada
    /// entre frames); lança <see cref="EndOfStreamException"/> para EOF no meio de
    /// um frame e <see cref="FrameProtocolException"/> para frames acima do limite.
    /// </summary>
    public static async ValueTask<byte[]?> ReadFrameAsync(Stream stream, CancellationToken ct)
    {
        var header = new byte[HeaderBytes];
        var read = await ReadAtLeastAsync(stream, header, allowEof: true, ct).ConfigureAwait(false);
        if (read == 0)
        {
            return null;
        }

        var bodyLength = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (bodyLength > MaxFrameBytes)
        {
            throw new FrameProtocolException(
                $"Incoming frame declares {bodyLength} bytes, above MaxFrameBytes ({MaxFrameBytes})");
        }

        var body = new byte[bodyLength];
        if (bodyLength > 0)
        {
            await ReadAtLeastAsync(stream, body, allowEof: false, ct).ConfigureAwait(false);
        }

        return body;
    }

    private static async ValueTask<int> ReadAtLeastAsync(
        Stream stream, Memory<byte> buffer, bool allowEof, CancellationToken ct)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var n = await stream.ReadAsync(buffer[total..], ct).ConfigureAwait(false);
            if (n == 0)
            {
                if (allowEof && total == 0)
                {
                    return 0;
                }

                throw new EndOfStreamException("Transport closed in the middle of a frame");
            }

            total += n;
        }

        return total;
    }
}

public sealed class FrameProtocolException(string message) : IOException(message);
