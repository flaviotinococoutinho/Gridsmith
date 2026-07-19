# ADR-018 — Endpoints locais dos transports e controle de verbosidade

- **Status:** Accepted · **Data:** 2026-07-16
- **Código:** `middleware/src/transport/endpoints.ts`, `middleware/src/util/log.ts`, `frontend/src/core/logging.ts`
- **Testes:** `middleware/test/transport-core.test.ts`, `frontend/test/transport-router.test.ts`

## Contexto

Os transports do app (ADR-016/017) precisam de endereçamento local
determinístico multi-plataforma e de observabilidade com ruído controlável —
o processo do middleware reserva stdout para o MCP.

## Decisão

**Endpoints** (`resolveTransportEndpoint(pipe, transport)` — um único módulo,
consumido por middleware E frontend, zero convenção duplicada):

| Plataforma | GraphQL | gRPC |
|---|---|---|
| POSIX | UDS `$XDG_RUNTIME_DIR/<pipe>-graphql.sock` | UDS `unix:$XDG_RUNTIME_DIR/<pipe>-grpc.sock` |
| Windows | `127.0.0.1:<porta derivada>` | `127.0.0.1:<porta derivada>` |

Porta derivada: FNV-1a do `<pipe>-<transport>` na faixa dinâmica 49152–65535
— determinística, sem descoberta, transports nunca colidem entre si.

**Verbosidade** (`P7M_VERBOSITY` = `silent|error|warn|info|debug|trace`,
default `info`): loggers estruturados com escopo hierárquico
(`p7m:grpc`, `editor-client:graphql`), sink INJETÁVEL (testes capturam
linhas), emissão só até o nível ativo. Middleware escreve em stderr; o
frontend usa `console.error`. Transições de transporte sempre logam a RAZÃO
(`history` do router carrega a telemetria).

## Alternativas

1. **Porta efêmera + arquivo de descoberta** — mais partes móveis; a porta
   derivada é suficiente para processos locais e documentada no proto.
2. **Logger de terceiros (pino/winston)** — dependência e formato impostos;
   o núcleo puro com sink injetável atende testabilidade e é portável a
   workers (regras R5-like/F1).

## Consequências

- Testes de verbosidade fazem parte das suítes (níveis, escopo, formato).
- Colisão de porta com OUTRO software na faixa dinâmica do Windows é
  possível e diagnosticável (erro de bind claro); aceitável para dev local e
  revisável no empacotamento (P0.9).
