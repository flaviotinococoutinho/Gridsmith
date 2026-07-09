using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using P7m.Engine.Core.Lighting;
using XnaMatrix = Microsoft.Xna.Framework.Matrix;

namespace P7m.Engine.Graphics;

/// <summary>
/// Executor do pipeline deferred 2D em múltiplos alvos (MRT):
///
/// <list type="number">
///   <item><b>G-Buffer:</b> grava albedo (RT0) e normal map (RT1) em uma
///     única passada com GBuffer.fx;</item>
///   <item><b>Light Pass:</b> acumula cada luz do <see cref="LightStore"/>
///     com blend aditivo sobre o alvo de luz (DeferredLight.fx);</item>
///   <item><b>Composite:</b> combina albedo × (ambiente + luz) e aplica a
///     LUT cromática em quad de tela cheia (Composite.fx).</item>
/// </list>
///
/// Todos os alvos e buffers são criados uma única vez em
/// <see cref="CreateTargets"/> — nenhuma alocação por frame (Zero-GC).
/// Os efeitos (.fx) são compilados pelo MGCB (ver Content/README.md).
/// </summary>
public sealed class DeferredRenderer : IDisposable
{
    private readonly GraphicsDevice _device;
    private readonly Effect _gBufferEffect;
    private readonly Effect _lightEffect;
    private readonly Effect _compositeEffect;

    private RenderTarget2D? _albedoTarget;
    private RenderTarget2D? _normalTarget;
    private RenderTarget2D? _lightTarget;
    private RenderTargetBinding[] _gBufferBindings = [];

    public Vector3 AmbientColor { get; set; } = new(0.15f, 0.15f, 0.18f);
    public float LutStrength { get; set; }

    public DeferredRenderer(GraphicsDevice device, Effect gBuffer, Effect light, Effect composite)
    {
        _device = device;
        _gBufferEffect = gBuffer;
        _lightEffect = light;
        _compositeEffect = composite;
    }

    public RenderTarget2D? AlbedoTarget => _albedoTarget;
    public RenderTarget2D? NormalTarget => _normalTarget;
    public RenderTarget2D? LightTarget => _lightTarget;

    /// <summary>Cria (ou recria em resize) os alvos do pipeline — fase de carga.</summary>
    public void CreateTargets(int width, int height)
    {
        DisposeTargets();
        _albedoTarget = new RenderTarget2D(_device, width, height, false, SurfaceFormat.Color, DepthFormat.None);
        _normalTarget = new RenderTarget2D(_device, width, height, false, SurfaceFormat.Color, DepthFormat.None);
        _lightTarget = new RenderTarget2D(_device, width, height, false, SurfaceFormat.HdrBlendable, DepthFormat.None);
        _gBufferBindings = [new RenderTargetBinding(_albedoTarget), new RenderTargetBinding(_normalTarget)];
    }

    /// <summary>Passo 1: liga o MRT do G-Buffer e limpa os alvos.</summary>
    public Effect BeginGBufferPass(in System.Numerics.Matrix4x4 viewProjection)
    {
        _device.SetRenderTargets(_gBufferBindings);
        _device.Clear(Color.Transparent);
        _device.BlendState = BlendState.AlphaBlend;
        _gBufferEffect.Parameters["ViewProjection"].SetValue(ToXna(viewProjection));
        return _gBufferEffect;
    }

    /// <summary>
    /// Passo 2: acumula as luzes ativas. O chamador desenha o quad do volume
    /// de cada luz após cada <c>Apply</c>; os parâmetros espelham
    /// <see cref="Lighting2D"/> — mesma equação da referência de CPU.
    /// </summary>
    public void BeginLightPass(in System.Numerics.Matrix4x4 viewProjection)
    {
        _device.SetRenderTarget(_lightTarget);
        _device.Clear(Color.Black);
        _device.BlendState = BlendState.Additive;
        _lightEffect.Parameters["ViewProjection"].SetValue(ToXna(viewProjection));
        _lightEffect.Parameters["NormalBuffer"].SetValue(_normalTarget);
    }

    public Effect ApplyLight(in LightData light)
    {
        var p = _lightEffect.Parameters;
        p["LightType"].SetValue((int)light.Type);
        p["LightPosition"].SetValue(new Vector2(light.Position.X, light.Position.Y));
        p["LightHeight"].SetValue(light.Height);
        p["LightDirection"].SetValue(new Vector2(light.Direction.X, light.Direction.Y));
        p["LightColor"].SetValue(new Vector3(light.Color.X, light.Color.Y, light.Color.Z));
        p["LightIntensity"].SetValue(light.Intensity);
        p["LightRadius"].SetValue(light.Radius);
        p["InnerConeCos"].SetValue(light.InnerConeCos);
        p["OuterConeCos"].SetValue(light.OuterConeCos);
        return _lightEffect;
    }

    /// <summary>Passo 3: composição final + LUT no backbuffer.</summary>
    public Effect BeginCompositePass(Texture2D lutTexture)
    {
        _device.SetRenderTarget(null);
        _device.BlendState = BlendState.Opaque;
        var p = _compositeEffect.Parameters;
        p["AlbedoBuffer"].SetValue(_albedoTarget);
        p["LightBuffer"].SetValue(_lightTarget);
        p["LutTexture"].SetValue(lutTexture);
        p["AmbientColor"].SetValue(new Vector3(AmbientColor.X, AmbientColor.Y, AmbientColor.Z));
        p["LutStrength"].SetValue(LutStrength);
        return _compositeEffect;
    }

    private static XnaMatrix ToXna(in System.Numerics.Matrix4x4 m) => new(
        m.M11, m.M12, m.M13, m.M14,
        m.M21, m.M22, m.M23, m.M24,
        m.M31, m.M32, m.M33, m.M34,
        m.M41, m.M42, m.M43, m.M44);

    private void DisposeTargets()
    {
        _albedoTarget?.Dispose();
        _normalTarget?.Dispose();
        _lightTarget?.Dispose();
        _albedoTarget = _normalTarget = _lightTarget = null;
    }

    public void Dispose()
    {
        DisposeTargets();
    }
}
