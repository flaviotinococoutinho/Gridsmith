using System.Numerics;
using Gridsmith.Engine.Core.SharedMemory;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

public class MeshSharedMemoryReaderTests
{
    private static string UniqueName() => $"gridsmith-test-mesh-{Guid.NewGuid():N}";

    private static SkinnedVertex2D MakeVertex(float px, float py) => new()
    {
        Position = new Vector2(px, py),
        Uv = new Vector2(px / 100f, py / 100f),
        BoneIndices = SkinnedVertex2D.PackBoneIndices(0, 1, 0, 0),
        BoneWeights = new Vector4(0.75f, 0.25f, 0, 0),
    };

    [Fact]
    public void Open_validates_and_reads_published_vertices()
    {
        using var builder = new MeshFileBuilder(UniqueName());
        builder.Create(2).Publish(MakeVertex(10, 20), MakeVertex(-3, 7.5f));

        using var reader = MeshSharedMemoryReader.Open(builder.MapName, 2, 36);
        Assert.True(reader.TryReadStable(out var snapshot));
        Assert.Equal(1u, snapshot.FrameIndex);

        var vertices = reader.Vertices;
        Assert.Equal(new Vector2(10, 20), vertices[0].Position);
        Assert.Equal(new Vector2(0.1f, 0.2f), vertices[0].Uv);
        Assert.Equal(1, vertices[0].BoneIndex(1));
        Assert.Equal(0.75f, vertices[0].BoneWeights.X);
        Assert.Equal(new Vector2(-3, 7.5f), vertices[1].Position);
    }

    [Fact]
    public void Open_rejects_missing_file_with_file_not_found()
    {
        Assert.Throws<FileNotFoundException>(() =>
            MeshSharedMemoryReader.Open(UniqueName(), 1, 36));
    }

    [Fact]
    public void Open_rejects_bad_magic()
    {
        using var builder = new MeshFileBuilder(UniqueName());
        builder.Create(1);
        // corrompe o magic
        using (var stream = new FileStream(builder.Path, FileMode.Open, FileAccess.Write))
        {
            stream.WriteByte(0xFF);
        }

        var ex = Assert.Throws<SharedMemoryLayoutException>(() =>
            MeshSharedMemoryReader.Open(builder.MapName, 1, 36));
        Assert.Contains("magic", ex.Message);
    }

    [Fact]
    public void Open_rejects_layout_version_mismatch()
    {
        using var builder = new MeshFileBuilder(UniqueName());
        builder.Create(1, layoutVersion: 99);
        var ex = Assert.Throws<SharedMemoryLayoutException>(() =>
            MeshSharedMemoryReader.Open(builder.MapName, 1, 36));
        Assert.Contains("layoutVersion", ex.Message);
    }

    [Fact]
    public void Open_rejects_header_vs_bind_disagreement()
    {
        using var builder = new MeshFileBuilder(UniqueName());
        builder.Create(4);
        var ex = Assert.Throws<SharedMemoryLayoutException>(() =>
            MeshSharedMemoryReader.Open(builder.MapName, 8, 36)); // bind declara 8, header tem 4
        Assert.Contains("bind declared", ex.Message);
    }

    [Fact]
    public void TryReadStable_refuses_snapshot_while_write_in_progress()
    {
        using var builder = new MeshFileBuilder(UniqueName());
        builder.Create(1).Publish(MakeVertex(1, 1)).MarkWriteInProgress();

        using var reader = MeshSharedMemoryReader.Open(builder.MapName, 1, 36);
        Assert.False(reader.TryReadStable(out _, maxAttempts: 4));
    }

    [Fact]
    public void Republish_is_visible_through_the_live_mapping()
    {
        using var builder = new MeshFileBuilder(UniqueName());
        builder.Create(1).Publish(MakeVertex(1, 1));

        using var reader = MeshSharedMemoryReader.Open(builder.MapName, 1, 36);
        Assert.True(reader.TryReadStable(out var first));
        var checksumBefore = reader.ComputeChecksum();

        // O escritor publica de novo SEM a engine remapear nada:
        // a visibilidade tem que vir do mapeamento compartilhado vivo.
        builder.Publish(MakeVertex(42, -8));

        Assert.True(reader.TryReadStable(out var second));
        Assert.Equal(first.FrameIndex + 1, second.FrameIndex);
        Assert.Equal(new Vector2(42, -8), reader.Vertices[0].Position);
        Assert.NotEqual(checksumBefore, reader.ComputeChecksum());
    }

    [Fact]
    public void Checksum_matches_fnv1a_reference_implementation()
    {
        using var builder = new MeshFileBuilder(UniqueName());
        var vertex = MakeVertex(10, 20);
        builder.Create(1).Publish(vertex);

        using var reader = MeshSharedMemoryReader.Open(builder.MapName, 1, 36);
        Assert.True(reader.TryReadStable(out _));

        // referência independente: FNV-1a sobre os bytes do arquivo
        var fileBytes = File.ReadAllBytes(builder.Path)[MeshBufferHeader.HeaderBytes..];
        var expected = 2166136261u;
        foreach (var b in fileBytes)
        {
            expected = (expected ^ b) * 16777619u;
        }

        Assert.Equal(expected, reader.ComputeChecksum());
    }

    [Fact]
    public void Stable_read_and_checksum_are_allocation_free()
    {
        using var builder = new MeshFileBuilder(UniqueName());
        builder.Create(64).Publish(Enumerable.Range(0, 64).Select(i => MakeVertex(i, i)).ToArray());

        using var reader = MeshSharedMemoryReader.Open(builder.MapName, 64, 36);
        for (var w = 0; w < 200; w++) // aquecimento além do tiered JIT
        {
            Assert.True(reader.TryReadStable(out _));
            reader.ComputeChecksum();
        }

        var allocated = AllocationProbe.MinimumAllocatedBytes(() =>
        {
            for (var frame = 0; frame < 1000; frame++)
            {
                reader.TryReadStable(out _);
                reader.ComputeChecksum();
            }
        });

        Assert.Equal(0, allocated);
    }
}
