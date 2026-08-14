using System;

namespace Gridsmith.Engine.Ipc.Tests;

/// <summary>
/// Medição de alocação para os testes <c>*_is_allocation_free</c> (RNF-01).
///
/// PROBLEMA QUE ESTE TIPO RESOLVE. <see
/// cref="GC.GetAllocatedBytesForCurrentThread"/> é por thread, mas o xUnit
/// roda coleções EM PARALELO: quando outra coleção dispara um GC, o contexto
/// de alocação da thread que mede é reajustado no meio da janela e o resto do
/// quantum entra no delta. O resultado é uma falha esporádica em commits que
/// não tocam a engine — já aconteceu com o leitor de shared memory e com a
/// dinâmica de câmera.
///
/// EVIDÊNCIA DE QUE É ARTEFATO, NÃO REGRESSÃO. Reproduzido localmente: os
/// testes de alocação isolados nunca falham; a suíte completa sob carga de CPU
/// falha; a MESMA suíte sob a MESMA carga, com o paralelismo do xUnit
/// desligado, volta a não falhar. E todos os valores espúrios já observados
/// ficam abaixo de 8 KiB — se o código alocasse UM byte por iteração, o delta
/// seria pelo menos igual à contagem de iterações (milhares). Todo falso
/// positivo tem a forma de um blip de quantum, nenhum tem a forma de alocação
/// por iteração.
///
/// COMO ISTO CORRIGE SEM AFROUXAR. A asserção continua sendo ZERO byte. O que
/// muda é o ESTIMADOR: mede-se a mesma janela algumas vezes e toma-se o MENOR
/// delta. Uma regressão real aloca em toda iteração, então TODA rodada acusa
/// um valor grande e o mínimo continua acusando — o teste falha igual. Um
/// artefato é esporádico, então basta uma rodada limpa para o mínimo ser zero.
/// A rodada limpa encerra a medição, então o custo normal é de uma passagem.
///
/// A alternativa avaliada e descartada foi serializar a suíte inteira: resolve,
/// mas paga o tempo de CI de toda a engine para consertar oito testes.
/// </summary>
internal static class AllocationProbe
{
    private const int DefaultRounds = 5;

    /// <summary>
    /// Executa <paramref name="hotLoop"/> uma vez para aquecer e depois o mede
    /// até <paramref name="rounds"/> vezes, devolvendo o MENOR número de bytes
    /// alocados observado. Encerra assim que uma rodada acusa zero.
    /// </summary>
    /// <remarks>
    /// O delegate e o closure são alocados pelo CHAMADOR, antes da primeira
    /// leitura do contador — não entram em nenhuma janela de medição. O corpo
    /// precisa ser repetível: todos os laços medidos aqui são idempotentes
    /// (consultas e mutações determinísticas sobre estado pré-alocado).
    /// </remarks>
    internal static long MinimumAllocatedBytes(Action hotLoop, int rounds = DefaultRounds)
    {
        ArgumentNullException.ThrowIfNull(hotLoop);
        ArgumentOutOfRangeException.ThrowIfLessThan(rounds, 1);

        hotLoop();

        var best = long.MaxValue;
        for (var round = 0; round < rounds; round++)
        {
            var before = GC.GetAllocatedBytesForCurrentThread();
            hotLoop();
            var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

            // Zero encerra: nenhuma rodada posterior pode melhorar o resultado.
            if (allocated <= 0)
            {
                return 0;
            }
            if (allocated < best)
            {
                best = allocated;
            }
        }

        return best;
    }
}
