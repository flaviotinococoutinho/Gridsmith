using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;

namespace P7m.Engine.Core.SharedMemory;

/// <summary>Header do memory-mapped file (contracts/shared-memory-layout.md).</summary>
[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct MeshBufferHeader
{
    public const uint ExpectedMagic = 0x4D4D3750; // "P7MM" em little-endian
    public const int HeaderBytes = 64;

    public uint Magic;
    public uint LayoutVersion;
    public uint VertexCount;
    public uint StrideInBytes;
    public uint Sequence;   // seqlock: ímpar = escrita em progresso
    public uint FrameIndex; // geração do último publish
}

/// <summary>Resultado de um snapshot estável.</summary>
public readonly record struct MeshSnapshot(uint FrameIndex, int VertexCount);

/// <summary>
/// Leitor do plano de dados: mapeia o arquivo publicado pelo escritor
/// Node.js/Electron e tira snapshots estáveis (seqlock) dos vértices para um
/// buffer pré-alocado na construção.
///
/// Zero-GC: após o construtor, <see cref="TryReadStable"/>,
/// <see cref="Vertices"/> e <see cref="ComputeChecksum"/> não alocam.
/// </summary>
public sealed unsafe class MeshSharedMemoryReader : IDisposable
{
    private readonly MemoryMappedFile _file;
    private readonly MemoryMappedViewAccessor _view;
    private readonly byte* _base;
    private readonly SkinnedVertex2D[] _snapshotBuffer;
    private readonly int _vertexCount;
    private readonly int _strideInBytes;
    private bool _disposed;

    public int VertexCount => _vertexCount;
    public int StrideInBytes => _strideInBytes;
    public long MappedBytes { get; }

    private MeshSharedMemoryReader(
        MemoryMappedFile file,
        MemoryMappedViewAccessor view,
        byte* basePointer,
        int vertexCount,
        int strideInBytes,
        long mappedBytes)
    {
        _file = file;
        _view = view;
        _base = basePointer;
        _vertexCount = vertexCount;
        _strideInBytes = strideInBytes;
        MappedBytes = mappedBytes;
        _snapshotBuffer = new SkinnedVertex2D[vertexCount]; // pré-alocação única
    }

    /// <summary>
    /// Abre e valida o mapa. Lança <see cref="SharedMemoryLayoutException"/>
    /// quando o header contradiz os params do bind (defesa contra drift de
    /// contrato) e <see cref="FileNotFoundException"/> se o escritor ainda não
    /// criou o arquivo.
    /// </summary>
    public static MeshSharedMemoryReader Open(string mapName, int expectedVertexCount, int expectedStride)
    {
        var path = SharedMemoryPath.Resolve(mapName);
        var expectedBytes = MeshBufferHeader.HeaderBytes + (long)expectedVertexCount * expectedStride;

        var file = MemoryMappedFile.CreateFromFile(
            path, FileMode.Open, mapName: null, capacity: 0, MemoryMappedFileAccess.Read);
        MemoryMappedViewAccessor? view = null;
        try
        {
            // Valida o header por uma view mínima ANTES de mapear o total:
            // um header que contradiz o bind produz erro de layout tipado,
            // não uma exceção de mapeamento fora dos limites do arquivo.
            using (var headerView = file.CreateViewAccessor(
                       0, MeshBufferHeader.HeaderBytes, MemoryMappedFileAccess.Read))
            {
                headerView.Read(0, out MeshBufferHeader header);
                Validate(header, expectedVertexCount, expectedStride, mapName);
            }

            view = file.CreateViewAccessor(0, expectedBytes, MemoryMappedFileAccess.Read);
            byte* basePointer = null;
            view.SafeMemoryMappedViewHandle.AcquirePointer(ref basePointer);

            return new MeshSharedMemoryReader(
                file, view, basePointer, expectedVertexCount, expectedStride, expectedBytes);
        }
        catch
        {
            view?.Dispose();
            file.Dispose();
            throw;
        }
    }

    /// <summary>
    /// Copia um snapshot estável dos vértices para o buffer pré-alocado usando
    /// o protocolo seqlock. Retorna <c>false</c> se não conseguiu um snapshot
    /// consistente em <paramref name="maxAttempts"/> tentativas (escritor em
    /// rajada contínua) — o chamador mantém o snapshot anterior.
    /// </summary>
    public bool TryReadStable(out MeshSnapshot snapshot, int maxAttempts = 16)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var sequencePtr = (uint*)(_base + 16);
        var framePtr = (uint*)(_base + 20);
        var data = _base + MeshBufferHeader.HeaderBytes;

        for (var attempt = 0; attempt < maxAttempts; attempt++)
        {
            var s1 = Volatile.Read(ref *sequencePtr);
            if ((s1 & 1) != 0)
            {
                continue; // escrita em progresso
            }

            var byteCount = _vertexCount * _strideInBytes;
            fixed (SkinnedVertex2D* dest = _snapshotBuffer)
            {
                Buffer.MemoryCopy(data, dest, byteCount, byteCount);
            }

            var frame = Volatile.Read(ref *framePtr);
            var s2 = Volatile.Read(ref *sequencePtr);
            if (s1 == s2)
            {
                snapshot = new MeshSnapshot(frame, _vertexCount);
                return true;
            }
        }

        snapshot = default;
        return false;
    }

    /// <summary>Vértices do último snapshot estável (buffer pré-alocado, sem cópia).</summary>
    public ReadOnlySpan<SkinnedVertex2D> Vertices => _snapshotBuffer;

    /// <summary>FNV-1a 32-bit sobre os bytes do último snapshot (contrato de verificação e2e).</summary>
    public uint ComputeChecksum()
    {
        var hash = 2166136261u;
        fixed (SkinnedVertex2D* ptr = _snapshotBuffer)
        {
            var bytes = (byte*)ptr;
            var count = _vertexCount * _strideInBytes;
            for (var i = 0; i < count; i++)
            {
                hash = (hash ^ bytes[i]) * 16777619u;
            }
        }

        return hash;
    }

    private static void Validate(
        in MeshBufferHeader header, int expectedVertexCount, int expectedStride, string mapName)
    {
        if (header.Magic != MeshBufferHeader.ExpectedMagic)
        {
            throw new SharedMemoryLayoutException(
                $"Map \"{mapName}\": bad magic 0x{header.Magic:X8} (expected 0x{MeshBufferHeader.ExpectedMagic:X8})");
        }

        if (header.LayoutVersion != SkinnedVertex2D.LayoutVersion)
        {
            throw new SharedMemoryLayoutException(
                $"Map \"{mapName}\": layoutVersion {header.LayoutVersion} (engine expects {SkinnedVertex2D.LayoutVersion})");
        }

        if (header.VertexCount != expectedVertexCount || header.StrideInBytes != expectedStride)
        {
            throw new SharedMemoryLayoutException(
                $"Map \"{mapName}\": header declares {header.VertexCount} vertices × {header.StrideInBytes} bytes, " +
                $"bind declared {expectedVertexCount} × {expectedStride}");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _view.SafeMemoryMappedViewHandle.ReleasePointer();
        _view.Dispose();
        _file.Dispose();
    }
}

/// <summary>Header/params inconsistentes — mapeia para o erro RPC INVALID_BINARY_LAYOUT.</summary>
public sealed class SharedMemoryLayoutException(string message) : IOException(message);
