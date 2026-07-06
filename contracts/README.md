# Contratos JSON-RPC 2.0

Fonte única de verdade dos métodos trafegados entre Middleware (Node.js) e Engine
(MonoGame) sobre Named Pipes / Unix Domain Sockets.

## Métodos

| Método | Direção | Tipo | Esquema |
|---|---|---|---|
| `engine/handshake` | engine → middleware | request | [`schemas/engine.handshake.schema.json`](schemas/engine.handshake.schema.json) |
| `engine/ping` | ambas | request | [`schemas/engine.ping.schema.json`](schemas/engine.ping.schema.json) |
| `engine/log` | engine → middleware | notification | [`schemas/engine.log.schema.json`](schemas/engine.log.schema.json) |
| `skeleton/initialize` | middleware → engine | request | [`schemas/skeleton.initialize.schema.json`](schemas/skeleton.initialize.schema.json) |
| `mesh/bind_shared_memory` | middleware → engine | request | [`schemas/mesh.bind_shared_memory.schema.json`](schemas/mesh.bind_shared_memory.schema.json) |

## Versionamento

A versão do protocolo é `MAJOR.MINOR` e é negociada no `engine/handshake`:

- **MAJOR** diferente → conexão recusada (erro `-32001 PROTOCOL_MISMATCH`).
- **MINOR** diferente → aceita; campos desconhecidos são ignorados pelos dois lados.

Versão atual: **1.0** (constante `PROTOCOL_VERSION` em ambas as implementações).

## Códigos de erro de domínio

Ver [`schemas/error-codes.md`](schemas/error-codes.md).
