# @p7m/middleware

Camada de orquestração do ecossistema P7M EaaS (Node.js ≥ 22, TypeScript).

## Responsabilidades

- **Modelo canônico** (`src/canonical/`): `CanonicalOrchestrator` (o único caminho de
  mutação: filters → AST → actions → projeção), `HookBus` (actions/filters com
  prioridade, inspecionável), `ArtifactStore` (artefatos versionáveis com hash estável
  e proveniência) e `PipelineRunner` (estágios como cadeias de filters).
- **Runtimes** (`src/runtime/`): `RuntimeAdapter` (contrato de projeção),
  `MonoGameAdapter`, `RuntimeProfileRegistry` (perfis versionados por família em
  `profiles/`) e `ExperienceGovernor` (matriz de decisões perfil × manifesto vivo).
  Ver [`../docs/CANONICAL-MODEL.md`](../docs/CANONICAL-MODEL.md).

- **Endpoint IPC do plano de controle** (`src/ipc/`): aceita a conexão da engine via
  Named Pipe (Windows) ou Unix Domain Socket (Linux/macOS), com framing binário
  `uint32 LE + JSON-RPC 2.0` e peer full-duplex simétrico.
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
