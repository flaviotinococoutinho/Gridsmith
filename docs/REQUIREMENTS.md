# Requisitos — Funcionais, Não Funcionais e Técnicos

> **Modelo de status (revisado pós-diagnóstico de produto):** "entregue
> tecnicamente" não significa "entregue como produto". Cada funcionalidade é
> avaliada em **cinco dimensões** — uma funcionalidade só recebe o status
> **Produto** quando todas as dimensões necessárias estão completas e a
> jornada foi validada por usuário. O plano para fechar as lacunas é a
> milestone [`ALPHA-0.1.md`](ALPHA-0.1.md).

Legenda: ✅ completo · 🔶 parcial · ❌ ausente · — não se aplica.

## 1. Matriz funcional em 5 dimensões

| Funcionalidade | Core/modelo | Gateway/API | Projeção runtime | UI visual | Jornada e2e usuário | **Produto** |
|---|---|---|---|---|---|---|
| Rigging/FABRIK | ✅ | ✅ | 🔶 (skinning GPU; sem editor) | ❌ | ❌ | **Não entregue** |
| Timeline/curvas | ✅ | — | 🔶 | ❌ | ❌ | **Não entregue** |
| Máquina de estados | ✅ | — | ❌ | ❌ | ❌ | **Não entregue** |
| Níveis IntGrid + auto-tiling | ✅ | ✅ (define/update) | ✅ | 🔶 (canvas + publicar/reabrir; faltam ferramentas e placement) | ❌ | **Em fechamento** (P0.4) |
| World map | ✅ | ✅ query | ❌ streaming | ❌ | ❌ | **Parcial** |
| Entidades tipadas | ✅ | ✅ | ✅ spawn table (archetypeId → ator vivo; move ao vivo) | 🔶 placement/drag/remoção no canvas (falta inspector) | ❌ | **Em fechamento** (P0.6) |
| Pipeline Aseprite/MGCB | ✅ | ✅ MCP | ✅ compilação | ❌ | ❌ | **Parcial** |
| Câmera cinemática | ✅ | ✅ | ✅ | ❌ | ❌ | **Sem fluxo visual** |
| Iluminação deferred | ✅ | ✅ | ✅ | ❌ | ❌ | **Sem fluxo visual** |
| Save/load de projeto | ✅ | ✅ | — | 🔶 (client/preload expostos; sem diálogos) | ❌ | **Em fechamento** (P0.2) |
| Supervisão de processos | ✅ (máquina de estados testada) | — | — | 🔶 (wire real + chips de estado + restart; falta caminho empacotado) | ❌ | **Em fechamento** (P0.1↔P0.9) |
| Preview embutido | 🔶 fundação | ❌ | 🔶 fundação | ❌ | ❌ | **Requisito P0.5** |
| Undo/redo | ✅ IntGrid apenas | ❌ | — | ❌ | ❌ | **Incompleto** (P0.7) |
| Diagnósticos (problems) | ✅ razões existem | 🔶 | 🔶 | ❌ | ❌ | **P0.8** |
| Empacotamento/instalador | ❌ | — | — | ❌ | ❌ | **P0.9** |
| Operação por agentes (MCP) | ✅ | ✅ | ✅ | — | 🔶 | **Entregue para agentes** |

### Leitura executiva

A coluna Core está quase toda verde; as colunas UI e Jornada estão quase todas
vermelhas. **A prioridade não é adicionar subsistemas: é converter a fundação
em um fluxo vertical utilizável** (ver decisão de congelamento em
[`ALPHA-0.1.md`](ALPHA-0.1.md)).

## 2. Requisitos não funcionais (RNF)

| ID | Requisito | Alvo | Status | Verificação |
|---|---|---|---|---|
| RNF-01 | **Zero-GC nos hot loops** da engine | 0 bytes alocados em Update/Draw-path | ✅ | testes `*_is_allocation_free` (6 hot loops cobertos) |
| RNF-02 | **Determinismo** | mesma entrada+seed ⇒ mesmo resultado, entre runtimes | ✅ | checksums FNV-1a cruzados; trajetórias idênticas |
| RNF-03 | **Robustez de protocolo** | frame inválido/oversized nunca derruba o peer; erros tipados | ✅ | testes de framing/peer (parse error, teardown, timeout) |
| RNF-04 | **Offline-first** | mutações aceitas sem engine; reidratação completa na reconexão | ✅ | testes de rehydrate + deferred |
| RNF-05 | **Compatibilidade multiplataforma de IPC** | Named Pipes (Win) / UDS (POSIX) com a mesma semântica | ✅ | abstração testada; caveat Windows do MMF documentado no contrato |
| RNF-06 | **Evolutibilidade de contratos** | versão MAJOR negociada; schemas fonte-de-verdade; perfis imutáveis | ✅ | handshake test + R9 + registry test |
| RNF-07 | **Explicabilidade** | nenhum recurso desabilitado sem razão legível | ✅ | governor/gate tests (fail-safe com reason) |
| RNF-08 | **Segurança da borda** | execFile sem shell; renderer sem Node (contextIsolation); validação em toda borda RPC | ✅ | F2/F3 + ExecToolRunner + testes de params inválidos |
| RNF-09 | **Auditabilidade** | artefatos com revisão, hash estável e proveniência obrigatória | ✅ | canonical-core.test.ts |
| RNF-10 | **Limites explícitos** | capacidades fixas com erro claro (nunca crescimento silencioso) | ✅ | testes de capacidade cheia (skeleton/light/tilemap) |
| RNF-11 | Latência do plano de controle | < 5 ms por request local (informal) | 🔶 | observada nos e2e; sem benchmark automatizado |
| RNF-12 | Escala de mapa | > 64k células por streaming/chunks | ⬜ | Fase 5 (shared memory para tiles) |

## 3. Requisitos técnicos (RT)

| ID | Requisito | Status |
|---|---|---|
| RT-01 | Node.js ≥ 22, TypeScript strict (`exactOptionalPropertyTypes`) | ✅ |
| RT-02 | .NET 8, `LayoutKind.Sequential` para todo dado de fio binário | ✅ |
| RT-03 | MonoGame 3.8.2 (DesktopGL); shaders HLSL compilados via MGCB fora do CI headless (referências de CPU cobrem as equações) | ✅ (caveat documentado) |
| RT-04 | JSON-RPC 2.0 com framing `uint32 LE` (16 MiB máx) em todos os canais | ✅ |
| RT-05 | Fronteiras de camada impostas por testes arquiteturais (18 regras) | ✅ |
| RT-06 | CI: 4 gates (middleware, engine, frontend, e2e) | ✅ |
| RT-07 | Electron com contextIsolation; binário dispensável no CI (`ELECTRON_SKIP_BINARY_DOWNLOAD`) | ✅ |

## 4. Riscos técnicos ativos

| Risco | Mitigação atual | Fechamento |
|---|---|---|
| Coerência MMF no Windows (WriteFile × view mapeada) | documentado no contrato; e2e roda em Linux | binding nativo de mmap no Electron (OPP-05) |
| Shaders sem compilação no CI | referências de CPU testadas + contrato espelhado | job de CI com Wine/mgcb (OPP-09) |
| Sem benchmark de latência/throughput | e2e implícito | harness de performance na Fase 5 (OPP-08) |
