namespace P7m.Engine.Core.SharedMemory;

/// <summary>
/// Resolve o nome lógico do mapa (<c>sharedMemoryMapName</c>) para o arquivo
/// físico, com a mesma regra do escritor Node.js
/// (middleware/src/sharedmem/SharedMemoryPath.ts).
/// </summary>
public static class SharedMemoryPath
{
    public static string Resolve(string mapName)
    {
        var runtimeDir = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
        var baseDir = !string.IsNullOrEmpty(runtimeDir) && !OperatingSystem.IsWindows()
            ? runtimeDir
            : Path.GetTempPath();
        return Path.Combine(baseDir, $"{mapName}.mmap");
    }
}
