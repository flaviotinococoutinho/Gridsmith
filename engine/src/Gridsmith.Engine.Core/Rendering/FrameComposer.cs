using Gridsmith.Engine.Core.Actors;
using Gridsmith.Engine.Core.Level;

namespace Gridsmith.Engine.Core.Rendering;

/// <summary>Camada de desenho — define a ordem do pintor, e nada mais.</summary>
public enum FrameLayer : byte
{
    Tilemap = 0,
    Actor = 1,
}

/// <summary>
/// Um quad a desenhar, em pixels do mundo.
///
/// Deliberadamente SEM tipos gráficos: nada de <c>Texture2D</c>, <c>Effect</c>
/// ou <c>Rectangle</c> do MonoGame. É o que permite descrever um frame — e
/// compará-lo com o que o editor desenharia — sem GPU e sem shader compilado.
/// </summary>
/// <param name="X">Canto superior esquerdo, em pixels do mundo.</param>
/// <param name="Y">Canto superior esquerdo, em pixels do mundo.</param>
/// <param name="TileId">
/// Região do atlas a amostrar; <c>-1</c> quando a origem não tem arte
/// resolvida. Atores hoje SEMPRE saem com <c>-1</c>: o archetype ainda não
/// carrega sprite pelo fio (pendência B6), e inventar um tile aqui faria o
/// host desenhar uma arte que o documento nunca declarou.
/// </param>
/// <param name="Source">Slot de origem (tilemap ou ator) — rastreia a causa de cada quad.</param>
public readonly record struct FrameQuad(
    float X,
    float Y,
    float Width,
    float Height,
    int TileId,
    FrameLayer Layer,
    int Source);

/// <summary>Recorte visível, em pixels do mundo, já com o zoom aplicado.</summary>
public readonly record struct FrameViewport(
    float CenterX,
    float CenterY,
    float Width,
    float Height,
    float Zoom)
{
    /// <summary>Meia-extensão horizontal do mundo visível.</summary>
    public float HalfWorldWidth => Width / (2f * Zoom);

    /// <summary>Meia-extensão vertical do mundo visível.</summary>
    public float HalfWorldHeight => Height / (2f * Zoom);
}

/// <summary>
/// Resultado da composição. <see cref="Required"/> é o total de quads visíveis;
/// <see cref="Written"/> é quanto coube no buffer do chamador.
///
/// A diferença é EXPLÍCITA de propósito: um frame truncado em silêncio desenha
/// meio nível e parece um bug de conteúdo. Quem compõe decide se cresce o
/// buffer (fase de carga) ou aceita o corte.
/// </summary>
public readonly record struct FrameComposition(int Written, int Required)
{
    public bool Truncated => Required > Written;
}

/// <summary>
/// Compõe a lista de quads de um frame a partir dos stores DOD.
///
/// É o coração da decisão da ADR-022: <b>o que</b> desenhar é domínio puro e
/// testável; <b>como</b> desenhar é a camada MonoGame. Sem esta separação, a
/// única forma de verificar o host seria comparar pixels de dois
/// rasterizadores diferentes — o que exigiria GPU e shader compilado no CI, e
/// só passaria com uma tolerância larga o bastante para esconder o que o teste
/// deveria pegar.
///
/// <para><b>Zero-GC:</b> escreve no buffer do CHAMADOR e não aloca nada por
/// frame — sem LINQ, sem closure, sem boxing. É caminho quente.</para>
/// </summary>
public static class FrameComposer
{
    /// <summary>
    /// Compõe o frame na ordem do pintor: tilemap primeiro, atores por cima.
    /// Células fora do recorte visível não entram — o custo acompanha o que se
    /// vê, não o tamanho do mapa.
    /// </summary>
    /// <param name="actorSize">
    /// Lado do quad de um ator, em pixels do mundo. Vem de FORA porque o
    /// archetype ainda não carrega tamanho pelo fio (B6); deixar o composer
    /// escolher um default esconderia a lacuna.
    /// </param>
    public static FrameComposition Compose(
        TilemapStore tilemaps,
        TilemapHandle map,
        ActorStore actors,
        in FrameViewport viewport,
        float actorSize,
        Span<FrameQuad> destination)
    {
        var written = 0;
        var required = 0;

        ComposeTilemap(tilemaps, map, viewport, destination, ref written, ref required);
        ComposeActors(actors, viewport, actorSize, destination, ref written, ref required);

        return new FrameComposition(written, required);
    }

    private static void ComposeTilemap(
        TilemapStore tilemaps,
        TilemapHandle map,
        in FrameViewport viewport,
        Span<FrameQuad> destination,
        ref int written,
        ref int required)
    {
        if (!map.IsValid || tilemaps.LiveCount == 0)
        {
            return;
        }

        var width = tilemaps.Width(map);
        var height = tilemaps.Height(map);
        var tileSize = tilemaps.TileSize(map);
        if (width <= 0 || height <= 0 || tileSize <= 0)
        {
            return;
        }

        var minX = viewport.CenterX - viewport.HalfWorldWidth;
        var maxX = viewport.CenterX + viewport.HalfWorldWidth;
        var minY = viewport.CenterY - viewport.HalfWorldHeight;
        var maxY = viewport.CenterY + viewport.HalfWorldHeight;

        // Clamp ao mapa: um recorte fora dele produz faixa vazia, não índice
        // negativo. `+1` no fim porque a célula parcialmente visível na borda
        // precisa ser desenhada — cortá-la deixa uma tira preta na lateral.
        var firstColumn = Math.Clamp((int)MathF.Floor(minX / tileSize), 0, width - 1);
        var lastColumn = Math.Clamp((int)MathF.Floor(maxX / tileSize), 0, width - 1);
        var firstRow = Math.Clamp((int)MathF.Floor(minY / tileSize), 0, height - 1);
        var lastRow = Math.Clamp((int)MathF.Floor(maxY / tileSize), 0, height - 1);

        // O mapa inteiro pode estar fora do recorte; o clamp acima já garante
        // faixa válida, então só resta o caso de recorte completamente fora.
        if (maxX < 0f || maxY < 0f || minX > width * tileSize || minY > height * tileSize)
        {
            return;
        }

        var tiles = tilemaps.Tiles(map);
        for (var row = firstRow; row <= lastRow; row++)
        {
            var rowOffset = row * width;
            for (var column = firstColumn; column <= lastColumn; column++)
            {
                var tileId = tiles[rowOffset + column];
                // -1 é célula sem arte resolvida: não vira quad. Emitir um quad
                // vazio faria o host desenhar um buraco opaco sobre o fundo.
                if (tileId < 0)
                {
                    continue;
                }

                required++;
                if (written >= destination.Length)
                {
                    continue;
                }

                destination[written++] = new FrameQuad(
                    column * tileSize,
                    row * tileSize,
                    tileSize,
                    tileSize,
                    tileId,
                    FrameLayer.Tilemap,
                    rowOffset + column);
            }
        }
    }

    private static void ComposeActors(
        ActorStore actors,
        in FrameViewport viewport,
        float actorSize,
        Span<FrameQuad> destination,
        ref int written,
        ref int required)
    {
        if (actors.LiveCount == 0 || actorSize <= 0f)
        {
            return;
        }

        var half = actorSize / 2f;
        var minX = viewport.CenterX - viewport.HalfWorldWidth - half;
        var maxX = viewport.CenterX + viewport.HalfWorldWidth + half;
        var minY = viewport.CenterY - viewport.HalfWorldHeight - half;
        var maxY = viewport.CenterY + viewport.HalfWorldHeight + half;

        for (var slot = 0; slot < actors.Capacity; slot++)
        {
            var handle = new ActorHandle(slot);
            if (!actors.IsLive(handle))
            {
                continue;
            }

            // A posição do ator é o CENTRO (convenção espacial do documento v3:
            // ENTITY_ANCHOR = center); o quad é desenhado a partir do canto.
            var centerX = actors.PositionX(handle);
            var centerY = actors.PositionY(handle);
            if (centerX < minX || centerX > maxX || centerY < minY || centerY > maxY)
            {
                continue;
            }

            required++;
            if (written >= destination.Length)
            {
                continue;
            }

            destination[written++] = new FrameQuad(
                centerX - half,
                centerY - half,
                actorSize,
                actorSize,
                -1,
                FrameLayer.Actor,
                slot);
        }
    }
}
