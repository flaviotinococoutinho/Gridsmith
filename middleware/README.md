# @p7m/middleware

Camada de orquestração do ecossistema P7M EaaS (Node.js ≥ 22, TypeScript).

## Responsabilidades

- **Endpoint IPC do plano de controle** (`src/ipc/`): aceita a conexão da engine via
  Named Pipe (Windows) ou Unix Domain Socket (Linux/macOS), com framing binário
  `uint32 LE + JSON-RPC 2.0` e peer full-duplex simétrico.
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
- **Fachada MCP** (`src/mcp/McpFacade.ts`): expõe `engine_status`, `engine_ping`,
  `skeleton_initialize`, `mesh_bind_shared_memory`, `mesh_inspect`,
  `engine_capabilities` e `editor_concepts` a agentes de IA via stdio.

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
