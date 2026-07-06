using P7m.Engine.Core.SharedMemory;

namespace P7m.Engine.Ipc.Tests;

/// <summary>
/// Grava um memory-mapped file no formato exato do escritor Node.js
/// (contracts/shared-memory-layout.md) para exercitar o leitor da engine.
/// </summary>
internal sealed class MeshFileBuilder : IDisposable
{
    public string MapName { get; }
    public string Path { get; }

    private uint _sequence;
    private uint _frameIndex;

    public MeshFileBuilder(string mapName)
    {
        MapName = mapName;
        Path = SharedMemoryPath.Resolve(mapName);
    }

    public MeshFileBuilder Create(int vertexCount, int strideInBytes = 36, uint layoutVersion = 1)
    {
        var total = MeshBufferHeader.HeaderBytes + vertexCount * strideInBytes;
        using var stream = new FileStream(Path, FileMode.Create, FileAccess.Write);
        using var writer = new BinaryWriter(stream);
        writer.Write(MeshBufferHeader.ExpectedMagic);
        writer.Write(layoutVersion);
        writer.Write((uint)vertexCount);
        writer.Write((uint)strideInBytes);
        writer.Write(_sequence);
        writer.Write(_frameIndex);
        writer.Write(new byte[MeshBufferHeader.HeaderBytes - 24]); // reservado
        writer.Write(new byte[vertexCount * strideInBytes]);
        return this;
    }

    /// <summary>Grava vértices seguindo o protocolo seqlock (ímpar → dados → par).</summary>
    public MeshFileBuilder Publish(params SkinnedVertex2D[] vertices)
    {
        using var stream = new FileStream(Path, FileMode.Open, FileAccess.Write);
        using var writer = new BinaryWriter(stream);

        WriteSequence(writer, ++_sequence); // ímpar: escrita em progresso
        stream.Position = MeshBufferHeader.HeaderBytes;
        foreach (var v in vertices)
        {
            writer.Write(v.Position.X);
            writer.Write(v.Position.Y);
            writer.Write(v.Uv.X);
            writer.Write(v.Uv.Y);
            writer.Write(v.BoneIndices);
            writer.Write(v.BoneWeights.X);
            writer.Write(v.BoneWeights.Y);
            writer.Write(v.BoneWeights.Z);
            writer.Write(v.BoneWeights.W);
        }

        stream.Position = 20;
        writer.Write(++_frameIndex);
        WriteSequence(writer, ++_sequence); // par: publish concluído
        return this;
    }

    /// <summary>Deixa o header com sequence ímpar — simula escritor no meio de uma rajada.</summary>
    public MeshFileBuilder MarkWriteInProgress()
    {
        using var stream = new FileStream(Path, FileMode.Open, FileAccess.Write);
        using var writer = new BinaryWriter(stream);
        WriteSequence(writer, ++_sequence);
        return this;
    }

    private static void WriteSequence(BinaryWriter writer, uint value)
    {
        writer.BaseStream.Position = 16;
        writer.Write(value);
        writer.BaseStream.Flush();
    }

    public void Dispose()
    {
        try
        {
            File.Delete(Path);
        }
        catch
        {
            // cleanup best-effort
        }
    }
}
