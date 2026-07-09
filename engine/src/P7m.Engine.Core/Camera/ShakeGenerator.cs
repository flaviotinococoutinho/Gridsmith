using System.Numerics;

namespace P7m.Engine.Core.Camera;

/// <summary>
/// Gerador procedural de screen shake por frequências harmônicas.
///
/// O impulso entra como <b>trauma</b> ∈ [0,1] que decai linearmente; a
/// amplitude efetiva é trauma² (perceptualmente natural: impactos pequenos
/// quase não balançam, grandes dominam). O deslocamento é uma soma de
/// senóides com razões de frequência irracionais — transiente, aperiódico e
/// sem saltos, aplicado como perturbação na matriz de projeção ortográfica.
///
/// Determinístico por semente (fases derivadas por LCG) — mesmo seed produz
/// exatamente a mesma sequência, essencial para replays e testes. Struct sem
/// alocações — hot loop safe (Zero-GC).
/// </summary>
public struct ShakeGenerator
{
    // Razões irracionais entre harmônicos: o padrão nunca se repete visivelmente.
    private const float Ratio1 = 1.0f;
    private const float Ratio2 = 1.618034f; // φ
    private const float Ratio3 = 2.414214f; // 1+√2
    private const float SecondaryWeight = 0.45f;
    private const float TertiaryWeight = 0.21f;
    private const float Normalizer = 1f / (1f + SecondaryWeight + TertiaryWeight);

    private float _time;
    private float _trauma;
    private float _phaseX1, _phaseX2, _phaseX3;
    private float _phaseY1, _phaseY2, _phaseY3;
    private float _phaseR1, _phaseR2;

    public float BaseFrequencyHz { get; private set; }
    public float MaxOffset { get; private set; }
    public float MaxRotationRadians { get; private set; }
    public float TraumaDecayPerSecond { get; private set; }

    public float Trauma => _trauma;

    public ShakeGenerator(
        float baseFrequencyHz,
        float maxOffset,
        float maxRotationRadians,
        float traumaDecayPerSecond,
        uint seed)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(baseFrequencyHz, 0f);
        ArgumentOutOfRangeException.ThrowIfNegative(maxOffset);
        ArgumentOutOfRangeException.ThrowIfNegative(maxRotationRadians);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(traumaDecayPerSecond, 0f);

        BaseFrequencyHz = baseFrequencyHz;
        MaxOffset = maxOffset;
        MaxRotationRadians = maxRotationRadians;
        TraumaDecayPerSecond = traumaDecayPerSecond;

        _time = 0f;
        _trauma = 0f;

        // Fases determinísticas via LCG (Numerical Recipes).
        var state = seed;
        _phaseX1 = NextPhase(ref state);
        _phaseX2 = NextPhase(ref state);
        _phaseX3 = NextPhase(ref state);
        _phaseY1 = NextPhase(ref state);
        _phaseY2 = NextPhase(ref state);
        _phaseY3 = NextPhase(ref state);
        _phaseR1 = NextPhase(ref state);
        _phaseR2 = NextPhase(ref state);
    }

    private static float NextPhase(ref uint state)
    {
        state = state * 1664525u + 1013904223u;
        return (state >> 8) * (1f / 16777216f) * 2f * MathF.PI;
    }

    /// <summary>Acumula trauma (impacto, explosão, dano). Saturado em 1.</summary>
    public void AddTrauma(float amount)
    {
        _trauma = Math.Clamp(_trauma + amount, 0f, 1f);
    }

    public void Update(float deltaSeconds)
    {
        _time += deltaSeconds;
        _trauma = MathF.Max(0f, _trauma - TraumaDecayPerSecond * deltaSeconds);
    }

    /// <summary>Amplitude efetiva: trauma² (curva perceptual).</summary>
    public readonly float Amplitude => _trauma * _trauma;

    public readonly Vector2 Offset
    {
        get
        {
            if (_trauma <= 0f)
            {
                return Vector2.Zero;
            }

            var w = 2f * MathF.PI * BaseFrequencyHz;
            var t = _time;
            var x = MathF.Sin(w * Ratio1 * t + _phaseX1)
                    + SecondaryWeight * MathF.Sin(w * Ratio2 * t + _phaseX2)
                    + TertiaryWeight * MathF.Sin(w * Ratio3 * t + _phaseX3);
            var y = MathF.Sin(w * Ratio1 * t + _phaseY1)
                    + SecondaryWeight * MathF.Sin(w * Ratio2 * t + _phaseY2)
                    + TertiaryWeight * MathF.Sin(w * Ratio3 * t + _phaseY3);
            return new Vector2(x, y) * (Normalizer * MaxOffset * Amplitude);
        }
    }

    public readonly float RotationRadians
    {
        get
        {
            if (_trauma <= 0f)
            {
                return 0f;
            }

            var w = 2f * MathF.PI * BaseFrequencyHz;
            var r = MathF.Sin(w * Ratio1 * _time + _phaseR1)
                    + SecondaryWeight * MathF.Sin(w * Ratio2 * _time + _phaseR2);
            return r / (1f + SecondaryWeight) * MaxRotationRadians * Amplitude;
        }
    }
}
