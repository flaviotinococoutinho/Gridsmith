namespace Gridsmith.Engine.Core.SharedMemory;

/// <summary>
/// Escritor do plano de frames: publica um frame com o protocolo seqlock
/// (contracts/frame-stream-layout.md).
///
/// <para>A sequência fica ÍMPAR durante a rajada e volta a PAR no publish. Um
/// leitor que chegar no meio vê o valor ímpar e tenta de novo; um que copie
/// header e pixels e reencontre outra sequência sabe que o frame rasgou. Perder
/// frame é normal — o plano é sinal contínuo, como a telemetria da ADR-023. O
/// que o protocolo proíbe é compor metade de um frame com metade de outro.</para>
///
/// <para>O destino é um <c>Span</c>: quem o mapeia (arquivo, view do MMF, ou um
/// array de teste) é do chamador. É isso que mantém o protocolo testável sem
/// GPU e sem arquivo — o Host entrega a view, o teste entrega um array, e o
/// código exercitado é o mesmo.</para>
/// </summary>
public sealed class FrameStreamWriter
{
    private uint _sequence;
    private uint _frameIndex;

    /// <summary>Sequência corrente; par significa "nada em rajada".</summary>
    public uint Sequence => _sequence;

    /// <summary>Quantos frames já foram publicados por este escritor.</summary>
    public uint FrameIndex => _frameIndex;

    /// <summary>
    /// Publica um frame. Devolve <c>false</c> — sem tocar no destino — quando o
    /// frame não é publicável: dimensões inválidas, contagem de pixels que não
    /// bate com elas, ou destino menor que o frame descrito.
    ///
    /// <para>Recusar é deliberado: truncar para caber publicaria um header que
    /// promete mais pixels do que existem, e o leitor não teria como saber. A
    /// disciplina é a mesma do resto do repositório — dado inconsistente é
    /// recusa, nunca conserto por adivinhação.</para>
    /// </summary>
    public bool TryPublish(Span<byte> destination, int width, int height, ReadOnlySpan<byte> pixels)
    {
        var total = FrameStreamLayout.TotalBytes(width, height);
        if (total < 0 || destination.Length < total || pixels.Length != total - FrameStreamLayout.HeaderBytes)
        {
            return false;
        }

        // 1. abre a rajada (sequência ímpar) ANTES de qualquer outro campo: se
        //    width/height mudassem primeiro, um leitor entre as duas escritas
        //    leria dimensões novas com pixels velhos.
        //
        //    Somar 1 basta porque a sequência começa PAR e todo publish a
        //    devolve par; uma recusa sai antes de tocá-la, então a invariante
        //    sobrevive a frames rejeitados.
        _sequence += 1;
        FrameStreamLayout.WriteUInt32(destination, FrameStreamLayout.SequenceOffset, _sequence);

        FrameStreamLayout.WriteUInt32(destination, FrameStreamLayout.MagicOffset, FrameStreamLayout.Magic);
        FrameStreamLayout.WriteUInt32(
            destination,
            FrameStreamLayout.LayoutVersionOffset,
            FrameStreamLayout.LayoutVersion);
        FrameStreamLayout.WriteUInt32(destination, FrameStreamLayout.WidthOffset, (uint)width);
        FrameStreamLayout.WriteUInt32(destination, FrameStreamLayout.HeightOffset, (uint)height);
        FrameStreamLayout.WriteUInt32(
            destination,
            FrameStreamLayout.PixelFormatOffset,
            FrameStreamLayout.PixelFormatRgba8);

        pixels.CopyTo(destination[FrameStreamLayout.HeaderBytes..]);

        // 2. fecha a rajada e conta o frame. O frameIndex sobe DEPOIS dos
        //    pixels: é ele que o editor observa para saber se o host ainda
        //    desenha, e adiantá-lo anunciaria um frame que ainda não existe.
        _sequence += 1;
        _frameIndex += 1;
        FrameStreamLayout.WriteUInt32(destination, FrameStreamLayout.SequenceOffset, _sequence);
        FrameStreamLayout.WriteUInt32(destination, FrameStreamLayout.FrameIndexOffset, _frameIndex);
        return true;
    }
}
