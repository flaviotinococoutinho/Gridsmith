namespace P7m.Engine.Core.Level;

/// <summary>Handle opaco para um tilemap residente no store.</summary>
public readonly record struct TilemapHandle(int Slot)
{
    public static readonly TilemapHandle Invalid = new(-1);
    public bool IsValid => Slot >= 0;
}

/// <summary>
/// Armazenamento Data-Oriented de tilemaps (Fase 3.5 — subsistema de níveis
/// inspirado em LDtk/Tiled; ver docs/RESEARCH-EDITOR-LANDSCAPE.md).
///
/// O middleware resolve o auto-tiling (IntGrid + regras → tiles) e a engine
/// recebe o resultado PRONTO: aqui os tiles viram dados contíguos
/// pré-alocados, prontos para consolidação em um único buffer de vértices
/// estático (a diretriz "entidades stateless em um único buffer, minimizando
/// draw calls" do escopo original — a malha estática em si materializa na
/// camada Graphics).
///
/// Toda a memória é alocada no construtor: cada slot comporta até
/// <see cref="MaxCells"/> células (grid de significado + tile resolvido).
/// Nenhuma alocação após a construção (política Zero-GC).
/// </summary>
public sealed class TilemapStore
{
    /// <summary>Limite por tilemap (256×256). Mapas maiores entram por chunks na Fase 5.</summary>
    public const int MaxCells = 256 * 256;

    private readonly int _maxTilemaps;

    // ---- SoA: fatias fixas de MaxCells por slot ----
    private readonly short[] _intGrid;   // significado pintado pelo designer (0 = vazio)
    private readonly int[] _tiles;       // tileId resolvido (-1 = sem tile)

    private readonly string?[] _ids;
    private readonly int[] _widths;
    private readonly int[] _heights;
    private readonly int[] _tileSizes;
    private readonly int[] _nonEmptyCounts;
    private int _liveCount;

    public TilemapStore(int maxTilemaps = 8)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maxTilemaps, 1);
        _maxTilemaps = maxTilemaps;
        _intGrid = new short[maxTilemaps * MaxCells];
        _tiles = new int[maxTilemaps * MaxCells];
        _ids = new string?[maxTilemaps];
        _widths = new int[maxTilemaps];
        _heights = new int[maxTilemaps];
        _tileSizes = new int[maxTilemaps];
        _nonEmptyCounts = new int[maxTilemaps];
    }

    public int Capacity => _maxTilemaps;
    public int LiveCount => _liveCount;

    /// <summary>
    /// Define um tilemap em um slot livre (fase de carga). <paramref name="intGrid"/>
    /// e <paramref name="tiles"/> são linha-maior com width×height células.
    /// </summary>
    public TilemapHandle Define(
        string tilemapId, int width, int height, int tileSize,
        ReadOnlySpan<short> intGrid, ReadOnlySpan<int> tiles)
    {
        if (width < 1 || height < 1 || (long)width * height > MaxCells)
        {
            throw new ArgumentException($"Tilemap must have between 1 and {MaxCells} cells");
        }

        ArgumentOutOfRangeException.ThrowIfLessThan(tileSize, 1);
        var cellCount = width * height;
        if (intGrid.Length != cellCount || tiles.Length != cellCount)
        {
            throw new ArgumentException(
                $"intGrid and tiles must have exactly {cellCount} cells " +
                $"(got {intGrid.Length} and {tiles.Length})");
        }

        var slot = FindFreeSlot(tilemapId);
        var baseIndex = slot * MaxCells;
        intGrid.CopyTo(_intGrid.AsSpan(baseIndex, cellCount));
        tiles.CopyTo(_tiles.AsSpan(baseIndex, cellCount));

        var nonEmpty = 0;
        for (var i = 0; i < cellCount; i++)
        {
            if (tiles[i] >= 0)
            {
                nonEmpty++;
            }
        }

        _ids[slot] = tilemapId;
        _widths[slot] = width;
        _heights[slot] = height;
        _tileSizes[slot] = tileSize;
        _nonEmptyCounts[slot] = nonEmpty;
        _liveCount++;
        return new TilemapHandle(slot);
    }

    public TilemapHandle Find(string tilemapId)
    {
        for (var slot = 0; slot < _maxTilemaps; slot++)
        {
            if (string.Equals(_ids[slot], tilemapId, StringComparison.Ordinal))
            {
                return new TilemapHandle(slot);
            }
        }

        return TilemapHandle.Invalid;
    }

    public int Width(TilemapHandle handle) => _widths[handle.Slot];
    public int Height(TilemapHandle handle) => _heights[handle.Slot];
    public int TileSize(TilemapHandle handle) => _tileSizes[handle.Slot];

    /// <summary>Tiles com arte (candidatos ao buffer estático consolidado).</summary>
    public int NonEmptyTiles(TilemapHandle handle) => _nonEmptyCounts[handle.Slot];

    /// <summary>Valor do IntGrid em uma célula (consulta de gameplay: colisão etc.).</summary>
    public short IntGridAt(TilemapHandle handle, int x, int y)
    {
        ValidateCell(handle, x, y);
        return _intGrid[handle.Slot * MaxCells + y * _widths[handle.Slot] + x];
    }

    /// <summary>Tile resolvido em uma célula (-1 = sem tile).</summary>
    public int TileAt(TilemapHandle handle, int x, int y)
    {
        ValidateCell(handle, x, y);
        return _tiles[handle.Slot * MaxCells + y * _widths[handle.Slot] + x];
    }

    /// <summary>Fatia somente-leitura dos tiles resolvidos — consumida pela camada Graphics.</summary>
    public ReadOnlySpan<int> Tiles(TilemapHandle handle) =>
        _tiles.AsSpan(handle.Slot * MaxCells, _widths[handle.Slot] * _heights[handle.Slot]);

    /// <summary>FNV-1a 32-bit dos tiles resolvidos — asserção e2e de determinismo do auto-tiling.</summary>
    public uint ComputeChecksum(TilemapHandle handle)
    {
        var baseIndex = handle.Slot * MaxCells;
        var count = _widths[handle.Slot] * _heights[handle.Slot];
        var hash = 2166136261u;
        for (var i = 0; i < count; i++)
        {
            var value = unchecked((uint)_tiles[baseIndex + i]);
            hash = (hash ^ (value & 0xFF)) * 16777619u;
            hash = (hash ^ ((value >> 8) & 0xFF)) * 16777619u;
            hash = (hash ^ ((value >> 16) & 0xFF)) * 16777619u;
            hash = (hash ^ ((value >> 24) & 0xFF)) * 16777619u;
        }

        return hash;
    }

    private void ValidateCell(TilemapHandle handle, int x, int y)
    {
        if (x < 0 || y < 0 || x >= _widths[handle.Slot] || y >= _heights[handle.Slot])
        {
            throw new ArgumentOutOfRangeException(
                nameof(x), $"Cell ({x}, {y}) outside {_widths[handle.Slot]}×{_heights[handle.Slot]}");
        }
    }

    private int FindFreeSlot(string tilemapId)
    {
        var free = -1;
        for (var slot = 0; slot < _maxTilemaps; slot++)
        {
            if (string.Equals(_ids[slot], tilemapId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"Tilemap \"{tilemapId}\" is already defined");
            }

            if (free < 0 && _ids[slot] is null)
            {
                free = slot;
            }
        }

        return free >= 0
            ? free
            : throw new InvalidOperationException(
                $"TilemapStore is full ({_maxTilemaps} slots); capacity is fixed at construction (Zero-GC policy)");
    }
}
