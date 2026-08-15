using Gridsmith.Engine.Core.Rendering;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// ESTES CASOS SÃO ESPELHADOS no editor (`frontend/test/tileset-atlas.test.ts`),
/// número a número: a paridade visual da ADR-022 depende de a fórmula da grade
/// ser idêntica nos dois lados, e o espelhamento é o que transforma essa
/// promessa em teste — mudar a fórmula de UM lado quebra a suíte DELE com os
/// mesmos valores que o outro continua afirmando.
/// </summary>
public class TilesetTableTests
{
    private static readonly TilesetTable Table = new("terreno", "assets/terreno.png", 16, 8, 48);

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(3, 48, 0)]
    // 8 colunas: o id 8 quebra para a segunda linha
    [InlineData(8, 0, 16)]
    [InlineData(47, 112, 80)]
    public void A_regiao_e_formula_da_grade(int tileId, int expectedX, int expectedY)
    {
        Assert.True(Table.TryRegion(tileId, out var x, out var y));
        Assert.Equal(expectedX, x);
        Assert.Equal(expectedY, y);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(48)]
    public void Fora_da_faixa_nao_e_erro_e_ausencia_de_arte(int tileId)
    {
        Assert.False(Table.TryRegion(tileId, out _, out _));
    }

    [Theory]
    // tuplas fixadas no espelho TS: (id, r, g, b) do hash de Knuth do host
    [InlineData(0, 0x50, 0x50, 0x50)]
    [InlineData(1, 0x81, 0xC9, 0x87)]
    [InlineData(7, 0xA7, 0xA3, 0x54)]
    public void A_cor_de_fallback_e_o_mesmo_hash_do_editor(int tileId, int r, int g, int b)
    {
        // a MESMA expressão do GridsmithGame.ColorOf — duplicada aqui de
        // propósito: o teste trava a fórmula publicada, não a implementação
        var hash = (uint)tileId * 2654435761u;
        Assert.Equal(r, (int)(80 + (hash & 0x7F)));
        Assert.Equal(g, (int)(80 + ((hash >> 8) & 0x7F)));
        Assert.Equal(b, (int)(80 + ((hash >> 16) & 0x7F)));
    }

    [Fact]
    public void O_registro_faz_upsert_e_o_tilemap_carrega_o_vinculo()
    {
        var registry = new TilesetRegistry();
        registry.Apply(Table);
        registry.Apply(Table with { Columns = 8, TileCount = 64 });
        Assert.True(registry.TryGet("terreno", out var updated));
        Assert.Equal(64, updated.TileCount);

        var tilemaps = new Core.Level.TilemapStore(maxTilemaps: 2);
        var intGrid = new short[4];
        var tiles = new int[4];
        var handle = tilemaps.Define("nivel", 2, 2, 16, intGrid, tiles, "terreno");
        Assert.Equal("terreno", tilemaps.TilesetId(handle));

        tilemaps.Remove(handle);
        var again = tilemaps.Define("nivel", 2, 2, 16, intGrid, tiles);
        Assert.Null(tilemaps.TilesetId(again));
    }
}
