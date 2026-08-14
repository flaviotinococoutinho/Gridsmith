using System.Numerics;

namespace Gridsmith.Engine.Graphics;

/// <summary>
/// Empacota as matrizes de skinning (<see cref="Matrix3x2"/>) no formato de
/// registradores do vertex shader SkinnedMesh.fx:
///
/// <code>
/// BoneRows[i*2 + 0] = (m11, m12, m21, m22)  — rotação/escala
/// BoneRows[i*2 + 1] = (m31, m32, 0, 0)      — translação
/// </code>
///
/// O destino é pré-alocado pelo chamador (2 × MaxBones) e reutilizado a cada
/// frame — nenhuma alocação no hot loop (Zero-GC).
/// </summary>
public static class BonePacker
{
    public const int RegistersPerBone = 2;

    /// <summary>Registradores necessários para <paramref name="boneCount"/> ossos.</summary>
    public static int RequiredRegisters(int boneCount) => boneCount * RegistersPerBone;

    public static void Pack(ReadOnlySpan<Matrix3x2> skinningMatrices, Span<Vector4> destination)
    {
        if (destination.Length < RequiredRegisters(skinningMatrices.Length))
        {
            throw new ArgumentException(
                $"Destination needs at least {RequiredRegisters(skinningMatrices.Length)} registers " +
                $"for {skinningMatrices.Length} bones (got {destination.Length})");
        }

        for (var i = 0; i < skinningMatrices.Length; i++)
        {
            ref readonly var m = ref skinningMatrices[i];
            destination[i * 2 + 0] = new Vector4(m.M11, m.M12, m.M21, m.M22);
            destination[i * 2 + 1] = new Vector4(m.M31, m.M32, 0f, 0f);
        }
    }

    /// <summary>
    /// Referência da transformação que o shader executa com os registradores
    /// empacotados — usada nos testes para provar que Pack + shader ≡
    /// <see cref="Matrix3x2"/> aplicada diretamente.
    /// </summary>
    public static Vector2 TransformLikeShader(Vector2 position, Vector4 rotationRow, Vector4 translationRow) =>
        new(
            position.X * rotationRow.X + position.Y * rotationRow.Z + translationRow.X,
            position.X * rotationRow.Y + position.Y * rotationRow.W + translationRow.Y);
}
