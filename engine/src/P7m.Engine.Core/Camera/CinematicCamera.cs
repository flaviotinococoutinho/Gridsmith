using System.Numerics;

namespace P7m.Engine.Core.Camera;

/// <summary>Parâmetros de configuração da câmera cinemática (contrato do editor).</summary>
public readonly record struct CameraConfig(
    float Frequency,
    float Damping,
    float Response,
    float AnticipationSeconds,
    float ShakeFrequencyHz,
    float ShakeMaxOffset,
    float ShakeMaxRotationRadians,
    float ShakeTraumaDecayPerSecond,
    uint ShakeSeed)
{
    public static CameraConfig Default => new(
        Frequency: 2f,
        Damping: 1f,
        Response: 0f,
        AnticipationSeconds: 0.25f,
        ShakeFrequencyHz: 18f,
        ShakeMaxOffset: 24f,
        ShakeMaxRotationRadians: 0.05f,
        ShakeTraumaDecayPerSecond: 1.2f,
        ShakeSeed: 1);
}

/// <summary>
/// Câmera cinemática 2D: rastreamento massa-mola-amortecedor com antecipação
/// preditiva (mira à frente do alvo pelo vetor velocidade) e camada de
/// impulso (screen shake) aplicada como perturbação transiente da matriz de
/// projeção ortográfica.
///
/// Struct-composta, sem alocações após a construção — <see cref="Update"/> e
/// <see cref="ComputeViewProjection"/> são hot loop safe (Zero-GC).
/// </summary>
public sealed class CinematicCamera
{
    private SecondOrderDynamics _dynamics;
    private ShakeGenerator _shake;
    private CameraConfig _config;

    public CinematicCamera(CameraConfig config, Vector2 initialPosition = default)
    {
        _config = config;
        _dynamics = new SecondOrderDynamics(config.Frequency, config.Damping, config.Response, initialPosition);
        _shake = new ShakeGenerator(
            config.ShakeFrequencyHz,
            config.ShakeMaxOffset,
            config.ShakeMaxRotationRadians,
            config.ShakeTraumaDecayPerSecond,
            config.ShakeSeed);
    }

    public CameraConfig Config => _config;
    public Vector2 Position => _dynamics.Position;
    public Vector2 Velocity => _dynamics.Velocity;
    public float Trauma => _shake.Trauma;
    public Vector2 ShakeOffset => _shake.Offset;
    public float ShakeRotation => _shake.RotationRadians;

    /// <summary>Reconfigura preservando o estado de movimento corrente.</summary>
    public void Reconfigure(CameraConfig config)
    {
        _config = config;
        _dynamics.Configure(config.Frequency, config.Damping, config.Response);
        _shake = new ShakeGenerator(
            config.ShakeFrequencyHz,
            config.ShakeMaxOffset,
            config.ShakeMaxRotationRadians,
            config.ShakeTraumaDecayPerSecond,
            config.ShakeSeed);
    }

    /// <summary>Corte de câmera: teleporta sem transiente.</summary>
    public void Snap(Vector2 position)
    {
        _dynamics.Snap(position);
    }

    public void AddTrauma(float amount)
    {
        _shake.AddTrauma(amount);
    }

    /// <summary>
    /// Avança um frame. A antecipação preditiva desloca o alvo percebido em
    /// <c>velocity × anticipation</c>: a câmera "olha para onde o ator vai",
    /// não para onde ele está.
    /// </summary>
    public void Update(float deltaSeconds, Vector2 targetPosition, Vector2 targetVelocity)
    {
        var anticipated = targetPosition + targetVelocity * _config.AnticipationSeconds;
        _dynamics.Update(deltaSeconds, anticipated, targetVelocity);
        _shake.Update(deltaSeconds);
    }

    /// <summary>
    /// Matriz view-projection ortográfica do frame: centrada na posição
    /// suavizada, com o deslocamento e a rotação do shake compostos ANTES da
    /// projeção (perturbação em espaço de mundo, como especificado).
    /// </summary>
    public Matrix4x4 ComputeViewProjection(float viewportWidth, float viewportHeight, float zoom = 1f)
    {
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(viewportWidth, 0f);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(viewportHeight, 0f);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(zoom, 0f);

        var center = _dynamics.Position + _shake.Offset;
        var view =
            Matrix4x4.CreateTranslation(-center.X, -center.Y, 0f) *
            Matrix4x4.CreateRotationZ(_shake.RotationRadians);
        var projection = Matrix4x4.CreateOrthographic(
            viewportWidth / zoom, viewportHeight / zoom, 0f, 1f);
        return view * projection;
    }
}
