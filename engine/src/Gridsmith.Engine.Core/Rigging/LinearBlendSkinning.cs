using System.Numerics;
using Gridsmith.Engine.Core.SharedMemory;

namespace Gridsmith.Engine.Core.Rigging;

/// <summary>
/// Referência de CPU do Linear Blend Skinning 2D.
///
/// ESTE ARQUIVO É O CONTRATO DO SHADER: a mesma combinação ponderada está no
/// vertex shader engine/src/Gridsmith.Engine.Graphics/Shaders/SkinnedMesh.fx, que
/// recebe as matrizes de <see cref="SkeletonStore.SkinningMatrices"/> como
/// uniform array. Os testes cobrem esta implementação; o harness headless
/// (Fase 5) usa-a para validar deformações sem GPU.
/// </summary>
public static class LinearBlendSkinning
{
    /// <summary>
    /// Deforma a posição de um vértice: soma ponderada das matrizes de
    /// skinning (worldPose × inverseBind) dos até 4 ossos de influência.
    /// Sem alocações — hot loop safe (Zero-GC).
    /// </summary>
    public static Vector2 Skin(in SkinnedVertex2D vertex, ReadOnlySpan<Matrix3x2> skinningMatrices)
    {
        var result = Vector2.Zero;
        var totalWeight = 0f;

        for (var slot = 0; slot < 4; slot++)
        {
            var weight = slot switch
            {
                0 => vertex.BoneWeights.X,
                1 => vertex.BoneWeights.Y,
                2 => vertex.BoneWeights.Z,
                _ => vertex.BoneWeights.W,
            };
            if (weight <= 0f)
            {
                continue;
            }

            var boneIndex = vertex.BoneIndex(slot);
            result += Vector2.Transform(vertex.Position, skinningMatrices[boneIndex]) * weight;
            totalWeight += weight;
        }

        // Pesos não normalizados (autoria em progresso) degradam com robustez.
        return totalWeight > 1e-6f ? result / totalWeight : vertex.Position;
    }
}
