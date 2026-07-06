using System.Numerics;

namespace P7m.Engine.Core.Rigging;

/// <summary>Handle opaco para um esqueleto residente no store (índice de slot).</summary>
public readonly record struct SkeletonHandle(int Slot)
{
    public static readonly SkeletonHandle Invalid = new(-1);
    public bool IsValid => Slot >= 0;
}

/// <summary>
/// Armazenamento Data-Oriented de esqueletos 2D.
///
/// Toda a memória é pré-alocada no construtor como Structures-of-Arrays
/// (SoA) contíguas — parentIndices, inverseBind, localPose e worldPose são
/// arrays planos fatiados por slot. Nenhuma alocação, boxing ou dispatch
/// virtual acontece após a construção: <see cref="ComputeWorldPoses"/> é
/// seguro para o hot loop (Update/Draw) sob a política Zero-GC.
///
/// Invariante de topologia: os ossos de cada esqueleto são registrados em
/// ordem tal que todo pai aparece antes dos filhos (validado no registro),
/// permitindo resolver a pose mundial em uma única passada linear — o padrão
/// de acesso é sequencial e amigável ao cache L1/L2.
/// </summary>
public sealed class SkeletonStore
{
    public const int MaxBonesPerSkeleton = 256;

    private readonly int _maxSkeletons;

    // ---- SoA: fatias fixas de MaxBonesPerSkeleton por slot ----
    private readonly int[] _parentIndices;        // -1 = raiz
    private readonly Matrix3x2[] _inverseBind;    // espaço do modelo → espaço do osso (bind)
    private readonly Matrix3x2[] _localPose;      // pose local corrente (escrita pela animação)
    private readonly Matrix3x2[] _worldPose;      // resultado da resolução hierárquica
    private readonly Matrix3x2[] _skinning;       // worldPose * inverseBind — consumida pela GPU

    private readonly int[] _boneCounts;
    private readonly string?[] _skeletonIds;
    private int _liveCount;

    public SkeletonStore(int maxSkeletons = 64)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maxSkeletons, 1);
        _maxSkeletons = maxSkeletons;

        var totalBones = maxSkeletons * MaxBonesPerSkeleton;
        _parentIndices = new int[totalBones];
        _inverseBind = new Matrix3x2[totalBones];
        _localPose = new Matrix3x2[totalBones];
        _worldPose = new Matrix3x2[totalBones];
        _skinning = new Matrix3x2[totalBones];
        _boneCounts = new int[maxSkeletons];
        _skeletonIds = new string?[maxSkeletons];
    }

    public int Capacity => _maxSkeletons;
    public int LiveCount => _liveCount;

    /// <summary>
    /// Registra um esqueleto em um slot livre (fase de carga — fora do hot loop).
    /// <paramref name="parentIndices"/> deve ser topologicamente ordenado
    /// (pai antes do filho); a pose local inicia como identidade.
    /// </summary>
    public SkeletonHandle Register(
        string skeletonId,
        ReadOnlySpan<int> parentIndices,
        ReadOnlySpan<Matrix3x2> inverseBindMatrices)
    {
        if (parentIndices.Length == 0 || parentIndices.Length > MaxBonesPerSkeleton)
        {
            throw new ArgumentException(
                $"Bone count must be between 1 and {MaxBonesPerSkeleton}", nameof(parentIndices));
        }

        if (parentIndices.Length != inverseBindMatrices.Length)
        {
            throw new ArgumentException("parentIndices and inverseBindMatrices must have the same length");
        }

        for (var i = 0; i < parentIndices.Length; i++)
        {
            var parent = parentIndices[i];
            if (parent < -1 || parent >= i)
            {
                throw new ArgumentException(
                    $"Bone {i}: parent index {parent} violates topological order (must be -1 or < {i})");
            }
        }

        var slot = FindFreeSlot(skeletonId);
        var baseIndex = slot * MaxBonesPerSkeleton;

        parentIndices.CopyTo(_parentIndices.AsSpan(baseIndex, parentIndices.Length));
        inverseBindMatrices.CopyTo(_inverseBind.AsSpan(baseIndex, inverseBindMatrices.Length));
        _localPose.AsSpan(baseIndex, parentIndices.Length).Fill(Matrix3x2.Identity);

        _boneCounts[slot] = parentIndices.Length;
        _skeletonIds[slot] = skeletonId;
        _liveCount++;
        return new SkeletonHandle(slot);
    }

    public SkeletonHandle Find(string skeletonId)
    {
        for (var slot = 0; slot < _maxSkeletons; slot++)
        {
            if (string.Equals(_skeletonIds[slot], skeletonId, StringComparison.Ordinal))
            {
                return new SkeletonHandle(slot);
            }
        }

        return SkeletonHandle.Invalid;
    }

    public int BoneCount(SkeletonHandle handle) => _boneCounts[handle.Slot];

    /// <summary>Fatia mutável da pose local — escrita pelo sampler de animação (sem cópia).</summary>
    public Span<Matrix3x2> LocalPose(SkeletonHandle handle) =>
        _localPose.AsSpan(handle.Slot * MaxBonesPerSkeleton, _boneCounts[handle.Slot]);

    /// <summary>Fatia somente-leitura da pose mundial resolvida.</summary>
    public ReadOnlySpan<Matrix3x2> WorldPose(SkeletonHandle handle) =>
        _worldPose.AsSpan(handle.Slot * MaxBonesPerSkeleton, _boneCounts[handle.Slot]);

    /// <summary>
    /// Matrizes de skinning (worldPose * inverseBind) — o payload que a Fase 3
    /// sobe para o vertex shader de Linear Blend Skinning.
    /// </summary>
    public ReadOnlySpan<Matrix3x2> SkinningMatrices(SkeletonHandle handle) =>
        _skinning.AsSpan(handle.Slot * MaxBonesPerSkeleton, _boneCounts[handle.Slot]);

    /// <summary>
    /// Resolve a hierarquia: worldPose[i] = localPose[i] * worldPose[parent].
    /// Passada única, linear, sem alocações — hot loop safe.
    /// </summary>
    public void ComputeWorldPoses(SkeletonHandle handle)
    {
        var baseIndex = handle.Slot * MaxBonesPerSkeleton;
        var count = _boneCounts[handle.Slot];

        for (var i = 0; i < count; i++)
        {
            var parent = _parentIndices[baseIndex + i];
            _worldPose[baseIndex + i] = parent < 0
                ? _localPose[baseIndex + i]
                : _localPose[baseIndex + i] * _worldPose[baseIndex + parent];
            _skinning[baseIndex + i] = _inverseBind[baseIndex + i] * _worldPose[baseIndex + i];
        }
    }

    private int FindFreeSlot(string skeletonId)
    {
        var free = -1;
        for (var slot = 0; slot < _maxSkeletons; slot++)
        {
            if (string.Equals(_skeletonIds[slot], skeletonId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"Skeleton \"{skeletonId}\" is already registered");
            }

            if (free < 0 && _skeletonIds[slot] is null)
            {
                free = slot;
            }
        }

        return free >= 0
            ? free
            : throw new InvalidOperationException(
                $"SkeletonStore is full ({_maxSkeletons} slots); capacity is fixed at construction (Zero-GC policy)");
    }
}
