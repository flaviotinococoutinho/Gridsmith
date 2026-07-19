# ADR-016 — GraphQL como superfície completa (baseline) do app

- **Status:** Accepted · **Data:** 2026-07-16
- **Código:** `middleware/src/graphql/GraphQlGateway.ts`, `frontend/src/main/transport/GraphQlTransport.ts`
- **Contrato:** [`contracts/graphql/editor.schema.graphql`](../../contracts/graphql/editor.schema.graphql)
- **Testes:** `middleware/test/transport-gateways.test.ts`, `frontend/test/editor-client.integration.test.ts`, `scripts/verify-transports.sh`

## Contexto

O contrato app (Electron) ↔ backend do app (middleware) era JSON-RPC sobre o
pipe `<nome>-editor`. A direção de produto pediu uma superfície declarativa e
tipada para o app, com um caminho quente separado (ADR-017). A superfície do
editor é request/response + eventos — o formato natural de GraphQL.

## Decisão

O app consome o middleware por **GraphQL** como superfície **completa**
(queries de projeção, mutações canônicas, experiência, templates, load) —
baseline sempre disponível e transporte de **fallback** do caminho quente.

- SDL versionado em `contracts/graphql/` (fonte de verdade; cópia em `dist/`
  com paridade imposta por teste).
- Servidor: `graphql-js` puro sobre `node:http` em **UDS** (POSIX) /
  `127.0.0.1` (Windows) — sem framework; fachada fina sobre a
  `EditorSurface` compartilhada (nenhuma lógica de domínio na borda; regras
  R10/R12).
- Enum `CommandKind` espelha `COMMAND_KINDS` (paridade por teste; R8
  preservada nas três bordas).
- Eventos por **polling incremental** `eventsSince(afterSeq)` sobre o
  `EventJournal` — streaming pertence ao gRPC.
- Erros de domínio carregam o código estável JSON-RPC em `extensions.code`.

## Alternativas

1. **Manter só JSON-RPC** — não atende a direção de produto; sem tipagem de
   esquema para o app crescer.
2. **Apollo/Yoga + subscriptions WS** — dependências e superfície muito
   maiores para um processo local; polling incremental cobre o fallback com
   1 dep (`graphql`).
3. **GraphQL como único transporte** — perderia o caminho quente por stream
   (ADR-017).

## Consequências

- O gateway JSON-RPC `<nome>-editor` **permanece** para tooling/drivers
  (verify-phase4) e clientes de edição externos; as três bordas delegam na
  MESMA `EditorSurface` — um único fluxo canônico (P-1).
- Novo eixo de compatibilidade (SDL) em
  [`../COMPATIBILITY.md`](../COMPATIBILITY.md).
- Riscos: drift SDL↔superfície (mitigado por teste de paridade byte a byte
  da cópia + enum ↔ `COMMAND_KINDS`).

## Critérios de revisão

Reavaliar se o app precisar de subscriptions verdadeiras no fallback (hoje o
polling de 500 ms atende) ou se um segundo cliente do app surgir fora do
Electron.
