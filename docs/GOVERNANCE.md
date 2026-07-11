# Governança Arquitetural e Definition of Done

A arquitetura do P7M não depende de disciplina de revisão: **toda regra de
governança é uma asserção executável** (fitness function) que quebra o CI com
o arquivo infrator no erro. Este documento enumera as regras, aponta o teste
que as impõe e define o que "pronto" significa.

## 1. Regras arquiteturais e sua imposição

### Middleware (`middleware/test/architecture.test.ts`)

| Regra | Enunciado | Imposição |
|---|---|---|
| **R1** | SDK do MCP e `zod` são exclusivos de `mcp/` — fachadas finas, zero lógica de domínio | teste R1 |
| **R2** | O modelo canônico (`canonical/`) não conhece transporte (`ipc/`), MCP, adapters concretos nem planos de dados | teste R2 |
| **R3** | O coração do domínio (`BlueprintStore`) importa apenas validadores puros e o vocabulário de erros | teste R3 |
| **R4** | Perfis de runtime (`runtime/profiles/`) são dados declarativos — só importam o contrato `RuntimeProfile` | teste R4 |
| **R5** | Núcleos algorítmicos (`AutoTiler`, `AsepriteImporter`, `fnv1a`) não importam nada — portáveis a workers | teste R5 |
| **R6** | Sockets (`node:net`) só existem na borda de transporte (`ipc/`, `tools/`, composição) | teste R6 |
| **R7** | Adapters concretos (`MonoGameAdapter`) só são referenciados pela composição — domínio/canônico/gateway conhecem apenas o contrato `RuntimeAdapter` | teste R7 |
| **R8** | Todo `BlueprintCommand` é despachável pelas bordas (`COMMAND_KINDS` completo) | teste R8 |
| **R9** | Constantes de framing e limites casam com os contratos publicados | teste R9 |

### Engine (`engine/tests/.../ArchitectureTests.cs`)

| Regra | Enunciado | Imposição |
|---|---|---|
| **E1** | `Core` (DOD/Zero-GC) não depende de nenhuma outra camada P7m | teste E1 |
| **E2** | `Ipc` é plano de controle independente do domínio | teste E2 |
| **E3** | `Graphics` (MonoGame) só conhece `Core` | teste E3 |
| **E4** | `Runtime` (serviço headless) orquestra `Core`+`Ipc`, nunca `Graphics` — o host gráfico acopla por fora | teste E4 |
| **E5** | `Core` não referencia MonoGame | teste E5 |

### Frontend (`frontend/test/architecture.test.ts`)

| Regra | Enunciado | Imposição |
|---|---|---|
| **F1** | Núcleos do editor (`core/`) são puros: sem Electron, Node ou middleware | teste F1 |
| **F2** | O renderer nunca importa Electron/Node; `main/` só como type (contrato `window.p7m`) | teste F2 |
| **F3** | Electron só existe no processo `main/` | teste F3 |
| **F4** | O frontend nunca reimplementa framing de protocolo — peers vêm de `@p7m/middleware` | teste F4 |

### Regras semânticas (impostas por testes de comportamento)

| Regra | Imposição |
|---|---|
| **Zero-GC nos hot loops** (nenhuma alocação em `ComputeWorldPoses`, `TryReadStable`, câmera, luzes, skinning, tilemap) | testes `*_is_allocation_free` (`GC.GetAllocatedBytesForCurrentThread`) |
| **Determinismo por seed** (AutoTiler, shake, simulação de câmera) | testes de igualdade bit a bit com mesmo seed |
| **Contratos binários nunca divergem** (struct C# ↔ escritor Node) | offsets por reflexão + checksum FNV-1a cruzado nos e2e |
| **Shaders ≡ referências de CPU** | `Lighting2D`/`ColorLut`/`LinearBlendSkinning`/`BonePacker` testados; e2e valida por reimplementação TS independente |
| **Toda mutação passa pelo orquestrador** (filters → AST → actions → projeção) | R7 + testes do gateway/adapter; `EngineBridge` é diagnóstico |
| **Perfis publicados são imutáveis** | `RuntimeProfileRegistry.register` rejeita re-registro (testado) |
| **Fail-safe de experiência** (sem prova de suporte → recurso desabilitado com razão) | testes do `ExperienceGovernor`/`ExperienceGate` |

## 2. Definition of Done

### Status "Produto entregue" (5 dimensões)

Uma FUNCIONALIDADE (diferente de uma mudança de código) só é "Produto
entregue" quando as cinco dimensões aplicáveis estão completas:

1. **Core/modelo** — lógica pura testada;
2. **Gateway/API** — operável via gateway do editor e/ou MCP;
3. **Projeção no runtime** — efeito real na engine (ou skip com razão);
4. **Interface visual** — fluxo utilizável na aplicação, com vocabulário
   humano (nunca IDs internos) e affordance real;
5. **Jornada e2e validada por usuário** — parte de uma jornada de aceite
   executável sem terminal.

A matriz corrente vive em [`REQUIREMENTS.md`](REQUIREMENTS.md) §1; o plano
para fechar as colunas 4–5 é [`ALPHA-0.1.md`](ALPHA-0.1.md).

### DoD de uma mudança (qualquer camada)

1. **Testes primeiro no nível certo**: unidade para lógica, integração para
   bordas (canal real), e2e para promessas entre runtimes.
2. `npm test` (middleware e frontend) e `dotnet test` (engine) verdes,
   **incluindo os testes arquiteturais**.
3. Os quatro `scripts/verify-phase*.sh` verdes (regressão e2e completa).
4. Contratos afetados atualizados em `contracts/` (fonte única de verdade) e
   refletidos nos DOIS lados do fio.
5. Docs afetadas atualizadas (`README` do pacote + docs/ pertinentes).
6. Sem `TODO` silencioso: limitação conhecida vira razão explícita
   (`skipped`/`deferred`/`disable` com `reason`) ou item em
   [`OPPORTUNITIES.md`](OPPORTUNITIES.md).

### DoD específico por tipo de mudança

| Tipo | Exigências adicionais |
|---|---|
| **Método JSON-RPC novo** | Schema em `contracts/schemas/` + handler + teste RPC + linha na tabela do `contracts/README.md` |
| **Comando canônico novo** | Validação no `BlueprintStore` + `COMMAND_KINDS` + projeção no(s) adapter(s) (ou skip com razão) + reidratação + serialização (`BlueprintSerializer`) + broadcast — R8 pega o esquecimento da borda |
| **Subsistema de engine novo** | Manifesto (`engine/describe`) com limites reais + editor hints; perfil de runtime atualizado se governa recurso de UI |
| **Perfil de runtime** | Nova VERSÃO (imutabilidade) + regras com `reason` legível |
| **Shader** | Referência de CPU espelhada + teste; comentário de contrato nos dois arquivos |
| **Hot loop novo** | Teste de zero alocação |

### Estado atual validado contra o DoD (auditoria desta revisão)

| Item | Estado |
|---|---|
| Testes: 104 engine + 107 middleware + 44 frontend = **255** | ✅ verdes |
| Testes arquiteturais (18 regras) | ✅ criados nesta revisão |
| E2e fases 1–4 | ✅ verdes |
| Persistência de projeto (export/load com replay canônico) | ✅ **fechado nesta revisão** (`BlueprintSerializer`, `blueprint/query document`, `blueprint/load`) |
| Contratos ↔ implementação | ✅ auditados (R8/R9 + tabela contracts) |
| Lacunas conhecidas e aceitas | registradas em [`OPPORTUNITIES.md`](OPPORTUNITIES.md) com impacto/esforço |

## 3. Quality gates (CI)

| Gate | Job | Conteúdo |
|---|---|---|
| G1 | `middleware` | build + 107 testes (inclui R1–R9) |
| G2 | `engine` | build + 104 testes (inclui E1–E5, Zero-GC) |
| G3 | `frontend` | build + 44 testes (inclui F1–F4) |
| G4 | `e2e` | verify-phase1..4 com processos reais |

Um PR só é integrável com os quatro gates verdes. Não há gate manual: o que a
governança exige, um teste impõe.
