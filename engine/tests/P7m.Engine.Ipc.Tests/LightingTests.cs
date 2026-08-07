using System.Numerics;
using P7m.Engine.Core.Lighting;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

public class Lighting2DTests
{
    private static readonly Vector3 FlatNormal = new(0f, 0f, 1f);

    [Fact]
    public void Attenuation_is_full_at_center_and_zero_at_radius()
    {
        Assert.Equal(1f, Lighting2D.Attenuation(0f, 100f), 5);
        Assert.Equal(0f, Lighting2D.Attenuation(100f, 100f), 5);
        Assert.Equal(0f, Lighting2D.Attenuation(150f, 100f), 5);
        // curva (1-x²)²: em d = r/2 → (1-0.25)² = 0.5625
        Assert.Equal(0.5625f, Lighting2D.Attenuation(50f, 100f), 5);
    }

    [Fact]
    public void Point_light_directly_above_surface_gives_full_ndotl()
    {
        // luz em (0,0) com altura h: L = (0,0,1) → N·L = 1 com normal plana
        var rgb = Lighting2D.EvaluatePoint(
            position: Vector2.Zero, height: 50f, radius: 100f,
            color: Vector3.One, intensity: 2f,
            surface: Vector2.Zero, surfaceNormal: FlatNormal);

        var expected = 2f * Lighting2D.Attenuation(50f, 100f); // ndotl = 1
        Assert.Equal(expected, rgb.X, 4);
        Assert.Equal(rgb.X, rgb.Y, 5);
    }

    [Fact]
    public void Point_light_ndotl_favors_surfaces_facing_the_light()
    {
        // luz à direita da superfície, sem altura: L = (1, 0, 0)
        var facing = Lighting2D.EvaluatePoint(
            new Vector2(10f, 0f), 0f, 100f, Vector3.One, 1f,
            Vector2.Zero, new Vector3(1f, 0f, 0f)); // normal aponta para a luz
        var averted = Lighting2D.EvaluatePoint(
            new Vector2(10f, 0f), 0f, 100f, Vector3.One, 1f,
            Vector2.Zero, new Vector3(-1f, 0f, 0f)); // normal oposta

        Assert.True(facing.X > 0.5f);
        Assert.Equal(0f, averted.X, 5); // N·L clampado em zero
    }

    [Fact]
    public void Point_light_outside_radius_contributes_nothing()
    {
        var rgb = Lighting2D.EvaluatePoint(
            new Vector2(500f, 0f), 0f, 100f, Vector3.One, 5f, Vector2.Zero, FlatNormal);
        Assert.Equal(Vector3.Zero, rgb);
    }

    [Fact]
    public void Spot_cone_is_full_inside_zero_outside()
    {
        // spot em (0,0) apontando +X, cone interno 30°, externo 60° (meio-ângulos)
        var innerCos = MathF.Cos(30f * MathF.PI / 180f);
        var outerCos = MathF.Cos(60f * MathF.PI / 180f);

        Vector3 Eval(Vector2 surface) => Lighting2D.EvaluateSpot(
            Vector2.Zero, 0f, 200f, new Vector2(1f, 0f), innerCos, outerCos,
            Vector3.One, 1f, surface, new Vector3(-1f, 0f, 0f)); // normal olhando para a luz

        var onAxis = Eval(new Vector2(50f, 0f));
        var behind = Eval(new Vector2(-50f, 0f));       // 180° fora do cone
        var perpendicular = Eval(new Vector2(0f, 50f)); // 90° fora do cone externo

        Assert.True(onAxis.X > 0.5f);
        Assert.Equal(0f, behind.X, 5);
        Assert.Equal(0f, perpendicular.X, 5);
    }

    [Fact]
    public void Spot_cone_edge_fades_smoothly_between_inner_and_outer()
    {
        var innerCos = MathF.Cos(15f * MathF.PI / 180f);
        var outerCos = MathF.Cos(45f * MathF.PI / 180f);

        Vector3 EvalAtAngle(float degrees)
        {
            var rad = degrees * MathF.PI / 180f;
            var surface = new Vector2(MathF.Cos(rad), MathF.Sin(rad)) * 50f;
            var normal = new Vector3(-MathF.Cos(rad), -MathF.Sin(rad), 0f);
            return Lighting2D.EvaluateSpot(
                Vector2.Zero, 0f, 200f, new Vector2(1f, 0f), innerCos, outerCos,
                Vector3.One, 1f, surface, normal);
        }

        var inside = EvalAtAngle(10f);
        var middle = EvalAtAngle(30f);
        var outside = EvalAtAngle(50f);

        Assert.True(inside.X > middle.X, "intensity must fall toward the cone edge");
        Assert.True(middle.X > 0f);
        Assert.Equal(0f, outside.X, 5);
    }

    [Fact]
    public void Directional_light_is_position_independent()
    {
        var direction = new Vector2(0f, 1f); // apontando para baixo (+Y)
        var a = Lighting2D.EvaluateDirectional(direction, Vector3.One, 1f, FlatNormal);
        var b = Lighting2D.EvaluateDirectional(direction, Vector3.One, 1f, FlatNormal);
        Assert.Equal(a, b);
        Assert.True(a.X > 0f);
    }
}

public class LightStoreTests
{
    private static LightData PointLight(float x, float y, float intensity = 1f) => new(
        LightType.Point, new Vector2(x, y), Height: 0f, Direction: new Vector2(0f, -1f),
        Color: Vector3.One, Intensity: intensity, Radius: 100f, InnerConeCos: 1f, OuterConeCos: 0f);

    [Fact]
    public void Add_get_remove_roundtrip_and_slot_reuse()
    {
        var store = new LightStore(capacity: 4);
        var a = store.Add(PointLight(1f, 0f));
        var b = store.Add(PointLight(2f, 0f));
        Assert.Equal(2, store.LiveCount);
        Assert.Equal(new Vector2(2f, 0f), store.Get(b).Position);

        store.Remove(a);
        Assert.Equal(1, store.LiveCount);
        Assert.False(store.IsActive(a));

        var c = store.Add(PointLight(3f, 0f)); // recicla o slot liberado
        Assert.Equal(a.Slot, c.Slot);
        Assert.Equal(new Vector2(3f, 0f), store.Get(c).Position);
    }

    [Fact]
    public void Full_store_rejects_add_capacity_is_fixed()
    {
        var store = new LightStore(capacity: 1);
        store.Add(PointLight(0f, 0f));
        Assert.Throws<InvalidOperationException>(() => store.Add(PointLight(1f, 1f)));
    }

    [Fact]
    public void Accumulate_sums_multiple_lights()
    {
        var store = new LightStore(capacity: 8);
        store.Add(PointLight(0f, 0f, intensity: 1f));
        var single = store.Accumulate(Vector2.Zero, new Vector3(0f, 0f, 1f));

        store.Add(PointLight(0f, 0f, intensity: 1f));
        var doubled = store.Accumulate(Vector2.Zero, new Vector3(0f, 0f, 1f));

        Assert.Equal(single.X * 2f, doubled.X, 4);
    }

    [Fact]
    public void Accumulate_is_allocation_free()
    {
        var store = new LightStore(capacity: 64);
        for (var i = 0; i < 32; i++)
        {
            store.Add(PointLight(i * 10f, 0f));
        }

        for (var w = 0; w < 1_000; w++) // aquecimento além do tiered JIT
        {
            store.Accumulate(Vector2.Zero, new Vector3(0f, 0f, 1f));
        }

        var allocated = AllocationProbe.MinimumAllocatedBytes(() =>
        {
            for (var frame = 0; frame < 1000; frame++)
            {
                store.Accumulate(new Vector2(frame % 100, 0f), new Vector3(0f, 0f, 1f));
            }
        });

        Assert.Equal(0, allocated);
    }
}

public class ColorLutTests
{
    [Fact]
    public void Identity_lut_preserves_grayscale()
    {
        var lut = ColorLut.Identity();
        var gray = new Vector3(0.5f, 0.5f, 0.5f);
        var graded = lut.Apply(gray, strength: 1f);
        Assert.Equal(0.5f, graded.X, 3);
        Assert.Equal(0.5f, graded.Y, 3);
        Assert.Equal(0.5f, graded.Z, 3);
    }

    [Fact]
    public void Strength_zero_is_a_no_op()
    {
        var nightLut = new ColorLut([new Vector3(0f, 0f, 0.2f), new Vector3(0.4f, 0.5f, 1f)]);
        var color = new Vector3(0.8f, 0.4f, 0.1f);
        Assert.Equal(color, nightLut.Apply(color, strength: 0f));
    }

    [Fact]
    public void Sample_interpolates_between_stops()
    {
        var lut = new ColorLut([new Vector3(0f), new Vector3(1f, 0f, 0f)], resolution: 256);
        var mid = lut.Sample(0.5f);
        Assert.Equal(0.5f, mid.X, 2);
        Assert.Equal(0f, mid.Y, 3);
    }

    [Fact]
    public void Day_night_transition_shifts_palette_toward_blue()
    {
        // LUT "noite": sombras azuladas, altas-luzes frias
        var night = new ColorLut([new Vector3(0.02f, 0.03f, 0.15f), new Vector3(0.6f, 0.7f, 1f)]);
        var warm = new Vector3(0.9f, 0.6f, 0.3f);
        var graded = night.Apply(warm, strength: 1f);
        Assert.True(graded.Z > graded.X, "night palette should push blue above red");
    }
}
