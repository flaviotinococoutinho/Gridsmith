using System.Numerics;

namespace P7m.Engine.Core.Lighting;

/// <summary>
/// LUT 1D de correção cromática (gradient map sobre luminância) — referência
/// de CPU do passo de composição (Composite.fx). Permite paletas globais
/// dinâmicas (dia/noite, biomas) interpolando entre LUTs por um fator.
///
/// A tabela é pré-alocada e imutável após a construção; <see cref="Apply"/>
/// não aloca (Zero-GC).
/// </summary>
public sealed class ColorLut
{
    private readonly Vector3[] _table;

    public ColorLut(ReadOnlySpan<Vector3> stops, int resolution = 64)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(stops.Length, 2);
        ArgumentOutOfRangeException.ThrowIfLessThan(resolution, 2);

        _table = new Vector3[resolution];
        for (var i = 0; i < resolution; i++)
        {
            var t = i / (float)(resolution - 1);
            var scaled = t * (stops.Length - 1);
            var index = Math.Min((int)scaled, stops.Length - 2);
            _table[i] = Vector3.Lerp(stops[index], stops[index + 1], scaled - index);
        }
    }

    /// <summary>LUT identidade: preserva a imagem (útil como estado neutro).</summary>
    public static ColorLut Identity(int resolution = 64) =>
        new([new Vector3(0f), new Vector3(1f)], resolution);

    public int Resolution => _table.Length;

    /// <summary>Luminância perceptual (Rec. 709) — mesma constante do shader.</summary>
    public static float Luminance(Vector3 rgb) =>
        0.2126f * rgb.X + 0.7152f * rgb.Y + 0.0722f * rgb.Z;

    /// <summary>Amostra a LUT com interpolação linear.</summary>
    public Vector3 Sample(float t)
    {
        t = Math.Clamp(t, 0f, 1f);
        var scaled = t * (_table.Length - 1);
        var index = Math.Min((int)scaled, _table.Length - 2);
        return Vector3.Lerp(_table[index], _table[index + 1], scaled - index);
    }

    /// <summary>
    /// Correção final: mapeia a luminância da cor pela LUT e mistura com a
    /// original por <paramref name="strength"/> (0 = sem efeito, 1 = total).
    /// </summary>
    public Vector3 Apply(Vector3 rgb, float strength)
    {
        strength = Math.Clamp(strength, 0f, 1f);
        var graded = Sample(Luminance(rgb));
        return Vector3.Lerp(rgb, graded, strength);
    }
}
