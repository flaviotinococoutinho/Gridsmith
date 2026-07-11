# Requisitos — Funcionais, Não Funcionais e Técnicos

Status: ✅ entregue e verificado · 🔶 parcial (lacuna registrada) · ⬜ planejado.
Cada requisito aponta o mecanismo de verificação — requisito sem teste é
tratado como não entregue.

## 1. Requisitos funcionais (RF)

| ID | Requisito | Status | Verificação |
|---|---|---|---|
| RF-01 | Editar rigs esqueléticos com IK interativo (FABRIK) e publicá-los na engine | ✅ | testes FABRIK + `skeleton/define` e2e |
| RF-02 | Injetar malhas (vértices/UV/pesos) via shared memory binária | ✅ | verify-phase2 (checksum cruzado) |
| RF-03 | Câmera cinemática configurável com preview determinístico | ✅ | verify-phase3 + testes de física |
| RF-04 | Iluminação deferred (3 tipos de luz) com correção por LUT | ✅ | testes Lighting2D/ColorLut + e2e |
| RF-05 | Níveis por IntGrid + regras de auto-tiling determinísticas | ✅ | testes AutoTiler + verify-phase3/4 |
| RF-06 | World map com colocação validada e vizinhança navegável | ✅ | world-map.test.ts |
| RF-07 | Entidades com campos tipados definidos pelo usuário (schema → UI) | ✅ | entity-definitions.test.ts |
| RF-08 | Ingestão Aseprite (clipes por frame tags, pivôs por slices) + compile MGCB | ✅ | asset-pipeline.test.ts (runner injetável) |
| RF-09 | Estados visuais com interpolação e easing (semântica Gum) | ✅ | state-machine.test.ts |
| RF-10 | Multi-cliente de edição com coerência por broadcast | ✅ | editor-gateway.test.ts |
| RF-11 | Salvar/carregar projeto sem perdas (documento versionado) | ✅ | blueprint-serializer.test.ts |
| RF-12 | Operação por agentes (MCP) por todo o domínio | ✅ | ferramentas MCP sobre o orquestrador (R8) |
| RF-13 | Editores visuais de canvas (curvas/rigs/grafos) | 🔶 | modelos prontos e testados; camada de canvas/worker pendente |
| RF-14 | Live edit generalizado de variáveis tunáveis | 🔶 | padrão existe (`camera/configure`); generalização pendente |
| RF-15 | Harness headless com physics slices e asserções (Fase 5) | ⬜ | alicerces em `camera/simulate`/`lighting/evaluate`/`mesh/inspect` |

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
