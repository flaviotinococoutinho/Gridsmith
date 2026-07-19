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
| `-32007` | `AUTHENTICATION_FAILED` | Token efêmero do editor ausente ou inválido no gateway legado |

Os códigos padrão do JSON-RPC 2.0 (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`)
mantêm a semântica da especificação.

## Taxonomia dos códigos de erro

```mermaid
mindmap
  root(("Codigos de erro P7M"))
    Reservados JSON-RPC 2.0
      c700["-32700 ParseError"]
        p700["JSON malformado no corpo"]
      c600["-32600 InvalidRequest"]
        p600["Envelope JSON-RPC invalido"]
      c601["-32601 MethodNotFound"]
        p601["Metodo RPC inexistente"]
      c602["-32602 InvalidParams"]
        p602["Parametros invalidos"]
      c603["-32603 InternalError"]
        p603["Falha interna do servidor"]
    Dominio P7M -32000 a -32007
      d000["-32000 EngineNotReady"]
        q000["Sem handshake ou reidratando"]
      d001["-32001 ProtocolMismatch"]
        q001["MAJOR do protocolo incompativel"]
      d002["-32002 UnknownSkeleton"]
        q002["skeletonId nao registrado"]
      d003["-32003 UnknownMesh"]
        q003["meshId nao registrado"]
      d004["-32004 SharedMemoryUnavailable"]
        q004["MMF nao pode ser aberto ou mapeado"]
      d005["-32005 InvalidBinaryLayout"]
        q005["stride ou vertexCount inconsistente"]
      d006["-32006 DuplicateId"]
        q006["id ja existente"]
      d007["-32007 AuthenticationFailed"]
        q007["token efemero ausente ou invalido"]
```

*Mostra a taxonomia dos códigos de erro separando os reservados do JSON-RPC 2.0 (`-327xx`/`-326xx`) dos de domínio P7M (`-32000..-32007`). Os códigos compartilhados com a engine permanecem idênticos em TypeScript e C#; `AuthenticationFailed` pertence ao gateway do editor no middleware.*

## Origem dos erros de sessão (`-32000` / `-32001`)

```mermaid
sequenceDiagram
  participant E as Engine (.NET)
  participant M as Middleware (Node)
  Note over M: listen no pipe / UDS
  E->>M: engine/handshake {protocolVersion, capabilities}
  alt MAJOR de protocolVersion diverge
    M-->>E: erro ProtocolMismatch -32001
  else MAJOR compativel (PROTOCOL_VERSION 1.0)
    M-->>E: {sessionId uuid v4, acceptedCapabilities}
    Note over M: emite session e adapter.rehydrateFrom(store)
  end
  opt comando enviado antes da engine pronta
    M->>E: skeleton/initialize (timeout 10s)
    E-->>M: erro EngineNotReady -32000
  end
```

*Mostra onde nascem os dois erros do ciclo de vida da conexão: `ProtocolMismatch -32001` na validação do MAJOR durante o handshake e `EngineNotReady -32000` quando um comando chega antes de a engine concluir handshake/reidratação.*
