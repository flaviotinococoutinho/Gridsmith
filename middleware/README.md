# @p7m/middleware

Camada de orquestração do ecossistema P7M EaaS (Node.js ≥ 22, TypeScript).

## Responsabilidades

O grafo de módulos abaixo mostra a **regra de dependência**: as fronteiras
(entrada/saída) dependem para **dentro**, em direção ao núcleo (`canonical` +
`domain`), que não conhece nenhum adaptador. As fitness functions **R1–R9**
(import-graph) impõem exatamente essas setas e proíbem ciclos ou dependências de
saída do núcleo.

```mermaid
graph TD
  subgraph OUT["Fronteiras (adaptadores de entrada/saida)"]
    MCP["mcp (McpFacade)"]
    IPC["ipc / EditorGateway"]
    ASSETS["assets (AssetPipelineService)"]
    SHM["sharedmem (MeshSharedMemoryWriter)"]
  end
  PROTO["protocol (framing uint32 LE + JSON-RPC 2.0)"]
  subgraph CORE["Nucleo (canonical + domain)"]
    DOM["domain (BlueprintStore, EngineBridge, CapabilityRegistry)"]
    CANON["canonical (Orchestrator, HookBus, ArtifactStore, PipelineRunner)"]
  end
  RT["runtime (RuntimeAdapter, MonoGameAdapter, profiles, ExperienceGovernor)"]
  LD["leveldesign (AutoTiler puro)"]

  MCP --> DOM
  IPC --> PROTO
  IPC --> DOM
  ASSETS --> CANON
  SHM --> PROTO
  DOM --> CANON
  RT --> CANON
  DOM --> RT
  LD --> CANON
```

*Mostra o grafo de dependência dos módulos: todas as setas apontam para dentro
(fronteiras → núcleo), a invariante que as fitness functions R1–R9 verificam.*

- **Modelo canônico** (`src/canonical/`): `CanonicalOrchestrator` (o único caminho de
  mutação: filters → AST → actions → projeção), `HookBus` (actions/filters com
  prioridade, inspecionável), `ArtifactStore` (artefatos versionáveis com hash estável
  e proveniência) e `PipelineRunner` (estágios como cadeias de filters).

  O caminho de mutação é único: `dispatch(command)` passa pela cadeia de filters
  (que **falham rápido** — um `throw` aborta a cadeia), aplica no store (validação
  + mutação + evento), dispara as actions (**isoladas** — um `throw` é capturado e
  não derruba as demais) e, havendo adapter, projeta o evento.

  ```mermaid
  graph TD
    A["dispatch(command)"] --> B["applyFilters('command:kind')"]
    B -->|"um throw aborta a cadeia"| Bx(["cadeia abortada (fail-fast)"])
    B --> C{"filter preservou o kind?"}
    C -->|"nao"| Cx(["erro: orquestrador exige kind"])
    C -->|"sim"| D["store.apply(filtered)"]
    D --> E["validacao + mutacao + evento"]
    E --> F["doAction('event:kind')"]
    F -->|"actions isoladas: throw capturado"| F
    F --> G{"ha adapter?"}
    G -->|"sim"| H["adapter.project(event)"]
    G -->|"nao"| I["sem projecao"]
    H --> J["doAction('projection:completed')"]
    I --> J
    J --> K(["{ event, projection }"])
  ```

  *Mostra a cadeia única dispatch→filters→store.apply→actions→projection e as
  políticas fail-fast (filters) x isolada (actions) do HookBus.*

- **Runtimes** (`src/runtime/`): `RuntimeAdapter` (contrato de projeção),
  `MonoGameAdapter`, `RuntimeProfileRegistry` (perfis versionados por família em
  `profiles/`) e `ExperienceGovernor` (matriz de decisões perfil × manifesto vivo).
  Ver [`../docs/CANONICAL-MODEL.md`](../docs/CANONICAL-MODEL.md).

- **Endpoint IPC do plano de controle** (`src/ipc/`): aceita a conexão da engine via
  Named Pipe (Windows) ou Unix Domain Socket (Linux/macOS), com framing binário
  `uint32 LE + JSON-RPC 2.0` e peer full-duplex simétrico.

  O middleware faz `listen` no pipe/UDS; a engine conecta e envia
  `engine/handshake`. O middleware valida **apenas o MAJOR** de
  `PROTOCOL_VERSION` (`1.0`), responde com um `sessionId` (uuid v4), emite o
  evento `session` e, a cada nova sessão, executa um welcome ping e chama
  `adapter.rehydrateFrom(store)`. O canal é full-duplex e simétrico; requests têm
  timeout de 10 s e um EOF rejeita as pendências.

  ```mermaid
  sequenceDiagram
    participant E as Engine (.NET)
    participant M as Middleware (Node)
    Note over M: listen no pipe / UDS
    E->>M: engine/handshake {clientName, protocolVersion, capabilities}
    alt MAJOR de protocolVersion diverge
      M-->>E: erro ProtocolMismatch -32001
    else MAJOR compativel (PROTOCOL_VERSION 1.0)
      M-->>E: {sessionId uuid v4, serverName p7m-middleware, acceptedCapabilities}
      Note over M: emite evento session
      M->>E: welcome ping
      M->>M: adapter.rehydrateFrom(store)
    end
    loop canal simetrico full-duplex
      M->>E: engine/ping, skeleton/initialize, camera/*, entity/*
      E-->>M: resposta (timeout 10s)
      E->>M: engine/log notification
      E->>M: engine/ping payload heartbeat
    end
    Note over E,M: EOF rejeita pendencias - engine reconecta backoff 2s 4s 8s
  ```

  *Mostra o handshake, a criação de sessão com rehidratação, o canal full-duplex
  e a reconexão com backoff exponencial.*

- **Gateway do editor** (`src/ipc/EditorGateway.ts`): endpoint `<pipe>-editor` para o
  Electron e clientes de edição — `blueprint/dispatch` (caminho canônico),
  `blueprint/query` (inclui `document`, o snapshot completo do projeto),
  `blueprint/load` (replay canônico de um documento salvo), `experience/resolve` e
  broadcast `blueprint/event` para todos os editores (coerência multi-janela).
- **Estado declarativo / AST** (`src/domain/BlueprintStore.ts`): CQRS — comandos
  imutáveis validados e aplicados ao blueprint; leituras são projeções congeladas.
- **Ponte da engine** (`src/domain/EngineBridge.ts`): propaga comandos do AST para a
  sessão ativa e **reidrata** a engine inteira a cada reconexão.
- **Registro de capacidades** (`src/domain/CapabilityRegistry.ts`): pede
  `engine/describe` a cada sessão e projeta o manifesto como conceitos de edição
  visual (`editorConcepts()`) — o proxy entre as possibilidades da engine e a UI.
- **Plano de dados** (`src/sharedmem/`): `MeshSharedMemoryWriter` publica vértices no
  memory-mapped file com protocolo seqlock, guiado pelo layout binário publicado pela
  engine (nunca offsets hardcoded).
- **Level design** (`src/leveldesign/AutoTiler.ts`): auto-tiling determinístico por
  regras de padrão (LDtk/Tiled) — função pura `(IntGrid, regras, seed) → tiles`,
  consumida pela engine via `tilemap/define`.
- **Assets** (`src/assets/`): `AsepriteImporter` normaliza o export CLI (frameTags →
  clipes, slices → pivô/9-slice); `AssetPipelineService` orquestra o catálogo
  taxonômico — watcher recursivo, export via CLI Aseprite, artefato canônico com tags
  por diretório e compile MGCB para `.xnb` (`ToolRunner` injetável; erros tipados;
  ativado com `--assets <dir>`).
- **Fachada MCP** (`src/mcp/McpFacade.ts`): expõe a agentes de IA, via stdio,
  o comando genérico `blueprint_command` (TODOS os kinds canônicos de
  `COMMAND_KINDS` — inclusive `level/update` e `entity/move`) + ferramentas
  curadas por domínio (`camera_*`, `light_*`, `level_define/update/remove`,
  `entitydef_define`, `entity_place/move/remove`, `world_*`), diagnóstico
  (`engine_status`, `engine_ping`, `mesh_inspect`, `engine_capabilities`,
  `editor_concepts`, `runtime_*`, `hooks_list`, `artifact_get`) e assets
  (`asset_*`, com `--assets <dir>`).

### Composition root (`index.ts`)

`index.ts` é a única raiz de composição: instancia cada colaborador e faz o
_wiring_ das dependências (que sempre apontam para dentro, conforme o grafo
acima). Nenhum módulo constrói suas próprias dependências — todas chegam prontas
por injeção a partir daqui.

```mermaid
graph TD
  IDX["index.ts (composition root)"]
  IDX --> STORE[("BlueprintStore")]
  IDX --> HOOKS["HookBus"]
  IDX --> ARTS[("ArtifactStore")]
  IDX --> ADPT["MonoGameAdapter"]
  IDX --> ORCH["CanonicalOrchestrator"]
  IDX --> IPC["IpcServer + EditorGateway"]
  IDX --> MCP["McpFacade (stdio)"]
  IDX --> ASSETS["AssetPipelineService"]

  ORCH --> STORE
  ORCH --> HOOKS
  ORCH --> ADPT
  IPC --> ORCH
  MCP --> ORCH
  ASSETS --> ARTS
```

*Mostra a raiz de composição `index.ts` montando os colaboradores e injetando
store, HookBus e adapter no orquestrador, que é então servido por IPC e MCP.*

## Comandos

```bash
npm install
npm run build     # tsc → dist/
npm test          # node:test — framing, peer, integração via socket real
npm start         # pipe server + MCP em stdio
npm run dev -- --pipe p7m-engine --no-mcp   # apenas o plano de controle
```

## Convenções

- stdout pertence ao transporte MCP; logs operacionais vão para **stderr**.
- Nenhuma lógica de domínio na camada MCP — apenas fachadas sobre o barramento
  de comandos.
- Contratos de fio em [`../contracts/schemas/`](../contracts/schemas/).
