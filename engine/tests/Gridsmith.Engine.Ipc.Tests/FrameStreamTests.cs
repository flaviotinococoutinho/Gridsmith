using Gridsmith.Engine.Core.SharedMemory;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// Protocolo do plano de frames (ADR-024). Estes casos são ESPELHADOS no leitor
/// do editor (`frontend/test/frame-stream.test.ts`): o escritor e o leitor
/// vivem em processos e linguagens diferentes, e a única coisa que os mantém
/// falando a mesma língua é os dois lados fixarem os MESMOS números.
/// </summary>
public sealed class FrameStreamTests
{
    private static byte[] Buffer(int width, int height) =>
        new byte[FrameStreamLayout.TotalBytes(width, height)];

    private static byte[] Pixels(int width, int height, byte seed)
    {
        var pixels = new byte[width * height * FrameStreamLayout.BytesPerPixel];
        for (var i = 0; i < pixels.Length; i++)
        {
            pixels[i] = (byte)(seed + i);
        }

        return pixels;
    }

    private static uint Field(byte[] buffer, int offset) => FrameStreamLayout.ReadUInt32(buffer, offset);

    [Fact]
    public void O_frame_publicado_carrega_magic_versao_dimensoes_e_formato()
    {
        var buffer = Buffer(4, 3);
        var writer = new FrameStreamWriter();

        Assert.True(writer.TryPublish(buffer, 4, 3, Pixels(4, 3, 1)));

        Assert.Equal(FrameStreamLayout.Magic, Field(buffer, FrameStreamLayout.MagicOffset));
        Assert.Equal(FrameStreamLayout.LayoutVersion, Field(buffer, FrameStreamLayout.LayoutVersionOffset));
        Assert.Equal(4u, Field(buffer, FrameStreamLayout.WidthOffset));
        Assert.Equal(3u, Field(buffer, FrameStreamLayout.HeightOffset));
        Assert.Equal(FrameStreamLayout.PixelFormatRgba8, Field(buffer, FrameStreamLayout.PixelFormatOffset));
    }

    [Fact]
    public void A_sequencia_termina_PAR_e_anda_de_dois_em_dois()
    {
        // é o contrato do seqlock: par significa "publicado". Um leitor que
        // encontre ímpar sabe que há rajada em andamento e tenta de novo.
        var buffer = Buffer(2, 2);
        var writer = new FrameStreamWriter();

        writer.TryPublish(buffer, 2, 2, Pixels(2, 2, 0));
        var first = Field(buffer, FrameStreamLayout.SequenceOffset);
        writer.TryPublish(buffer, 2, 2, Pixels(2, 2, 9));
        var second = Field(buffer, FrameStreamLayout.SequenceOffset);

        Assert.Equal(0u, first % 2);
        Assert.Equal(0u, second % 2);
        Assert.Equal(first + 2, second);
    }

    [Fact]
    public void O_frameIndex_conta_frames_publicados_e_so_eles()
    {
        var buffer = Buffer(2, 2);
        var writer = new FrameStreamWriter();

        writer.TryPublish(buffer, 2, 2, Pixels(2, 2, 0));
        writer.TryPublish(buffer, 2, 2, Pixels(2, 2, 1));
        // recusado: contagem de pixels não bate com as dimensões
        Assert.False(writer.TryPublish(buffer, 2, 2, new byte[3]));

        Assert.Equal(2u, Field(buffer, FrameStreamLayout.FrameIndexOffset));
        Assert.Equal(2u, writer.FrameIndex);
    }

    [Fact]
    public void Frame_recusado_NAO_toca_no_destino_nem_na_sequencia()
    {
        // recusa tem de ser inerte: mexer na sequência sem publicar deixaria o
        // leitor esperando por um frame que nunca vem
        var buffer = Buffer(2, 2);
        var writer = new FrameStreamWriter();
        writer.TryPublish(buffer, 2, 2, Pixels(2, 2, 7));
        var publicado = (byte[])buffer.Clone();
        var sequencia = writer.Sequence;

        Assert.False(writer.TryPublish(buffer, 0, 2, []));
        Assert.False(writer.TryPublish(buffer, 2, 2, new byte[7]));
        Assert.False(writer.TryPublish(new byte[8], 2, 2, Pixels(2, 2, 7)));

        Assert.Equal(publicado, buffer);
        Assert.Equal(sequencia, writer.Sequence);
    }

    [Fact]
    public void Os_pixels_vao_INTEIROS_logo_depois_do_header()
    {
        var buffer = Buffer(2, 2);
        var pixels = Pixels(2, 2, 100);
        new FrameStreamWriter().TryPublish(buffer, 2, 2, pixels);

        Assert.Equal(pixels, buffer[FrameStreamLayout.HeaderBytes..]);
    }

    [Fact]
    public void Redimensionar_troca_as_dimensoes_e_a_sequencia_CONTINUA()
    {
        // o painel redimensiona; a sequência não pode reiniciar, ou um leitor
        // que guardou a anterior acharia que nada mudou
        var writer = new FrameStreamWriter();
        var pequeno = Buffer(2, 2);
        writer.TryPublish(pequeno, 2, 2, Pixels(2, 2, 0));
        var antes = Field(pequeno, FrameStreamLayout.SequenceOffset);

        var grande = Buffer(4, 4);
        Assert.True(writer.TryPublish(grande, 4, 4, Pixels(4, 4, 0)));

        Assert.Equal(4u, Field(grande, FrameStreamLayout.WidthOffset));
        Assert.Equal(antes + 2, Field(grande, FrameStreamLayout.SequenceOffset));
    }

    [Fact]
    public void Dimensao_impublicavel_e_recusada_pelo_LAYOUT_antes_de_alocar()
    {
        // um arquivo dimensionado por uma conta que estourou prometeria pixels
        // que não cabem nele
        Assert.Equal(-1, FrameStreamLayout.TotalBytes(0, 10));
        Assert.Equal(-1, FrameStreamLayout.TotalBytes(10, -1));
        Assert.Equal(FrameStreamLayout.HeaderBytes + 16, FrameStreamLayout.TotalBytes(2, 2));
    }
}
