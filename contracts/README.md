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
| `engine/describe` | middleware → engine | request | [`schemas/engine.describe.schema.json`](schemas/engine.describe.schema.json) |
| `mesh/inspect` | middleware → engine | request | [`schemas/mesh.inspect.schema.json`](schemas/mesh.inspect.schema.json) |
| `camera/configure`, `camera/shake`, `camera/simulate` | middleware → engine | request | [`schemas/camera.methods.schema.json`](schemas/camera.methods.schema.json) |
| `lighting/add`, `lighting/remove`, `lighting/inspect`, `lighting/evaluate` | middleware → engine | request | [`schemas/lighting.methods.schema.json`](schemas/lighting.methods.schema.json) |
| `tilemap/define`, `tilemap/inspect` | middleware → engine | request | [`schemas/level.methods.schema.json`](schemas/level.methods.schema.json) |

## Modelo canônico e governança

| Contrato | Esquema |
|---|---|
| Envelope de artefato versionável | [`schemas/artifact.envelope.schema.json`](schemas/artifact.envelope.schema.json) |
| Perfil versionado de runtime | [`schemas/runtime.profile.schema.json`](schemas/runtime.profile.schema.json) |

O desenho completo (comandos, eventos, hooks, filters, pipelines, adapters e
governança da experiência) está em [`../docs/CANONICAL-MODEL.md`](../docs/CANONICAL-MODEL.md).

## Plano de dados

O layout binário do memory-mapped file (header, seqlock, vertex layout, checksum)
está especificado em [`shared-memory-layout.md`](shared-memory-layout.md). Os offsets
de vértice publicados em `engine/describe` são derivados por reflexão das structs C# —
o escritor Node.js deve sempre usar o layout publicado, nunca offsets hardcoded.

## Versionamento

A versão do protocolo é `MAJOR.MINOR` e é negociada no `engine/handshake`:

- **MAJOR** diferente → conexão recusada (erro `-32001 PROTOCOL_MISMATCH`).
- **MINOR** diferente → aceita; campos desconhecidos são ignorados pelos dois lados.

Versão atual: **1.0** (constante `PROTOCOL_VERSION` em ambas as implementações).

## Códigos de erro de domínio

Ver [`schemas/error-codes.md`](schemas/error-codes.md).
