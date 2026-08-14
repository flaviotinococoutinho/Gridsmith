using System.Reflection;
using Gridsmith.Engine.Core.Rigging;
using Gridsmith.Engine.Graphics;
using Gridsmith.Engine.Ipc.Protocol;
using Gridsmith.Engine.Runtime;
using Xunit;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// TESTES ARQUITETURAIS da engine (fitness functions) — docs/GOVERNANCE.md.
/// As fronteiras entre camadas são asserções sobre as referências REAIS dos
/// assemblies: violar a governança quebra o CI, não uma revisão de código.
/// </summary>
public class ArchitectureTests
{
    private static string[] GridsmithReferencesOf(Assembly assembly) =>
        assembly.GetReferencedAssemblies()
            .Select(a => a.Name ?? "")
            .Where(name => name.StartsWith("Gridsmith.", StringComparison.Ordinal))
            .OrderBy(name => name)
            .ToArray();

    [Fact]
    public void E1_Core_nao_depende_de_nenhuma_outra_camada_Gridsmith()
    {
        // O núcleo DOD é a base: portável para qualquer host, sem IPC/gráficos.
        var core = typeof(SkeletonStore).Assembly;
        Assert.Empty(GridsmithReferencesOf(core));
    }

    [Fact]
    public void E2_Ipc_e_um_plano_de_controle_independente_do_dominio()
    {
        // O peer JSON-RPC não conhece o domínio: qualquer serviço pode usá-lo.
        var ipc = typeof(FrameCodec).Assembly;
        Assert.Empty(GridsmithReferencesOf(ipc));
    }

    [Fact]
    public void E3_Graphics_so_conhece_o_Core()
    {
        // A camada MonoGame consome os stores DOD; nunca o IPC nem o Runtime.
        var graphics = typeof(DeferredRenderer).Assembly;
        Assert.Equal(new[] { "Gridsmith.Engine.Core" }, GridsmithReferencesOf(graphics));
    }

    [Fact]
    public void E4_Runtime_orquestra_Core_e_Ipc_mas_nao_Graphics()
    {
        // O serviço headless não arrasta dependências gráficas (SDL/OpenGL):
        // o host MonoGame acopla por fora, nunca o contrário.
        var runtime = typeof(EngineService).Assembly;
        Assert.Equal(new[] { "Gridsmith.Engine.Core", "Gridsmith.Engine.Ipc" }, GridsmithReferencesOf(runtime));
    }

    [Fact]
    public void E5_Core_nao_referencia_MonoGame()
    {
        // Zero-GC e DOD não podem depender de tipos do framework gráfico.
        var core = typeof(SkeletonStore).Assembly;
        var monoGameRefs = core.GetReferencedAssemblies()
            .Where(a => (a.Name ?? "").Contains("MonoGame", StringComparison.OrdinalIgnoreCase));
        Assert.Empty(monoGameRefs);
    }
}
