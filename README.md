# P7M — Ecossistema EaaS (Engine-as-a-Service) para Plataforma 2D

Ecossistema de desenvolvimento de jogos 2D baseado no conceito de **Engine-as-a-Service**,
composto por três macrocamadas independentes e altamente desacopladas:

| Camada | Diretório | Stack | Papel |
|---|---|---|---|
| **Frontend** | [`frontend/`](frontend/) | Electron + TypeScript | Ambiente visual WYSIWYG: blueprints, grafos de estado, rigs/bones, pipelines de iluminação e gestão taxonômica de assets |
| **Middleware** | [`middleware/`](middleware/) | Node.js + TypeScript (MCP Server) | Orquestração do estado declarativo (AST), interface com IA generativa, ganchos via MCP e JSON-RPC 2.0 |
| **Backend** | [`engine/`](engine/) | C# / .NET 8 + MonoGame | Motor determinístico de baixo nível, Data-Oriented Design, alocação Zero-GC, consumo via IPC e Shared Memory |
| **Contratos** | [`contracts/`](contracts/) | JSON Schema | Fonte única de verdade dos contratos JSON-RPC trafegados entre as camadas |

## Princípios arquiteturais

O P7M é uma ferramenta visual **fortemente orientada a domínio**: o usuário
edita um **modelo canônico próprio** (comandos → eventos, hooks/filters,
pipelines e artefatos versionáveis), que não depende de runtime. **Adapters**
projetam o modelo em runtimes concretos (MonoGame hoje), e a experiência
visual é **governada por perfis versionados de capacidades** por
família+versão de runtime — a ferramenta consulta o perfil e o manifesto vivo
da engine, nunca assume suporte. Desenho completo em
[`docs/CANONICAL-MODEL.md`](docs/CANONICAL-MODEL.md).

- **CQRS no editor (Electron):** leituras (projeções da árvore de nós) separadas de escritas
  (Commands imutáveis aplicados ao Blueprint centralizado).
- **Data-Oriented Design (MonoGame):** arrays contíguos de structs (SoA) nos hot loops;
  nenhuma alocação, boxing ou virtual dispatch dentro de `Update`/`Draw`.
- **Zero-GC:** toda a memória de entidades, partículas e vértices é pré-alocada na
  inicialização do serviço.
- **Transporte binário-seguro:** frames JSON-RPC com prefixo de tamanho (uint32 LE) sobre
  Named Pipes (Windows) ou Unix Domain Sockets (Linux/macOS); dados de malha em massa via
  Memory-Mapped Files com `LayoutKind.Sequential`.

## Roteiro de fases

- [x] **Fase 1 — Infraestrutura Core e IPC:** servidor MCP local em Node.js, canais de
  Named Pipes estáveis e fluxo JSON-RPC 2.0 bidirecional validado com o serviço de engine.
- [x] **Fase 2 — Alocação de Memória e Rigs (Shared Memory):** memory-mapped file
  escrito pelo Node.js e lido pela struct C# (`LayoutKind.Sequential`), com seqlock,
  checksum FNV-1a verificado entre os runtimes e **descoberta de capacidades**
  (`engine/describe`): a engine publica limites e layouts binários por reflexão e o
  middleware os projeta como conceitos de edição visual para o editor.
- [x] **Fase 3 — Motor Gráfico, Shaders e Câmera:** vertex shader HLSL de Linear Blend
  Skinning, pipeline de Deferred Shading 2D (MRT: G-Buffer albedo+normal, Light Pass
  aditivo, composição com Color LUT), câmera massa-mola-amortecedor de segunda ordem
  com antecipação preditiva e screen shake procedural. Cada shader tem uma **referência
  de CPU espelhada e testada** (`Lighting2D`, `ColorLut`, `LinearBlendSkinning`), e as
  equações são verificadas entre runtimes via `lighting/evaluate` e `camera/simulate`.
- [x] **Fase 3.5 — Pesquisa de editores e subsistema de níveis:** investigação de
  FlatRedBall, LDtk, Tiled, Gum, Ogmo 3 e Aseprite
  ([docs/RESEARCH-EDITOR-LANDSCAPE.md](docs/RESEARCH-EDITOR-LANDSCAPE.md)) e absorção
  dos melhores conceitos: **AutoTiler** determinístico (IntGrid + regras com wildcards,
  chance e variantes por seed), **definições de entidade com campos tipados** no
  Blueprint (int/float/bool/string/enum/point/color com faixas e defaults),
  **importador Aseprite** (frameTags → clipes com pingpong expandido, slices →
  pivô/9-slice) e **TilemapStore** DOD na engine com consolidação em buffer estático
  único (`tilemap/define`/`tilemap/inspect`, checksum determinístico entre runtimes).
- [x] **Fase 3.6 — Modelo canônico e governança de runtimes:** orquestração por
  comandos/eventos com **hooks e filters** extensíveis (`HookBus`), **pipelines** cujos
  estágios são cadeias de filters, **artefatos versionáveis** (revisões append-only,
  hash de conteúdo estável, dedup, proveniência obrigatória), **adapter MonoGame**
  projetando eventos canônicos no runtime (skipped/deferred com razão), **perfis
  versionados** por família+versão (`monogame@3.8.0`/`3.8.2`) e **ExperienceGovernor**
  cruzando perfil estático + manifesto vivo em uma matriz de decisões auto-explicativa.
  Ferramentas MCP: `blueprint_command`, `runtime_experience`, `runtime_profiles`,
  `artifact_get`, `hooks_list`.
- [ ] **Fase 4 — Frontend Electron UX:** grafos de máquinas de estado com semântica Gum
  (estado = conjunto nomeado de atribuições; transições interpolam com easing Bézier),
  editores de curvas, painel de níveis LDtk-like (pincel de IntGrid + preview de regras),
  world map, painel taxonômico de assets com watcher do CLI Aseprite + compile MGCB, e
  live edit de variáveis tunáveis via RPCs por subsistema.
- [ ] **Fase 5 — Automação de Testes e Sandbox (Harness):** ambiente headless no MonoGame
  para simulações em *physics slices* com asserções lógicas.

## Desenvolvimento

### Middleware (Node.js ≥ 22)

```bash
cd middleware
npm install
npm run build
npm test          # unitários + integração loopback
npm start         # inicia o pipe server + servidor MCP (stdio)
```

### Engine (.NET 8)

```bash
cd engine
dotnet build
dotnet test
dotnet run --project src/P7m.Engine.Runtime -- --pipe p7m-engine
```

### Validação ponta-a-ponta

```bash
./scripts/verify-phase1.sh   # plano de controle: handshake + JSON-RPC bidirecional
./scripts/verify-phase2.sh   # plano de dados: MMF + seqlock + checksum entre runtimes
./scripts/verify-phase3.sh   # câmera (física + determinismo) e equação de luz do shader
```

`verify-phase1` sobe o pipe server do middleware, conecta o host headless da engine e
valida o handshake e o tráfego JSON-RPC nas duas direções. `verify-phase2` inverte os
papéis: o driver Node.js escreve vértices no memory-mapped file usando o layout binário
**publicado pela própria engine** (`engine/describe`) e a engine devolve checksum e
amostras via `mesh/inspect` — compatibilidade byte a byte comprovada entre os runtimes.

## Documentação

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — visão geral das camadas, protocolo de
  framing e ciclo de vida da conexão.
- [`docs/RESEARCH-EDITOR-LANDSCAPE.md`](docs/RESEARCH-EDITOR-LANDSCAPE.md) — pesquisa das
  ferramentas de referência (LDtk, Tiled, Ogmo, Aseprite, FlatRedBall, Gum) e as decisões
  de integração adotadas.
- [`contracts/`](contracts/) — esquemas JSON Schema dos métodos JSON-RPC.
