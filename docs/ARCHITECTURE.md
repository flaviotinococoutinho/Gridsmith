# Arquitetura do Ecossistema P7M EaaS

## Visão geral

```
┌────────────────────┐   Commands (CQRS)    ┌──────────────────────┐   JSON-RPC 2.0    ┌──────────────────────┐
│  Electron UI       │ ───────────────────► │  Middleware Node.js  │ ◄───────────────► │  Engine MonoGame     │
│  (WYSIWYG Editor)  │ ◄─────────────────── │  (MCP Server / AST)  │  Named Pipes /    │  (.NET 8, DOD,       │
│                    │   Projeções (Query)  │                      │  Unix Sockets     │   Zero-GC)           │
└────────────────────┘                      └──────────┬───────────┘                   └──────────┬───────────┘
                                                       │                                          │
                                                       └───────── Memory-Mapped File ────────────┘
                                                            (vértices, UVs, BoneWeights —
                                                             layout binário sequencial)
```

Duas vias de dados coexistem, cada uma otimizada para seu regime:

1. **Plano de controle (JSON-RPC 2.0):** mensagens pequenas e estruturadas — inicialização
   de esqueletos, binds de shared memory, comandos de câmera, transições de estado.
   Trafega por Named Pipes (Windows) ou Unix Domain Sockets (Linux/macOS).
2. **Plano de dados (Shared Memory):** blocos binários grandes e de alta frequência —
   malhas, pesos de ossos, quadros de animação. Trafega por Memory-Mapped Files com
   layout `LayoutKind.Sequential`, sem serialização JSON. O contrato binário (header,
   seqlock, layouts de vértice, checksum FNV-1a) está em
   [`../contracts/shared-memory-layout.md`](../contracts/shared-memory-layout.md).

## Descoberta de capacidades (proxy engine → editor)

A engine é a fonte de verdade do que ela sabe fazer. No método **`engine/describe`**
ela publica um manifesto com:

- **limites reais** de cada subsistema, extraídos das constantes do núcleo DOD
  (ex.: `maxBonesPerSkeleton`);
- **layouts binários de vértice** derivados por reflexão (`Marshal.OffsetOf`) das
  structs `LayoutKind.Sequential` — o escritor Node.js usa esses offsets, nunca
  valores hardcoded, e o teste e2e da Fase 2 confirma a igualdade byte a byte;
- **ganchos de edição visual** (`editor`): painel, gizmos, tipos de nó e propriedades
  editáveis (com tipo, faixa e default) que o editor Electron materializa;
- subsistemas **`planned`** com a fase do roteiro — a UI pode exibi-los como preview.

O middleware cacheia o manifesto no `CapabilityRegistry` a cada sessão e o projeta
como `editorConcepts()` para a UI e como as ferramentas MCP `engine_capabilities` e
`editor_concepts` para agentes de IA. Câmera, iluminação, níveis e atores já são
subsistemas `available` no manifesto — cada um ganhou seu painel/hints sem mudança de
contrato de descoberta.

## Framing do plano de controle

O JSON-RPC 2.0 é trafegado com **prefixo de tamanho** para ser binário-seguro e permitir
parsing incremental sem heurística de delimitadores:

```
┌──────────────────┬─────────────────────────────┐
│ uint32 LE        │ payload UTF-8 (JSON-RPC 2.0)│
│ (tamanho do body)│                             │
└──────────────────┴─────────────────────────────┘
```

- Tamanho máximo de frame: **16 MiB** (frames maiores encerram a conexão com erro de
  protocolo — dados em massa pertencem ao plano de dados, não ao de controle).
- O mesmo formato é usado nas duas direções; a conexão é **full-duplex e simétrica**:
  ambos os lados podem emitir *requests* (com `id`, aguardam resposta) e *notifications*
  (sem `id`, fire-and-forget).

## Ciclo de vida da conexão

1. O middleware sobe o endpoint (`\\.\pipe\<nome>` no Windows; socket em
   `$XDG_RUNTIME_DIR` ou `/tmp` nos demais) e aguarda conexões.
2. A engine conecta e envia o request **`engine/handshake`** com sua identidade,
   versão de protocolo e capacidades.
3. O middleware valida a versão de protocolo (major deve coincidir) e responde com a
   identidade da sessão e as capacidades habilitadas.
4. A partir daí o canal é simétrico:
   - middleware → engine: `engine/ping`, `skeleton/initialize`, `mesh/bind_shared_memory`, …
   - engine → middleware: `engine/log` (notification), heartbeat periódico via
     `engine/ping` com payload `"heartbeat"`, respostas aos requests recebidos.
5. Desconexões são detectadas por EOF/erro de socket; requests pendentes são rejeitados
   imediatamente com erro de transporte. A engine reconecta com backoff exponencial.

## Convenções JSON-RPC

- Métodos usam namespaces com `/`: `engine/*`, `skeleton/*`, `mesh/*`, `camera/*`,
  `lighting/*`, `assets/*`.
- Erros seguem os códigos padrão do JSON-RPC 2.0 (`-32700` parse error, `-32600` invalid
  request, `-32601` method not found, `-32602` invalid params, `-32603` internal error) e
  a faixa `-32000..-32099` para erros de domínio do servidor (ver
  `contracts/schemas/error-codes.md`).
- Os esquemas dos métodos vivem em [`contracts/schemas/`](../contracts/schemas/) e são a
  **fonte única de verdade**; o middleware valida params contra eles na borda.

## Papel do MCP

O middleware expõe as capacidades do ecossistema a agentes de IA via **Model Context
Protocol** (transporte stdio). As ferramentas MCP são fachadas finas sobre o mesmo
barramento de comandos interno usado pelo canal JSON-RPC da engine — nenhuma lógica de
domínio vive na camada MCP.

## Estado declarativo (AST)

O middleware mantém o estado do projeto como uma árvore declarativa (Blueprint). Toda
mutação entra pelo barramento de comandos (CQRS): comandos imutáveis são validados,
aplicados ao AST e propagados como eventos para os assinantes (UI e engine). A engine é
tratada como uma *projeção materializada* do AST — reconectar significa reidratar.
