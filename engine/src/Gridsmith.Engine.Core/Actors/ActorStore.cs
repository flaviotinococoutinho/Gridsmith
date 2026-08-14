namespace Gridsmith.Engine.Core.Actors;

/// <summary>Handle opaco para um ator residente no store.</summary>
public readonly record struct ActorHandle(int Slot)
{
    public static readonly ActorHandle Invalid = new(-1);
    public bool IsValid => Slot >= 0;
}

/// <summary>
/// Armazenamento Data-Oriented de atores (ALPHA-0.1 P0.6 — spawn table).
///
/// O editor mantém entidades como modelo canônico; instâncias cuja definição
/// aponta um <c>archetypeId</c> materializam AQUI como atores vivos. O
/// <c>entityId</c> canônico é a referência estável editor↔runtime: seleção
/// cruzada, live edit e despawn incremental resolvem pelo mesmo id nos dois
/// lados.
///
/// Toda a memória é alocada no construtor (SoA, slots fixos). Nenhuma
/// alocação após a construção (política Zero-GC) — strings de id são as
/// referências recebidas no plano de controle, fora do hot path.
/// </summary>
public sealed class ActorStore
{
    private readonly int _maxActors;

    // ---- SoA ----
    private readonly string?[] _entityIds;
    private readonly string?[] _archetypeIds;
    private readonly float[] _positionsX;
    private readonly float[] _positionsY;
    private int _liveCount;

    public ActorStore(int maxActors = 256)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maxActors, 1);
        _maxActors = maxActors;
        _entityIds = new string?[maxActors];
        _archetypeIds = new string?[maxActors];
        _positionsX = new float[maxActors];
        _positionsY = new float[maxActors];
    }

    public int Capacity => _maxActors;
    public int LiveCount => _liveCount;

    /// <summary>Spawna um ator em um slot livre. Ids duplicados são rejeitados.</summary>
    public ActorHandle Spawn(string entityId, string archetypeId, float x, float y)
    {
        var free = -1;
        for (var slot = 0; slot < _maxActors; slot++)
        {
            if (string.Equals(_entityIds[slot], entityId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"Actor \"{entityId}\" is already spawned");
            }

            if (free < 0 && _entityIds[slot] is null)
            {
                free = slot;
            }
        }

        if (free < 0)
        {
            throw new InvalidOperationException(
                $"ActorStore is full ({_maxActors} slots); capacity is fixed at construction (Zero-GC policy)");
        }

        _entityIds[free] = entityId;
        _archetypeIds[free] = archetypeId;
        _positionsX[free] = x;
        _positionsY[free] = y;
        _liveCount++;
        return new ActorHandle(free);
    }

    /// <summary>Libera o slot (reutilizado pelo próximo Spawn).</summary>
    public void Despawn(ActorHandle handle)
    {
        if (!handle.IsValid || handle.Slot >= _maxActors || _entityIds[handle.Slot] is null)
        {
            throw new InvalidOperationException($"Actor handle (slot {handle.Slot}) is not active");
        }

        _entityIds[handle.Slot] = null;
        _archetypeIds[handle.Slot] = null;
        _liveCount--;
    }

    /// <summary>
    /// Remove todos os atores da sessão de projeto, preservando os buffers
    /// pré-alocados para a sessão seguinte.
    /// </summary>
    public void Reset()
    {
        Array.Clear(_entityIds, 0, _entityIds.Length);
        Array.Clear(_archetypeIds, 0, _archetypeIds.Length);
        Array.Clear(_positionsX, 0, _positionsX.Length);
        Array.Clear(_positionsY, 0, _positionsY.Length);
        _liveCount = 0;
    }

    public ActorHandle Find(string entityId)
    {
        for (var slot = 0; slot < _maxActors; slot++)
        {
            if (string.Equals(_entityIds[slot], entityId, StringComparison.Ordinal))
            {
                return new ActorHandle(slot);
            }
        }

        return ActorHandle.Invalid;
    }

    /// <summary>
    /// O slot está ocupado? É o que permite varrer a SoA sem alocar: o
    /// composer de frame percorre <see cref="Capacity"/> e pula os vazios, em
    /// vez de materializar uma lista de vivos a cada frame.
    /// </summary>
    public bool IsLive(ActorHandle handle) =>
        handle.IsValid && handle.Slot < _maxActors && _entityIds[handle.Slot] is not null;

    public string EntityId(ActorHandle handle) => _entityIds[handle.Slot]
        ?? throw new InvalidOperationException($"Actor handle (slot {handle.Slot}) is not active");

    public string ArchetypeId(ActorHandle handle) => _archetypeIds[handle.Slot]
        ?? throw new InvalidOperationException($"Actor handle (slot {handle.Slot}) is not active");

    public float PositionX(ActorHandle handle) => _positionsX[handle.Slot];
    public float PositionY(ActorHandle handle) => _positionsY[handle.Slot];

    /// <summary>Reposiciona um ator vivo (live edit / gameplay). Zero alocações.</summary>
    public void MoveTo(ActorHandle handle, float x, float y)
    {
        if (!handle.IsValid || handle.Slot >= _maxActors || _entityIds[handle.Slot] is null)
        {
            throw new InvalidOperationException($"Actor handle (slot {handle.Slot}) is not active");
        }

        _positionsX[handle.Slot] = x;
        _positionsY[handle.Slot] = y;
    }
}
