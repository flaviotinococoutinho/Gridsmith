using System.Numerics;

namespace P7m.Engine.Core.Lighting;

public enum LightType : byte
{
    Directional = 0,
    Point = 1,
    Spot = 2,
}

/// <summary>Handle opaco para uma luz residente no store.</summary>
public readonly record struct LightHandle(int Slot)
{
    public static readonly LightHandle Invalid = new(-1);
    public bool IsValid => Slot >= 0;
}

/// <summary>Snapshot imutável de uma luz (leitura para inspeção/editor).</summary>
public readonly record struct LightData(
    LightType Type,
    Vector2 Position,
    float Height,
    Vector2 Direction,
    Vector3 Color,
    float Intensity,
    float Radius,
    float InnerConeCos,
    float OuterConeCos);

/// <summary>
/// Armazenamento Data-Oriented de luzes do pipeline deferred.
///
/// SoA pré-alocada no construtor; Add/Remove reciclam slots por free-list e
/// nenhuma alocação ocorre após a construção. O Light Pass da GPU consome os
/// arrays na ordem dos slots ativos — iteração linear, cache-friendly.
/// </summary>
public sealed class LightStore
{
    private readonly LightType[] _types;
    private readonly Vector2[] _positions;
    private readonly float[] _heights;
    private readonly Vector2[] _directions;
    private readonly Vector3[] _colors;
    private readonly float[] _intensities;
    private readonly float[] _radii;
    private readonly float[] _innerCos;
    private readonly float[] _outerCos;
    private readonly bool[] _active;

    private int _liveCount;

    public LightStore(int capacity = 256)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(capacity, 1);
        Capacity = capacity;
        _types = new LightType[capacity];
        _positions = new Vector2[capacity];
        _heights = new float[capacity];
        _directions = new Vector2[capacity];
        _colors = new Vector3[capacity];
        _intensities = new float[capacity];
        _radii = new float[capacity];
        _innerCos = new float[capacity];
        _outerCos = new float[capacity];
        _active = new bool[capacity];
    }

    public int Capacity { get; }
    public int LiveCount => _liveCount;

    public LightHandle Add(in LightData light)
    {
        var slot = -1;
        for (var i = 0; i < Capacity; i++)
        {
            if (!_active[i])
            {
                slot = i;
                break;
            }
        }

        if (slot < 0)
        {
            throw new InvalidOperationException(
                $"LightStore is full ({Capacity} slots); capacity is fixed at construction (Zero-GC policy)");
        }

        _types[slot] = light.Type;
        _positions[slot] = light.Position;
        _heights[slot] = light.Height;
        _directions[slot] = Normalize(light.Direction);
        _colors[slot] = light.Color;
        _intensities[slot] = light.Intensity;
        _radii[slot] = light.Radius;
        _innerCos[slot] = light.InnerConeCos;
        _outerCos[slot] = light.OuterConeCos;
        _active[slot] = true;
        _liveCount++;
        return new LightHandle(slot);
    }

    public void Update(LightHandle handle, in LightData light)
    {
        EnsureActive(handle);
        var slot = handle.Slot;
        _types[slot] = light.Type;
        _positions[slot] = light.Position;
        _heights[slot] = light.Height;
        _directions[slot] = Normalize(light.Direction);
        _colors[slot] = light.Color;
        _intensities[slot] = light.Intensity;
        _radii[slot] = light.Radius;
        _innerCos[slot] = light.InnerConeCos;
        _outerCos[slot] = light.OuterConeCos;
    }

    public void Remove(LightHandle handle)
    {
        EnsureActive(handle);
        _active[handle.Slot] = false;
        _liveCount--;
    }

    public bool IsActive(LightHandle handle) =>
        handle.Slot >= 0 && handle.Slot < Capacity && _active[handle.Slot];

    public LightData Get(LightHandle handle)
    {
        EnsureActive(handle);
        var slot = handle.Slot;
        return new LightData(
            _types[slot], _positions[slot], _heights[slot], _directions[slot],
            _colors[slot], _intensities[slot], _radii[slot], _innerCos[slot], _outerCos[slot]);
    }

    /// <summary>
    /// Acumula a contribuição de todas as luzes ativas em uma superfície —
    /// a MESMA equação do Light Pass em HLSL (referência de CPU para testes e
    /// para o harness headless). Sem alocações: hot loop safe.
    /// </summary>
    public Vector3 Accumulate(Vector2 surface, Vector3 surfaceNormal)
    {
        var total = Vector3.Zero;
        for (var slot = 0; slot < Capacity; slot++)
        {
            if (!_active[slot])
            {
                continue;
            }

            total += _types[slot] switch
            {
                LightType.Directional => Lighting2D.EvaluateDirectional(
                    _directions[slot], _colors[slot], _intensities[slot], surfaceNormal),
                LightType.Point => Lighting2D.EvaluatePoint(
                    _positions[slot], _heights[slot], _radii[slot], _colors[slot], _intensities[slot],
                    surface, surfaceNormal),
                LightType.Spot => Lighting2D.EvaluateSpot(
                    _positions[slot], _heights[slot], _radii[slot], _directions[slot],
                    _innerCos[slot], _outerCos[slot], _colors[slot], _intensities[slot],
                    surface, surfaceNormal),
                _ => Vector3.Zero,
            };
        }

        return total;
    }

    private void EnsureActive(LightHandle handle)
    {
        if (!IsActive(handle))
        {
            throw new InvalidOperationException($"Light handle (slot {handle.Slot}) is not active");
        }
    }

    private static Vector2 Normalize(Vector2 v) =>
        v.LengthSquared() > 1e-12f ? Vector2.Normalize(v) : new Vector2(0f, -1f);
}
