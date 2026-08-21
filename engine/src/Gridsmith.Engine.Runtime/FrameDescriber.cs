using System.Globalization;
using System.Text;
using System.Text.Json;
using Gridsmith.Engine.Core.Actors;
using Gridsmith.Engine.Core.Level;
using Gridsmith.Engine.Core.Rendering;

namespace Gridsmith.Engine.Runtime;

/// <summary>
/// Modo <c>--describe-frame</c>: compõe um frame via <see cref="FrameComposer"/>
/// a partir de um cenário JSON e o serializa no formato canônico de linha.
///
/// É a metade .NET da paridade visual da ADR-022 — e vive no RUNTIME headless
/// de propósito: o composer é Core puro, então a descrição roda no CI sem
/// GPU, sem SDL e sem o Host gráfico (regra E4 intacta). O que o host
/// DESENHA é exatamente esta lista; verificada a lista, o desenho é só
/// rasterização.
///
/// O formato de saída é texto simples, não JSON: comparar JSON byte a byte
/// esbarraria nas diferenças de formatação de ponto flutuante entre
/// serializadores; aqui o formato numérico é definido por nós ("0.###",
/// invariante) e os cenários usam apenas frações binárias exatas.
/// </summary>
internal static class FrameDescriber
{
    private sealed record ScenarioLevel(int Width, int Height, int TileSize, int[] Tiles);

    private sealed record ScenarioActor(string EntityId, float X, float Y);

    private sealed record ScenarioViewport(float CenterX, float CenterY, float Width, float Height, float Zoom);

    private sealed record Scenario(
        ScenarioLevel? Level,
        ScenarioActor[]? Actors,
        ScenarioViewport Viewport,
        float ActorSize);

    public static int Run(string scenarioPath)
    {
        var scenario = JsonSerializer.Deserialize<Scenario>(
            File.ReadAllText(scenarioPath),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        if (scenario is null || scenario.Viewport is null)
        {
            Console.Error.WriteLine("[describe-frame] cenário inválido: viewport obrigatório");
            return 2;
        }

        var tilemaps = new TilemapStore(maxTilemaps: 1);
        var map = TilemapHandle.Invalid;
        if (scenario.Level is { } level)
        {
            // o IntGrid não participa da composição; um grid zerado satisfaz o
            // Define sem inventar significado
            var intGrid = new short[level.Width * level.Height];
            map = tilemaps.Define("parity", level.Width, level.Height, level.TileSize, intGrid, level.Tiles);
        }

        var actors = new ActorStore(maxActors: Math.Max(1, scenario.Actors?.Length ?? 0));
        foreach (var actor in scenario.Actors ?? [])
        {
            // spawn em ordem do cenário → slots 0..n-1, a MESMA ordem que o
            // espelho TS usa como `source`
            actors.Spawn(actor.EntityId, "parity", actor.X, actor.Y);
        }

        var viewport = new FrameViewport(
            scenario.Viewport.CenterX,
            scenario.Viewport.CenterY,
            scenario.Viewport.Width,
            scenario.Viewport.Height,
            scenario.Viewport.Zoom);

        var quads = new FrameQuad[TilemapStore.MaxCells + actors.Capacity];
        var composition = FrameComposer.Compose(tilemaps, map, actors, viewport, scenario.ActorSize, quads);
        if (composition.Truncated)
        {
            Console.Error.WriteLine("[describe-frame] buffer insuficiente — cenário grande demais");
            return 2;
        }

        Console.Out.Write(Describe(quads.AsSpan(0, composition.Written)));
        return 0;
    }

    private static string Describe(ReadOnlySpan<FrameQuad> quads)
    {
        var builder = new StringBuilder();
        builder.Append("frame quads=").Append(quads.Length).Append('\n');
        foreach (ref readonly var quad in quads)
        {
            builder
                .Append("quad x=").Append(Fmt(quad.X))
                .Append(" y=").Append(Fmt(quad.Y))
                .Append(" w=").Append(Fmt(quad.Width))
                .Append(" h=").Append(Fmt(quad.Height))
                .Append(" tile=").Append(quad.TileId)
                .Append(" layer=").Append(quad.Layer == FrameLayer.Tilemap ? "tilemap" : "actor")
                .Append(" source=").Append(quad.Source)
                .Append('\n');
        }

        return builder.ToString();
    }

    private static string Fmt(float value)
    {
        var text = Math.Round(value, 3).ToString("0.###", CultureInfo.InvariantCulture);
        return text == "-0" ? "0" : text;
    }
}
