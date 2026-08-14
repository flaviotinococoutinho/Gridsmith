using System.Runtime.InteropServices;
using Gridsmith.Engine.Core.SharedMemory;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// Guarda o contrato binário publicado em contracts/shared-memory-layout.md:
/// se a struct mudar, estes testes quebram ANTES do escritor Node.js quebrar
/// em produção.
/// </summary>
public class SkinnedVertex2DTests
{
    [Fact]
    public void Stride_is_36_bytes_as_documented()
    {
        Assert.Equal(36, SkinnedVertex2D.StrideInBytes);
        Assert.Equal(36, Marshal.SizeOf<SkinnedVertex2D>());
    }

    [Theory]
    [InlineData("position", 0, "float2")]
    [InlineData("uv", 8, "float2")]
    [InlineData("boneIndices", 16, "byte4")]
    [InlineData("boneWeights", 20, "float4")]
    public void Layout_description_matches_documented_offsets(string field, int offset, string type)
    {
        var described = SkinnedVertex2D.LayoutDescription().Single(f => f.Name == field);
        Assert.Equal(offset, described.Offset);
        Assert.Equal(type, described.Type);
    }

    [Fact]
    public void Header_layout_matches_documented_offsets()
    {
        Assert.Equal(0, (int)Marshal.OffsetOf<MeshBufferHeader>(nameof(MeshBufferHeader.Magic)));
        Assert.Equal(4, (int)Marshal.OffsetOf<MeshBufferHeader>(nameof(MeshBufferHeader.LayoutVersion)));
        Assert.Equal(8, (int)Marshal.OffsetOf<MeshBufferHeader>(nameof(MeshBufferHeader.VertexCount)));
        Assert.Equal(12, (int)Marshal.OffsetOf<MeshBufferHeader>(nameof(MeshBufferHeader.StrideInBytes)));
        Assert.Equal(16, (int)Marshal.OffsetOf<MeshBufferHeader>(nameof(MeshBufferHeader.Sequence)));
        Assert.Equal(20, (int)Marshal.OffsetOf<MeshBufferHeader>(nameof(MeshBufferHeader.FrameIndex)));
    }

    [Fact]
    public void Bone_indices_pack_and_unpack_roundtrip()
    {
        var packed = SkinnedVertex2D.PackBoneIndices(3, 250, 0, 17);
        var vertex = new SkinnedVertex2D { BoneIndices = packed };
        Assert.Equal(3, vertex.BoneIndex(0));
        Assert.Equal(250, vertex.BoneIndex(1));
        Assert.Equal(0, vertex.BoneIndex(2));
        Assert.Equal(17, vertex.BoneIndex(3));
    }
}
