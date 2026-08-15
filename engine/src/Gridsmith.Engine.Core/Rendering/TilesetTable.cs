namespace Gridsmith.Engine.Core.Rendering;

/// <summary>
/// A tabela do atlas no lado da engine — o ESPELHO exato do `TilesetSpec` do
/// middleware (documento v5). A região de um tile é FÓRMULA sobre quatro
/// números, nunca tabela por tile: coluna <c>id % Columns</c>, linha
/// <c>id / Columns</c>, célula de <c>TileSize</c> px. O núcleo puro do editor
/// (`tilesetAtlas.ts`) implementa a MESMA fórmula, e a paridade visual da
/// ADR-022 só pode quebrar se os quatro números divergirem entre os lados.
/// </summary>
public readonly record struct TilesetTable(
    string TilesetId,
    string Image,
    int TileSize,
    int Columns,
    int TileCount)
{
    /// <summary>
    /// Região do tile em pixels da imagem do atlas. <c>false</c> quando o id
    /// está fora de <c>[0, TileCount)</c> — sem arte não é erro: o chamador
    /// desenha o fallback determinístico, igual ao editor.
    /// </summary>
    public bool TryRegion(int tileId, out int x, out int y)
    {
        if (tileId < 0 || tileId >= TileCount)
        {
            x = 0;
            y = 0;
            return false;
        }

        x = tileId % Columns * TileSize;
        y = tileId / Columns * TileSize;
        return true;
    }
}

/// <summary>
/// Registro de tilesets aplicados pela sessão. Fase de carga, não hot loop —
/// dicionário simples; o caminho de desenho só LÊ (TryGet não aloca).
/// </summary>
public sealed class TilesetRegistry
{
    private readonly Dictionary<string, TilesetTable> _tables = new(StringComparer.Ordinal);

    public int Count => _tables.Count;

    /// <summary>Upsert deliberado: reprojeção/reidratação reaplica sem erro.</summary>
    public void Apply(in TilesetTable table) => _tables[table.TilesetId] = table;

    public bool Remove(string tilesetId) => _tables.Remove(tilesetId);

    public bool TryGet(string tilesetId, out TilesetTable table) =>
        _tables.TryGetValue(tilesetId, out table);

    public void Reset() => _tables.Clear();
}
