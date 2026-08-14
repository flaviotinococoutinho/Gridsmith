using Microsoft.Xna.Framework.Graphics;
using Gridsmith.Engine.Core.SharedMemory;

namespace Gridsmith.Engine.Graphics;

/// <summary>
/// Declaração de vértice da GPU para <see cref="SkinnedVertex2D"/>.
///
/// Os offsets vêm do MESMO contrato binário do plano de dados
/// (contracts/shared-memory-layout.md): o buffer compartilhado escrito pelo
/// Node.js sobe para a GPU sem repack — memória mapeada → VertexBuffer,
/// byte a byte. Um teste confere estes offsets contra
/// <see cref="SkinnedVertex2D.LayoutDescription"/>.
/// </summary>
public static class SkinnedVertexDeclaration
{
    public static readonly VertexDeclaration Instance = new(
        SkinnedVertex2D.StrideInBytes,
        new VertexElement(0, VertexElementFormat.Vector2, VertexElementUsage.Position, 0),
        new VertexElement(8, VertexElementFormat.Vector2, VertexElementUsage.TextureCoordinate, 0),
        new VertexElement(16, VertexElementFormat.Byte4, VertexElementUsage.BlendIndices, 0),
        new VertexElement(20, VertexElementFormat.Vector4, VertexElementUsage.BlendWeight, 0));
}
