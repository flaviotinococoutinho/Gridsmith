# ADR-018 — Endpoints locais dos transports e controle de verbosidade

- **Status:** Accepted · **Data:** 2026-07-16
- **Código:** `middleware/src/transport/endpoints.ts`, `middleware/src/transport/auth.ts`, `middleware/src/ipc/UnixSocketLifecycle.ts`, `middleware/src/util/log.ts`, `frontend/src/core/logging.ts`
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

Porta derivada: FNV-1a do nome lógico em duas metades disjuntas da faixa
dinâmica 49152–65535 (GraphQL 49152–57343; gRPC 57344–65535). Assim os dois
transports da mesma instância não colidem por construção; colisão com outro
processo é erro operacional tipado. Todo bind TCP é restrito a `127.0.0.1`.

**Segurança local:** o main do Electron gera um token aleatório efêmero de
256 bits e o entrega somente ao processo filho e aos clientes. Execuções com
serviços externos usam exatamente uma fonte: `P7M_EDITOR_AUTH_TOKEN` ou
`P7M_EDITOR_AUTH_TOKEN_FILE`; arquivo POSIX deve ser regular, do usuário e sem
permissões de grupo/outros. GraphQL exige Bearer e gRPC exige metadata
`authorization`; o gateway JSON-RPC legado exige o mesmo segredo no handshake.
O valor nunca é hardcoded nem registrado.

Sockets POSIX são verificados como socket do usuário atual, recebem modo
`0600` antes da prontidão e só são removidos como órfãos depois de uma sonda
`ECONNREFUSED` com revalidação de inode. Um listener vivo, symlink, arquivo
comum ou socket de outro usuário nunca é apagado.

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
- Falha de autenticação é não recuperável e nunca provoca troca de transport.
- Colisão de porta com OUTRO software na metade dinâmica do Windows é possível,
  mas é detectada no bind e não pode ser confundida com prontidão.
