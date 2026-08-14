using Gridsmith.Engine.Core.Actors;
using Gridsmith.Engine.Core.Level;
using Gridsmith.Engine.Core.Rendering;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// O <see cref="FrameComposer"/> é a resposta da ADR-022 para "como verificar o
/// host sem GPU": o que o frame CONTÉM é domínio puro e determinístico, então
/// dá para afirmá-lo campo a campo, sem shader compilado e sem rasterizador.
/// </summary>
public class FrameComposerTests
{
    private const int TileSize = 16;

    private static TilemapStore MapaCom(int width, int height, Func<int, int, int> tileAt)
    {
        var store = new TilemapStore(maxTilemaps: 2);
        var intGrid = new short[width * height];
        var tiles = new int[width * height];
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                tiles[y * width + x] = tileAt(x, y);
                intGrid[y * width + x] = (short)(tiles[y * width + x] >= 0 ? 1 : 0);
            }
        }

        store.Define("nivel", width, height, TileSize, intGrid, tiles);
        return store;
    }

    private static FrameViewport JanelaInteira(int width, int height) =>
        new(
            CenterX: width * TileSize / 2f,
            CenterY: height * TileSize / 2f,
            Width: width * TileSize,
            Height: height * TileSize,
            Zoom: 1f);

    [Fact]
    public void Celula_sem_arte_resolvida_NAO_vira_quad()
    {
        // -1 é "nenhum tile"; emitir um quad faria o host desenhar um buraco
        // opaco por cima do fundo, e o editor não desenha nada ali
        var mapa = MapaCom(4, 4, (x, y) => x == y ? 7 : -1);
        var quads = new FrameQuad[64];

        var composicao = FrameComposer.Compose(
            mapa, new TilemapHandle(0), new ActorStore(), JanelaInteira(4, 4), 16f, quads);

        Assert.Equal(4, composicao.Required);
        Assert.Equal(4, composicao.Written);
        Assert.All(quads.AsSpan(0, 4).ToArray(), q => Assert.Equal(7, q.TileId));
    }

    [Fact]
    public void O_quad_fica_em_pixels_do_mundo_ancorado_no_canto_da_celula()
    {
        var mapa = MapaCom(4, 4, (x, y) => x == 2 && y == 3 ? 1 : -1);
        var quads = new FrameQuad[16];

        FrameComposer.Compose(
            mapa, new TilemapHandle(0), new ActorStore(), JanelaInteira(4, 4), 16f, quads);

        Assert.Equal(2 * TileSize, quads[0].X);
        Assert.Equal(3 * TileSize, quads[0].Y);
        Assert.Equal(TileSize, quads[0].Width);
        Assert.Equal(FrameLayer.Tilemap, quads[0].Layer);
    }

    [Fact]
    public void O_culling_cobra_o_que_se_ve_e_inclui_a_celula_parcial_da_borda()
    {
        // cortar a célula parcialmente visível deixaria uma tira preta na
        // lateral da janela a cada rolagem
        var mapa = MapaCom(64, 64, (_, _) => 3);
        var quads = new FrameQuad[4096];

        // recorte de 2,5 × 2,5 células no canto — 3×3 células tocadas
        var recorte = new FrameViewport(TileSize * 1.25f, TileSize * 1.25f, TileSize * 2.5f, TileSize * 2.5f, 1f);
        var composicao = FrameComposer.Compose(
            mapa, new TilemapHandle(0), new ActorStore(), recorte, 16f, quads);

        Assert.Equal(9, composicao.Required);
        Assert.False(composicao.Truncated);
    }

    [Fact]
    public void Mapa_inteiro_fora_do_recorte_nao_produz_quad()
    {
        var mapa = MapaCom(4, 4, (_, _) => 1);
        var quads = new FrameQuad[16];
        var longe = new FrameViewport(10_000f, 10_000f, 320f, 240f, 1f);

        var composicao = FrameComposer.Compose(
            mapa, new TilemapHandle(0), new ActorStore(), longe, 16f, quads);

        Assert.Equal(0, composicao.Required);
    }

    [Fact]
    public void O_truncamento_e_EXPLICITO_em_vez_de_silencioso()
    {
        // um frame truncado em silêncio desenha meio nível e parece bug de
        // conteúdo — quem compõe precisa conseguir perceber
        var mapa = MapaCom(8, 8, (_, _) => 2);
        var pequeno = new FrameQuad[10];

        var composicao = FrameComposer.Compose(
            mapa, new TilemapHandle(0), new ActorStore(), JanelaInteira(8, 8), 16f, pequeno);

        Assert.Equal(64, composicao.Required);
        Assert.Equal(10, composicao.Written);
        Assert.True(composicao.Truncated);
    }

    [Fact]
    public void O_ator_desenha_a_partir_do_CANTO_mas_e_posicionado_pelo_CENTRO()
    {
        // convenção espacial do documento v3: ENTITY_ANCHOR = center
        var atores = new ActorStore(maxActors: 4);
        atores.Spawn("jogador", "player", 100f, 200f);
        var quads = new FrameQuad[8];

        var composicao = FrameComposer.Compose(
            new TilemapStore(), TilemapHandle.Invalid, atores,
            new FrameViewport(100f, 200f, 640f, 480f, 1f), actorSize: 20f, quads);

        Assert.Equal(1, composicao.Written);
        Assert.Equal(90f, quads[0].X);
        Assert.Equal(190f, quads[0].Y);
        Assert.Equal(FrameLayer.Actor, quads[0].Layer);
        Assert.Equal(-1, quads[0].TileId); // archetype ainda não carrega sprite (B6)
    }

    [Fact]
    public void Os_atores_vem_DEPOIS_do_tilemap_na_ordem_do_pintor()
    {
        var mapa = MapaCom(2, 2, (_, _) => 5);
        var atores = new ActorStore(maxActors: 2);
        atores.Spawn("jogador", "player", 16f, 16f);
        var quads = new FrameQuad[16];

        var composicao = FrameComposer.Compose(
            mapa, new TilemapHandle(0), atores, JanelaInteira(2, 2), 16f, quads);

        Assert.Equal(5, composicao.Written);
        Assert.All(quads.AsSpan(0, 4).ToArray(), q => Assert.Equal(FrameLayer.Tilemap, q.Layer));
        Assert.Equal(FrameLayer.Actor, quads[4].Layer);
    }

    [Fact]
    public void A_composicao_do_frame_e_livre_de_alocacao()
    {
        // é caminho quente: alocar por frame reintroduziria pausas de GC no
        // desenho, que é o motivo de todo o núcleo ser DOD
        var mapa = MapaCom(64, 64, (x, y) => (x + y) % 3 == 0 ? -1 : (x * 31 + y));
        var atores = new ActorStore(maxActors: 64);
        for (var i = 0; i < 32; i++)
        {
            atores.Spawn($"ator-{i}", "player", i * 16f, i * 16f);
        }

        var quads = new FrameQuad[8192];
        var janela = JanelaInteira(64, 64);
        var handle = new TilemapHandle(0);

        var allocated = AllocationProbe.MinimumAllocatedBytes(() =>
        {
            for (var frame = 0; frame < 64; frame++)
            {
                FrameComposer.Compose(mapa, handle, atores, janela, 16f, quads);
            }
        });

        Assert.Equal(0, allocated);
    }
}
