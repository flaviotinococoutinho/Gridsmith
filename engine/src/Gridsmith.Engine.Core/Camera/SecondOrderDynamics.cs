using System.Numerics;

namespace Gridsmith.Engine.Core.Camera;

/// <summary>
/// Integrador físico de segunda ordem (massa-mola-amortecedor) para
/// rastreamento cinético 2D, na parametrização intuitiva (f, ζ, r):
///
/// <list type="bullet">
///   <item><b>f</b> (Hz): frequência natural — velocidade da resposta;</item>
///   <item><b>ζ</b>: razão de amortecimento — ζ ≥ 1 não ultrapassa o alvo,
///     ζ &lt; 1 oscila com overshoot (câmera "elástica");</item>
///   <item><b>r</b>: resposta inicial — r &gt; 0 antecipa o movimento,
///     r &lt; 0 recua antes de seguir (efeito de inércia pesada).</item>
/// </list>
///
/// Semi-implícito com estabilização do passo (clamp de k2), estável para os
/// timesteps típicos de jogo (dt ≤ 1/30). Struct mutável sem alocações —
/// hot loop safe (Zero-GC).
/// </summary>
public struct SecondOrderDynamics
{
    private float _k1;
    private float _k2;
    private float _k3;

    private Vector2 _position;
    private Vector2 _velocity;
    private Vector2 _previousTarget;
    private bool _hasTarget;

    public Vector2 Position => _position;
    public Vector2 Velocity => _velocity;

    public float Frequency { get; private set; }
    public float Damping { get; private set; }
    public float Response { get; private set; }

    public SecondOrderDynamics(float frequency, float damping, float response, Vector2 initialPosition)
    {
        Frequency = 0;
        Damping = 0;
        Response = 0;
        _k1 = _k2 = _k3 = 0;
        _position = initialPosition;
        _velocity = Vector2.Zero;
        _previousTarget = initialPosition;
        _hasTarget = false;
        Configure(frequency, damping, response);
    }

    /// <summary>Reconfigura as constantes preservando posição e velocidade.</summary>
    public void Configure(float frequency, float damping, float response)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(frequency, 0f);
        ArgumentOutOfRangeException.ThrowIfNegative(damping);

        Frequency = frequency;
        Damping = damping;
        Response = response;

        var twoPiF = 2f * MathF.PI * frequency;
        _k1 = damping / (MathF.PI * frequency);
        _k2 = 1f / (twoPiF * twoPiF);
        _k3 = response * damping / twoPiF;
    }

    /// <summary>Teleporta sem transiente (corte de câmera).</summary>
    public void Snap(Vector2 position)
    {
        _position = position;
        _velocity = Vector2.Zero;
        _previousTarget = position;
        _hasTarget = false;
    }

    /// <summary>
    /// Avança a simulação. <paramref name="targetVelocity"/> pode ser derivada
    /// por diferenças finitas quando não fornecida explicitamente.
    /// </summary>
    public Vector2 Update(float deltaSeconds, Vector2 target)
    {
        var derived = _hasTarget && deltaSeconds > 0f
            ? (target - _previousTarget) / deltaSeconds
            : Vector2.Zero;
        return Update(deltaSeconds, target, derived);
    }

    public Vector2 Update(float deltaSeconds, Vector2 target, Vector2 targetVelocity)
    {
        if (deltaSeconds <= 0f)
        {
            return _position;
        }

        _previousTarget = target;
        _hasTarget = true;

        // Clamp de k2 garante estabilidade sem iterar (Euler semi-implícito).
        var k2Stable = MathF.Max(_k2, MathF.Max(deltaSeconds * deltaSeconds / 2f + deltaSeconds * _k1 / 2f, deltaSeconds * _k1));

        _position += deltaSeconds * _velocity;
        var acceleration = (target + _k3 * targetVelocity - _position - _k1 * _velocity) / k2Stable;
        _velocity += deltaSeconds * acceleration;
        return _position;
    }
}
