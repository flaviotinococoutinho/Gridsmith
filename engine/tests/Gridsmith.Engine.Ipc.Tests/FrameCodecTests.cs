using System.Text;
using Gridsmith.Engine.Ipc.Protocol;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

public class FrameCodecTests
{
    [Fact]
    public async Task Roundtrip_preserves_utf8_payload()
    {
        using var stream = new MemoryStream();
        var body = Encoding.UTF8.GetBytes("{\"message\":\"animação esquelética ❤️\"}");

        await FrameCodec.WriteFrameAsync(stream, body, CancellationToken.None);
        stream.Position = 0;

        var read = await FrameCodec.ReadFrameAsync(stream, CancellationToken.None);
        Assert.NotNull(read);
        Assert.Equal(body, read);
    }

    [Fact]
    public async Task Multiple_frames_are_read_in_order()
    {
        using var stream = new MemoryStream();
        foreach (var text in new[] { "um", "dois", "três" })
        {
            await FrameCodec.WriteFrameAsync(stream, Encoding.UTF8.GetBytes(text), CancellationToken.None);
        }

        stream.Position = 0;
        foreach (var expected in new[] { "um", "dois", "três" })
        {
            var frame = await FrameCodec.ReadFrameAsync(stream, CancellationToken.None);
            Assert.Equal(expected, Encoding.UTF8.GetString(frame!));
        }
    }

    [Fact]
    public async Task Clean_eof_between_frames_returns_null()
    {
        using var stream = new MemoryStream();
        var frame = await FrameCodec.ReadFrameAsync(stream, CancellationToken.None);
        Assert.Null(frame);
    }

    [Fact]
    public async Task Eof_in_the_middle_of_a_frame_throws()
    {
        using var stream = new MemoryStream();
        await FrameCodec.WriteFrameAsync(stream, Encoding.UTF8.GetBytes("payload"), CancellationToken.None);
        // Trunca o último byte do body
        stream.SetLength(stream.Length - 1);
        stream.Position = 0;

        await Assert.ThrowsAsync<EndOfStreamException>(
            async () => await FrameCodec.ReadFrameAsync(stream, CancellationToken.None));
    }

    [Fact]
    public async Task Oversized_incoming_frame_throws_protocol_exception()
    {
        using var stream = new MemoryStream();
        var header = new byte[FrameCodec.HeaderBytes];
        BitConverter.TryWriteBytes(header, (uint)(FrameCodec.MaxFrameBytes + 1));
        stream.Write(header);
        stream.Position = 0;

        await Assert.ThrowsAsync<FrameProtocolException>(
            async () => await FrameCodec.ReadFrameAsync(stream, CancellationToken.None));
    }
}
