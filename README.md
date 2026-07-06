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
- [ ] **Fase 3 — Motor Gráfico, Shaders e Câmera:** vertex shader HLSL de Linear Blend
  Skinning, pipeline de Deferred Shading 2D (MRT) e integrador físico de segunda ordem.
- [ ] **Fase 4 — Frontend Electron UX:** grafos de nós para máquinas de estado, editores
  de curvas de Bézier e painel taxonômico de assets.
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
```

`verify-phase1` sobe o pipe server do middleware, conecta o host headless da engine e
valida o handshake e o tráfego JSON-RPC nas duas direções. `verify-phase2` inverte os
papéis: o driver Node.js escreve vértices no memory-mapped file usando o layout binário
**publicado pela própria engine** (`engine/describe`) e a engine devolve checksum e
amostras via `mesh/inspect` — compatibilidade byte a byte comprovada entre os runtimes.

## Documentação

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — visão geral das camadas, protocolo de
  framing e ciclo de vida da conexão.
- [`contracts/`](contracts/) — esquemas JSON Schema dos métodos JSON-RPC.
