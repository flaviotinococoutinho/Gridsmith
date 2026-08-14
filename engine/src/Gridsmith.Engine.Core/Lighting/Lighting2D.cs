using System.Numerics;

namespace Gridsmith.Engine.Core.Lighting;

/// <summary>
/// Referência de CPU das equações do Light Pass deferred 2D.
///
/// ESTE ARQUIVO É O CONTRATO DO SHADER: as mesmas fórmulas estão em
/// engine/src/Gridsmith.Engine.Graphics/Shaders/DeferredLight.fx. Alterou aqui,
/// altere lá — os testes cobrem esta implementação e o harness headless
/// (Fase 5) usa-a para asserções sem GPU.
///
/// Modelo: superfícies vivem no plano z=0 com normais de normal map
/// (componentes em [-1,1], z &gt; 0 aponta para a câmera). Luzes pontuais e
/// spot têm altura (z) acima do plano para dar volume à iluminação.
/// </summary>
public static class Lighting2D
{
    /// <summary>Atenuação suave por distância: (1 - (d/r)²)² clampado — sem borda dura no raio.</summary>
    public static float Attenuation(float distance, float radius)
    {
        if (radius <= 0f)
        {
            return 0f;
        }

        var x = distance / radius;
        var factor = MathF.Max(0f, 1f - x * x);
        return factor * factor;
    }

    public static Vector3 EvaluateDirectional(
        Vector2 direction, Vector3 color, float intensity, Vector3 surfaceNormal)
    {
        // direção é "para onde a luz aponta"; L é o vetor superfície→luz
        var l = Vector3.Normalize(new Vector3(-direction.X, -direction.Y, 0.5f));
        var ndotl = MathF.Max(0f, Vector3.Dot(NormalizeNormal(surfaceNormal), l));
        return color * (intensity * ndotl);
    }

    public static Vector3 EvaluatePoint(
        Vector2 position, float height, float radius, Vector3 color, float intensity,
        Vector2 surface, Vector3 surfaceNormal)
    {
        var delta = new Vector3(position.X - surface.X, position.Y - surface.Y, height);
        var distance = delta.Length();
        if (distance <= 1e-6f)
        {
            return color * intensity; // luz exatamente sobre a superfície
        }

        var l = delta / distance;
        var ndotl = MathF.Max(0f, Vector3.Dot(NormalizeNormal(surfaceNormal), l));
        return color * (intensity * Attenuation(distance, radius) * ndotl);
    }

    public static Vector3 EvaluateSpot(
        Vector2 position, float height, float radius, Vector2 coneDirection,
        float innerConeCos, float outerConeCos, Vector3 color, float intensity,
        Vector2 surface, Vector3 surfaceNormal)
    {
        var baseLight = EvaluatePoint(position, height, radius, color, intensity, surface, surfaceNormal);

        var toSurface = new Vector2(surface.X - position.X, surface.Y - position.Y);
        if (toSurface.LengthSquared() <= 1e-12f)
        {
            return baseLight; // no ápice do cone
        }

        var cosAngle = Vector2.Dot(Vector2.Normalize(toSurface), coneDirection);
        var denom = MathF.Max(1e-6f, innerConeCos - outerConeCos);
        var cone = Math.Clamp((cosAngle - outerConeCos) / denom, 0f, 1f);
        return baseLight * (cone * cone); // borda quadrática suave
    }

    private static Vector3 NormalizeNormal(Vector3 normal) =>
        normal.LengthSquared() > 1e-12f ? Vector3.Normalize(normal) : new Vector3(0f, 0f, 1f);
}
