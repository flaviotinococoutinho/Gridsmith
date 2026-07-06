# P7m.Engine

Serviço de engine 2D (.NET 8) do ecossistema P7M EaaS.

## Projetos

| Projeto | Papel |
|---|---|
| `src/P7m.Engine.Core` | Núcleo Data-Oriented: SoA pré-alocada, Zero-GC nos hot loops. `SkeletonStore` resolve poses hierárquicas em passada linear única e produz as matrizes de skinning consumidas pela GPU na Fase 3. |
| `src/P7m.Engine.Ipc` | Plano de controle: framing `uint32 LE + JSON-RPC 2.0`, transporte Named Pipe / Unix Socket e peer full-duplex (`JsonRpcConnection`), mais o canal tipado com handshake (`EngineChannel`). |
| `src/P7m.Engine.Runtime` | Host do serviço: conecta ao middleware com retry/backoff, materializa `skeleton/initialize` e `mesh/bind_shared_memory` no núcleo DOD. O host gráfico MonoGame (game loop, `GraphicsDevice`, shaders HLSL) acopla-se aqui na **Fase 3**. |
| `tests/P7m.Engine.Ipc.Tests` | xUnit: codec, peer em loopback, handlers do serviço e invariantes DOD (incluindo teste de **zero alocação** em `ComputeWorldPoses`). |

## Comandos

```bash
dotnet build
dotnet test
dotnet run --project src/P7m.Engine.Runtime -- --pipe p7m-engine            # modo serviço
dotnet run --project src/P7m.Engine.Runtime -- --pipe p7m-engine --self-test # prova de vida Fase 1
```

## Política Zero-GC

Dentro de `Update`/`Draw` (e de qualquer método marcado como hot-loop-safe, como
`SkeletonStore.ComputeWorldPoses`) é proibido:

- instanciar classes (`new` de tipo referência) ou closures;
- boxing/unboxing e `params object[]`;
- LINQ, `foreach` sobre interfaces e dispatch virtual em cadeia.

Toda a memória de entidades é pré-alocada na construção dos stores; capacidade
esgotada é um erro explícito, nunca um `List.Grow` silencioso. O teste
`ComputeWorldPoses_is_allocation_free` guarda essa invariante com
`GC.GetAllocatedBytesForCurrentThread()`.
