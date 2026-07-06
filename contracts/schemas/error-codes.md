# Códigos de erro de domínio (`-32000..-32099`)

| Código | Nome | Significado |
|---|---|---|
| `-32000` | `ENGINE_NOT_READY` | A engine ainda não completou o handshake ou está reidratando |
| `-32001` | `PROTOCOL_MISMATCH` | Versão MAJOR do protocolo incompatível no handshake |
| `-32002` | `UNKNOWN_SKELETON` | `skeletonId` não registrado via `skeleton/initialize` |
| `-32003` | `UNKNOWN_MESH` | `meshId` não registrado |
| `-32004` | `SHARED_MEMORY_UNAVAILABLE` | Memory-mapped file não pôde ser aberto/mapeado |
| `-32005` | `INVALID_BINARY_LAYOUT` | `strideInBytes`/`vertexCount` inconsistentes com o mapa |
| `-32006` | `DUPLICATE_ID` | Tentativa de registrar um id já existente |

Os códigos padrão do JSON-RPC 2.0 (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`)
mantêm a semântica da especificação.
