using System.Numerics;
using System.Runtime.InteropServices;

namespace Gridsmith.Engine.Core.SharedMemory;

/// <summary>
/// Vértice esqueletizado 2D do plano de dados — layout binário compartilhado
/// com o escritor Node.js/Electron via memory-mapped file
/// (ver contracts/shared-memory-layout.md, layoutVersion 1).
///
/// <see cref="LayoutKind.Sequential"/> com Pack=4: os offsets reais são
/// publicados no manifesto de capacidades via <see cref="LayoutDescription"/>,
/// que os deriva por reflexão (<see cref="Marshal.OffsetOf{T}"/>) — o contrato
/// nunca diverge da struct.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct SkinnedVertex2D
{
    /// <summary>Posição no espaço do modelo.</summary>
    public Vector2 Position;

    /// <summary>Coordenada de textura.</summary>
    public Vector2 Uv;

    /// <summary>Índices dos 4 ossos de influência, empacotados em um uint (byte4).</summary>
    public uint BoneIndices;

    /// <summary>Pesos de influência dos 4 ossos (soma ≈ 1.0).</summary>
    public Vector4 BoneWeights;

    public const int LayoutVersion = 1;

    public static unsafe int StrideInBytes => sizeof(SkinnedVertex2D);

    public readonly byte BoneIndex(int slot) => (byte)(BoneIndices >> (slot * 8));

    public static uint PackBoneIndices(byte b0, byte b1, byte b2, byte b3) =>
        b0 | ((uint)b1 << 8) | ((uint)b2 << 16) | ((uint)b3 << 24);

    /// <summary>Campo do layout como publicado no manifesto de capacidades.</summary>
    public readonly record struct FieldDescription(string Name, int Offset, string Type, string Semantic);

    /// <summary>
    /// Descrição do layout derivada da própria struct. É esta estrutura que o
    /// <c>engine/describe</c> serializa para o middleware/editor.
    /// </summary>
    public static FieldDescription[] LayoutDescription() =>
    [
        new("position", (int)Marshal.OffsetOf<SkinnedVertex2D>(nameof(Position)), "float2", "Posição no espaço do modelo"),
        new("uv", (int)Marshal.OffsetOf<SkinnedVertex2D>(nameof(Uv)), "float2", "Coordenada de textura"),
        new("boneIndices", (int)Marshal.OffsetOf<SkinnedVertex2D>(nameof(BoneIndices)), "byte4", "Índices dos 4 ossos de influência"),
        new("boneWeights", (int)Marshal.OffsetOf<SkinnedVertex2D>(nameof(BoneWeights)), "float4", "Pesos de influência (soma ≈ 1.0)"),
    ];
}
