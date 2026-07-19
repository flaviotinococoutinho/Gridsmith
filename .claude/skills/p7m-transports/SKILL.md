---
name: p7m-transports
description: Trabalhar nos transports do app P7M (gRPC quente + GraphQL fallback) — evoluir contratos SDL/proto, superfície do editor, política de fallback e verbosidade, com o checklist de paridade que o CI impõe. Use ao mexer em contracts/graphql, contracts/grpc, middleware/src/{graphql,grpc,transport}, frontend/src/{core/transportRouter,main/transport,main/EditorClient}.
---

# Transports do app P7M (gRPC quente + GraphQL fallback)

Arquitetura: ADR-016/017/018 em `docs/adr/`. Política: gRPC PRIORITÁRIO no
caminho quente; falha DE TRANSPORTE → fallback IMEDIATO para GraphQL; recovery
por sondas Health com HISTERESE (2 boas consecutivas). Falha de DOMÍNIO nunca
muda o transporte.

## Mapa dos arquivos

| Papel | Arquivo |
|---|---|
| Contrato GraphQL (fonte) | `contracts/graphql/editor.schema.graphql` |
| Contrato gRPC (fonte) | `contracts/grpc/p7m_editor.proto` (`p7m.editor.v1`) |
| Superfície única (as 3 bordas delegam aqui) | `middleware/src/canonical/EditorSurface.ts` |
| Servidor GraphQL / gRPC | `middleware/src/graphql/GraphQlGateway.ts` · `middleware/src/grpc/GrpcGateway.ts` |
| Diário de eventos (seq) | `middleware/src/transport/EventJournal.ts` |
| Endpoints (UDS/porta derivada) | `middleware/src/transport/endpoints.ts` |
| Política de fallback (pura) | `frontend/src/core/transportRouter.ts` |
| Clientes | `frontend/src/main/transport/{GrpcTransport,GraphQlTransport}.ts` → `EditorClient.ts` |
| Verbosidade | `middleware/src/util/log.ts` · `frontend/src/core/logging.ts` (`P7M_VERBOSITY`) |

## Checklist para EVOLUIR a superfície do editor

1. Comando canônico novo? Primeiro o DoD canônico (`docs/GOVERNANCE.md`):
   `BlueprintStore` + `COMMAND_KINDS` + adapter + serialização.
2. Adicione o valor no enum `CommandKind` do SDL (com `_` no lugar de `/`) —
   o teste de paridade (`middleware/test/transport-gateways.test.ts`) quebra
   se esquecer.
3. Campo/RPC novo: edite SDL/proto em `contracts/` (NUNCA em `dist/`), rode
   `npm run build` no middleware (copy-contracts) e adicione resolver/handler
   delegando na `EditorSurface` — as bordas não validam conteúdo nem contêm
   domínio (regras R10/R11/R12 quebram o CI se violar).
4. Cliente: ajuste `EditorClient` (quente = `hotCall` gRPC→GraphQL; frio =
   `coldCall` GraphQL) e os testes de integração do frontend.
5. Rode: `cd middleware && npm test`, `cd frontend && npm test`,
   `./scripts/verify-transports.sh` (e2e das duas fases), `npm run docs:verify`.

## Armadilhas conhecidas

- Enum GraphQL não aceita `/`: `level/update` ⇄ `level_update`
  (`graphqlKindToCanonical` faz o mapeamento — troca só a PRIMEIRA `_`).
- Erros: use `JsonRpcError` na superfície; o GraphQL expõe em
  `extensions.code`, o gRPC em `details` com INVALID_ARGUMENT — o cliente
  normaliza. Não lance `Error` cru em borda.
- Streams gRPC: sempre trate `error` no cliente (CANCELLED em teardown).
- `EventJournal` tem janela (512): consumidor atrasado detecta gap com
  `canResumeFrom` e ressincroniza por query completa.
- Windows: sem named pipes no grpc-js — porta derivada determinística
  (`derivedPort`); documentada no proto.
- Verbosidade nos testes: injete `createLogger("x", { level: "silent" })`.
