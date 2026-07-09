using System.Numerics;
using Microsoft.Xna.Framework.Graphics;
using P7m.Engine.Core.Rigging;
using P7m.Engine.Core.SharedMemory;
using P7m.Engine.Graphics;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

public class LinearBlendSkinningTests
{
    [Fact]
    public void Single_rigid_bone_follows_the_bone_transform()
    {
        var store = new SkeletonStore(1);
        var inverseBind = Matrix3x2.CreateTranslation(-10f, 0f); // osso em bind (10,0)
        var handle = store.Register("rig", [-1], [inverseBind]);
        store.LocalPose(handle)[0] = Matrix3x2.CreateTranslation(15f, 5f);
        store.ComputeWorldPoses(handle);

        var vertex = new SkinnedVertex2D
        {
            Position = new Vector2(12f, 0f), // 2 unidades à frente do osso na bind pose
            BoneIndices = SkinnedVertex2D.PackBoneIndices(0, 0, 0, 0),
            BoneWeights = new Vector4(1f, 0f, 0f, 0f),
        };

        var skinned = LinearBlendSkinning.Skin(vertex, store.SkinningMatrices(handle));
        Assert.Equal(new Vector2(17f, 5f), skinned); // acompanha o osso mantendo o offset
    }

    [Fact]
    public void Blends_two_bones_by_weight()
    {
        var store = new SkeletonStore(1);
        var handle = store.Register("rig", [-1, -1], [Matrix3x2.Identity, Matrix3x2.Identity]);
        var pose = store.LocalPose(handle);
        pose[0] = Matrix3x2.CreateTranslation(0f, 0f);
        pose[1] = Matrix3x2.CreateTranslation(10f, 0f);
        store.ComputeWorldPoses(handle);

        var vertex = new SkinnedVertex2D
        {
            Position = Vector2.Zero,
            BoneIndices = SkinnedVertex2D.PackBoneIndices(0, 1, 0, 0),
            BoneWeights = new Vector4(0.5f, 0.5f, 0f, 0f),
        };

        var skinned = LinearBlendSkinning.Skin(vertex, store.SkinningMatrices(handle));
        Assert.Equal(new Vector2(5f, 0f), skinned); // média ponderada das duas influências
    }

    [Fact]
    public void Zero_weights_degrade_to_rigid_position()
    {
        var matrices = new[] { Matrix3x2.CreateTranslation(99f, 99f) };
        var vertex = new SkinnedVertex2D { Position = new Vector2(3f, 4f), BoneWeights = Vector4.Zero };
        Assert.Equal(new Vector2(3f, 4f), LinearBlendSkinning.Skin(vertex, matrices));
    }

    [Fact]
    public void Skin_is_allocation_free()
    {
        var store = new SkeletonStore(1);
        var handle = store.Register("rig", [-1, 0], [Matrix3x2.Identity, Matrix3x2.Identity]);
        store.ComputeWorldPoses(handle);
        var vertex = new SkinnedVertex2D
        {
            Position = Vector2.One,
            BoneIndices = SkinnedVertex2D.PackBoneIndices(0, 1, 0, 0),
            BoneWeights = new Vector4(0.5f, 0.5f, 0f, 0f),
        };
        LinearBlendSkinning.Skin(vertex, store.SkinningMatrices(handle)); // aquecimento

        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 10_000; i++)
        {
            LinearBlendSkinning.Skin(vertex, store.SkinningMatrices(handle));
        }

        Assert.Equal(0, GC.GetAllocatedBytesForCurrentThread() - before);
    }
}

public class BonePackerTests
{
    [Fact]
    public void Packed_registers_reproduce_matrix_transform_exactly()
    {
        // rotação + escala + translação arbitrárias
        var matrix = Matrix3x2.CreateRotation(0.7f) * Matrix3x2.CreateScale(1.5f) *
                     Matrix3x2.CreateTranslation(12f, -8f);
        Span<Vector4> registers = stackalloc Vector4[2];
        BonePacker.Pack([matrix], registers);

        var point = new Vector2(3f, -4f);
        var viaMatrix = Vector2.Transform(point, matrix);
        var viaShaderPath = BonePacker.TransformLikeShader(point, registers[0], registers[1]);

        Assert.Equal(viaMatrix.X, viaShaderPath.X, 4);
        Assert.Equal(viaMatrix.Y, viaShaderPath.Y, 4);
    }

    [Fact]
    public void Pack_rejects_undersized_destination()
    {
        var matrices = new Matrix3x2[3];
        var registers = new Vector4[5]; // precisa de 6
        Assert.Throws<ArgumentException>(() => BonePacker.Pack(matrices, registers));
    }
}

public class SkinnedVertexDeclarationTests
{
    [Fact]
    public void Gpu_declaration_matches_the_shared_memory_layout()
    {
        var declaration = SkinnedVertexDeclaration.Instance;
        Assert.Equal(SkinnedVertex2D.StrideInBytes, declaration.VertexStride);

        var elements = declaration.GetVertexElements();
        var described = SkinnedVertex2D.LayoutDescription();

        // o buffer escrito pelo Node.js sobe para a GPU sem repack:
        // cada campo do contrato binário casa com um elemento da declaração
        Assert.Equal(described.Length, elements.Length);
        foreach (var field in described)
        {
            var element = Assert.Single(elements, e => e.Offset == field.Offset);
            var expectedFormat = field.Type switch
            {
                "float2" => VertexElementFormat.Vector2,
                "float4" => VertexElementFormat.Vector4,
                "byte4" => VertexElementFormat.Byte4,
                _ => throw new InvalidOperationException($"unexpected type {field.Type}"),
            };
            Assert.Equal(expectedFormat, element.VertexElementFormat);
        }
    }
}
