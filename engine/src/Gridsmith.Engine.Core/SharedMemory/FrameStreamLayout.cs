using System.Buffers.Binary;

namespace Gridsmith.Engine.Core.SharedMemory;

/// <summary>
/// Layout binário do plano de frames (contracts/frame-stream-layout.md) — o
/// preview embutido da ADR-024.
///
/// <para>É o plano de dados no sentido CONTRÁRIO: lá o Node escreve vértices e
/// a engine lê; aqui a engine escreve pixels e o editor lê. O header tem os
/// mesmos 64 bytes e o mesmo seqlock de propósito — um canal novo traria de
/// volta perguntas já respondidas (coerência, snapshot sem lock, nomeação do
/// endpoint) e as responderia de outro jeito.</para>
///
/// <para>Vive em <b>Core</b>, sem MonoGame: o que é publicável é protocolo, e
/// protocolo se testa sem GPU (regras E4/E6). O Host só entrega os pixels.</para>
/// </summary>
public static class FrameStreamLayout
{
    /// <summary>Bytes ASCII <c>GSFB</c> em little-endian.</summary>
    public const uint Magic = 0x42465347;

    public const uint LayoutVersion = 1;

    /// <summary>RGBA8 não pré-multiplicado.</summary>
    public const uint PixelFormatRgba8 = 1;

    public const int HeaderBytes = 64;
    public const int BytesPerPixel = 4;

    // Os offsets do magic e da versão coincidem com os do plano de dados de
    // propósito: quem abrir o arquivo errado descobre pelo PRIMEIRO campo, em
    // vez de interpretar pixels como vértices.
    public const int MagicOffset = 0;
    public const int LayoutVersionOffset = 4;
    public const int WidthOffset = 8;
    public const int HeightOffset = 12;
    public const int SequenceOffset = 16;
    public const int FrameIndexOffset = 20;
    public const int PixelFormatOffset = 24;

    /// <summary>
    /// Bytes de pixel de um frame, ou <c>-1</c> quando as dimensões não são
    /// publicáveis (não positivas, ou grandes a ponto de estourar a conta).
    /// Devolver um número errado aqui seria alocar um arquivo que não cabe o
    /// que o header promete.
    /// </summary>
    public static long PayloadBytes(int width, int height)
    {
        if (width <= 0 || height <= 0)
        {
            return -1;
        }

        return (long)width * height * BytesPerPixel;
    }

    /// <summary>Tamanho total do arquivo, ou <c>-1</c> (mesma regra acima).</summary>
    public static long TotalBytes(int width, int height)
    {
        var payload = PayloadBytes(width, height);
        return payload < 0 ? -1 : HeaderBytes + payload;
    }

    /// <summary>
    /// Campos do header, little-endian. Públicos porque o layout É o contrato:
    /// quem verifica o protocolo precisa ler os mesmos bytes que ele escreve,
    /// sem uma segunda implementação de offsets para divergir da primeira.
    /// </summary>
    public static void WriteUInt32(Span<byte> destination, int offset, uint value) =>
        BinaryPrimitives.WriteUInt32LittleEndian(destination[offset..], value);

    /// <inheritdoc cref="WriteUInt32"/>
    public static uint ReadUInt32(ReadOnlySpan<byte> source, int offset) =>
        BinaryPrimitives.ReadUInt32LittleEndian(source[offset..]);
}
