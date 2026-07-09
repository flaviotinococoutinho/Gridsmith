using System.Numerics;
using P7m.Engine.Core.Camera;
using Xunit;

namespace P7m.Engine.Ipc.Tests;

public class CameraDynamicsTests
{
    private const float Dt = 1f / 120f;

    private static SecondOrderDynamics Simulate(
        float frequency, float damping, float response,
        Vector2 target, int steps, out float maxX)
    {
        var dynamics = new SecondOrderDynamics(frequency, damping, response, Vector2.Zero);
        maxX = 0f;
        for (var i = 0; i < steps; i++)
        {
            dynamics.Update(Dt, target, Vector2.Zero);
            maxX = MathF.Max(maxX, dynamics.Position.X);
        }

        return dynamics;
    }

    [Fact]
    public void Converges_to_static_target()
    {
        var dynamics = Simulate(2f, 1f, 0f, new Vector2(100f, -50f), steps: 600, out _);
        Assert.True(Vector2.Distance(dynamics.Position, new Vector2(100f, -50f)) < 0.5f,
            $"expected convergence, got {dynamics.Position}");
        Assert.True(dynamics.Velocity.Length() < 1f);
    }

    [Fact]
    public void Critical_damping_does_not_overshoot()
    {
        Simulate(2f, 1f, 0f, new Vector2(100f, 0f), steps: 600, out var maxX);
        Assert.True(maxX <= 100.5f, $"critically damped camera overshot to {maxX}");
    }

    [Fact]
    public void Underdamped_overshoots_and_still_converges()
    {
        var dynamics = Simulate(2f, 0.3f, 0f, new Vector2(100f, 0f), steps: 1200, out var maxX);
        Assert.True(maxX > 105f, $"underdamped camera should overshoot (max was {maxX})");
        Assert.True(MathF.Abs(dynamics.Position.X - 100f) < 1f);
    }

    [Fact]
    public void Higher_frequency_responds_faster()
    {
        var slow = new SecondOrderDynamics(1f, 1f, 0f, Vector2.Zero);
        var fast = new SecondOrderDynamics(4f, 1f, 0f, Vector2.Zero);
        var target = new Vector2(100f, 0f);
        for (var i = 0; i < 60; i++) // 0.5 s
        {
            slow.Update(Dt, target, Vector2.Zero);
            fast.Update(Dt, target, Vector2.Zero);
        }

        Assert.True(fast.Position.X > slow.Position.X + 10f,
            $"fast={fast.Position.X}, slow={slow.Position.X}");
    }

    [Fact]
    public void Snap_teleports_without_transient()
    {
        var dynamics = new SecondOrderDynamics(2f, 1f, 0f, Vector2.Zero);
        dynamics.Update(Dt, new Vector2(50f, 0f), Vector2.Zero);
        dynamics.Snap(new Vector2(200f, 200f));
        Assert.Equal(new Vector2(200f, 200f), dynamics.Position);
        Assert.Equal(Vector2.Zero, dynamics.Velocity);
    }

    [Fact]
    public void Update_is_allocation_free()
    {
        var dynamics = new SecondOrderDynamics(2f, 1f, 0f, Vector2.Zero);
        dynamics.Update(Dt, Vector2.One, Vector2.Zero); // aquecimento

        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 10_000; i++)
        {
            dynamics.Update(Dt, Vector2.One, Vector2.Zero);
        }

        Assert.Equal(0, GC.GetAllocatedBytesForCurrentThread() - before);
    }
}

public class ShakeGeneratorTests
{
    private static ShakeGenerator MakeShake(uint seed = 7) =>
        new(baseFrequencyHz: 18f, maxOffset: 24f, maxRotationRadians: 0.05f,
            traumaDecayPerSecond: 1.2f, seed: seed);

    [Fact]
    public void No_trauma_produces_no_perturbation()
    {
        var shake = MakeShake();
        shake.Update(0.1f);
        Assert.Equal(Vector2.Zero, shake.Offset);
        Assert.Equal(0f, shake.RotationRadians);
    }

    [Fact]
    public void Offset_stays_within_configured_bounds()
    {
        var shake = MakeShake();
        shake.AddTrauma(1f);
        for (var i = 0; i < 1000; i++)
        {
            shake.Update(1f / 240f);
            Assert.True(MathF.Abs(shake.Offset.X) <= 24f + 1e-3f);
            Assert.True(MathF.Abs(shake.Offset.Y) <= 24f + 1e-3f);
            Assert.True(MathF.Abs(shake.RotationRadians) <= 0.05f + 1e-5f);
        }
    }

    [Fact]
    public void Trauma_decays_linearly_to_zero()
    {
        var shake = MakeShake();
        shake.AddTrauma(0.6f);
        shake.Update(0.25f); // decai 1.2 * 0.25 = 0.3
        Assert.Equal(0.3f, shake.Trauma, 3);
        shake.Update(1f);
        Assert.Equal(0f, shake.Trauma);
        Assert.Equal(Vector2.Zero, shake.Offset);
    }

    [Fact]
    public void Amplitude_is_trauma_squared()
    {
        var shake = MakeShake();
        shake.AddTrauma(0.5f);
        Assert.Equal(0.25f, shake.Amplitude, 5);
    }

    [Fact]
    public void Same_seed_is_deterministic_different_seed_diverges()
    {
        var a = MakeShake(seed: 42);
        var b = MakeShake(seed: 42);
        var c = MakeShake(seed: 43);
        a.AddTrauma(1f);
        b.AddTrauma(1f);
        c.AddTrauma(1f);

        var diverged = false;
        for (var i = 0; i < 100; i++)
        {
            a.Update(1f / 60f);
            b.Update(1f / 60f);
            c.Update(1f / 60f);
            Assert.Equal(a.Offset, b.Offset);
            if (Vector2.Distance(a.Offset, c.Offset) > 0.1f)
            {
                diverged = true;
            }
        }

        Assert.True(diverged, "different seeds should produce different shake patterns");
    }
}

public class CinematicCameraTests
{
    [Fact]
    public void Anticipation_leads_the_moving_target()
    {
        var withLookahead = new CinematicCamera(CameraConfig.Default with { AnticipationSeconds = 0.5f });
        var without = new CinematicCamera(CameraConfig.Default with { AnticipationSeconds = 0f });

        var velocity = new Vector2(200f, 0f);
        for (var i = 0; i < 480; i++) // alvo em movimento constante
        {
            var target = new Vector2(i * velocity.X / 120f, 0f);
            withLookahead.Update(1f / 120f, target, velocity);
            without.Update(1f / 120f, target, velocity);
        }

        // a câmera com antecipação fica à FRENTE da câmera sem antecipação
        Assert.True(withLookahead.Position.X > without.Position.X + 30f,
            $"lookahead={withLookahead.Position.X}, plain={without.Position.X}");
    }

    [Fact]
    public void ViewProjection_centers_the_camera_position()
    {
        var camera = new CinematicCamera(CameraConfig.Default);
        camera.Snap(new Vector2(320f, 240f));
        var vp = camera.ComputeViewProjection(640f, 480f);

        // o ponto onde a câmera está deve ir para a origem do NDC
        var ndc = Vector4.Transform(new Vector4(320f, 240f, 0f, 1f), vp);
        Assert.Equal(0f, ndc.X, 4);
        Assert.Equal(0f, ndc.Y, 4);

        // um ponto meia-tela à direita deve ir para x = +1
        var right = Vector4.Transform(new Vector4(320f + 320f, 240f, 0f, 1f), vp);
        Assert.Equal(1f, right.X, 4);
    }

    [Fact]
    public void Shake_perturbs_the_projection_matrix()
    {
        var config = CameraConfig.Default with { ShakeSeed = 5 };
        var calm = new CinematicCamera(config);
        var shaken = new CinematicCamera(config);
        calm.Snap(Vector2.Zero);
        shaken.Snap(Vector2.Zero);
        shaken.AddTrauma(1f);

        calm.Update(1f / 60f, Vector2.Zero, Vector2.Zero);
        shaken.Update(1f / 60f, Vector2.Zero, Vector2.Zero);

        var calmVp = calm.ComputeViewProjection(640f, 480f);
        var shakenVp = shaken.ComputeViewProjection(640f, 480f);
        Assert.NotEqual(calmVp, shakenVp);

        // e o shake decai: sem trauma as matrizes voltam a coincidir
        for (var i = 0; i < 600; i++)
        {
            shaken.Update(1f / 60f, Vector2.Zero, Vector2.Zero);
        }

        Assert.Equal(0f, shaken.Trauma);
        Assert.Equal(calm.ComputeViewProjection(640f, 480f), shaken.ComputeViewProjection(640f, 480f));
    }

    [Fact]
    public void Update_and_projection_are_allocation_free()
    {
        var camera = new CinematicCamera(CameraConfig.Default);
        camera.AddTrauma(0.5f);
        camera.Update(1f / 60f, Vector2.One, Vector2.Zero);
        camera.ComputeViewProjection(640f, 480f); // aquecimento

        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < 10_000; i++)
        {
            camera.Update(1f / 60f, Vector2.One, Vector2.Zero);
            camera.ComputeViewProjection(640f, 480f);
        }

        Assert.Equal(0, GC.GetAllocatedBytesForCurrentThread() - before);
    }
}
