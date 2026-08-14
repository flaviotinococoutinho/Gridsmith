# Compatibilidade e Versionamento

Fonte de verdade única da **compatibilidade** do ecossistema Gridsmith. Cada eixo é
versionado de forma **independente** — **não** existe um número de versão único
para tudo. Este documento consolida o que antes estava disperso entre
[`ARCHITECTURE.md`](ARCHITECTURE.md), [`ARCHITECTURE-SPEC.md`](ARCHITECTURE-SPEC.md)
§19, [`CANONICAL-MODEL.md`](CANONICAL-MODEL.md) e
[`../contracts/shared-memory-layout.md`](../contracts/shared-memory-layout.md).

Cada linha abaixo é validada contra o código/contrato citado em **Fonte de verdade**.

```mermaid
graph TD
  subgraph AX["Eixos de versão independentes"]
    P["Protocolo JSON-RPC<br/>major.minor"]
    B["Documento Blueprint<br/>schemaVersion (int)"]
    A["Artefato<br/>schemaVersion + revision (int)"]
    R["Runtime profile<br/>familia + versao"]
    SM["Shared memory<br/>layoutVersion (int)"]
    V["Layout de vertice<br/>LayoutVersion (int)"]
    G["Contrato GraphQL do app<br/>SDL (arquivo unico)"]
    GR["Contrato gRPC do app<br/>package gridsmith.editor.v1"]
    PR["Produto / pacotes<br/>SemVer (0.1.0)"]
  end
  P -->|"nao compativel"| e1(["ProtocolMismatch -32001"])
  B -->|"versao antiga"| m1["migrateBlueprintDocument (encadeado)"]
  R -->|"sem versao <= pedida"| e2(["UnknownRuntimeError"])
  SM -->|"layout diverge"| e3(["InvalidBinaryLayout -32005"])
  V -->|"stride/offset diverge"| e3
  G -->|"dist diverge da fonte"| e4(["teste de paridade quebra o CI"])
  GR -->|"dist diverge da fonte"| e4
```

*Mostra os nove eixos de versão independentes do Gridsmith e o comportamento de incompatibilidade de cada um: cada eixo tem sua própria regra, fallback e teste — nunca um único SemVer global.*

## Matriz resumida

| Componente | Formato | Fonte de verdade | Compatibilidade | Fallback |
|---|---|---|---|---|
| Protocolo JSON-RPC | `major.minor` (string) | `middleware/src/protocol/jsonrpc.ts` · `engine/.../Protocol/JsonRpcProtocol.cs` | MAJOR deve coincidir | `ProtocolMismatch` (-32001) |
| Documento Blueprint | inteiro (`schemaVersion`) | `middleware/src/canonical/BlueprintSerializer.ts` | exato ou migrado | rejeita se > suportada |
| Artefato | inteiro (`schemaVersion`) + `revision` | `contracts/schemas/artifact.envelope.schema.json` · `ArtifactStore.ts` | revisões append-only; dedup `(contentHash, schemaVersion)` | — |
| Runtime profile | `família + versão` (`^\d+\.\d+(\.\d+)?$`) | `contracts/schemas/runtime.profile.schema.json` · `runtime/RuntimeProfile.ts` | exato ou maior `≤` pedida; imutável | `UnknownRuntimeError` |
| Adapter de runtime | — (sem constante própria) | `runtime/RuntimeAdapter.ts` · `MonoGameAdapter.ts` | governado pelos perfis (família+versão) | projeção `deferred`/`skipped` com razão; sessão `failed` é fail-closed |
| Shared memory | inteiro (`layoutVersion`) | `contracts/shared-memory-layout.md` · header MMF | binária estrita | `InvalidBinaryLayout` (-32005) |
| Layout de vértice | inteiro (`LayoutVersion`, stride 36) | `engine/.../SharedMemory/SkinnedVertex2D.cs` | offsets publicados por reflexão | `InvalidBinaryLayout` (-32005) |
| Contrato GraphQL do app | SDL (arquivo único) | `contracts/graphql/editor.schema.graphql` | evolução aditiva; cursor composto e snapshot completos | — (baseline e destino do fallback; ADR-016/019) |
| Contrato gRPC do app | package proto (`gridsmith.editor.v1`) | `contracts/grpc/gridsmith_editor.proto` | protobuf aditivo; `StreamEventsV2` preserva o legado | GraphQL somente em indisponibilidade (ADR-017/019) |
| Produto / pacotes | SemVer (`0.1.0`) | `*/package.json` · `EngineChannel.ClientVersion` | alpha; sem garantia de compat | — |

> **Não trate todos os componentes como SemVer.** Apenas os pacotes usam SemVer;
> o protocolo usa `major.minor` com checagem só de MAJOR; documento, artefato,
> shared memory e layout de vértice usam **inteiro monotônico**; o perfil de
> runtime usa `família + versão` com resolução descendente; os contratos do app
> usam SDL (aditivo) e package proto (`v1` → `v2` em breaking).

## Detalhamento por componente

### Versão do produto / pacotes

| Campo | Conteúdo |
|---|---|
| Componente | Pacotes `@gridsmith/middleware`, `frontend`, host da engine |
| Formato da versão | SemVer — hoje `0.1.0` (middleware, frontend) e `ClientVersion = "0.1.0"` (engine) |
| Fonte de verdade | `middleware/package.json`, `frontend/package.json`, `engine/src/Gridsmith.Engine.Ipc/EngineChannel.cs` |
| Regra de compatibilidade | Fase alpha — **não** há garantia de compatibilidade de produto; a interoperabilidade entre runtimes é regida pelo protocolo e pelos perfis, não pela versão de produto |
| Breaking change | n/a (alpha; não versionado como contrato) |
| Migração | n/a |
| Fallback | n/a |
| Teste | — (versões declaradas nos manifests; não há teste de compatibilidade de produto) |

### Protocolo JSON-RPC

| Campo | Conteúdo |
|---|---|
| Componente | Plano de controle (handshake + mensagens JSON-RPC 2.0) |
| Formato da versão | `major.minor` (string) — `PROTOCOL_VERSION = "1.0"` |
| Fonte de verdade | `middleware/src/protocol/jsonrpc.ts` · `engine/src/Gridsmith.Engine.Ipc/Protocol/JsonRpcProtocol.cs` (`ProtocolVersion`) — idênticos nos dois lados |
| Regra de compatibilidade | A versão **MAJOR** deve coincidir no `engine/handshake`; MINOR não bloqueia |
| Breaking change | Bump de MAJOR (mudança incompatível de mensagens/erros) |
| Migração | Nenhuma — renegociação exige atualizar os dois lados do fio |
| Fallback | `ProtocolMismatch` (-32001); a sessão é recusada no handshake |
| Teste | Testes de handshake (mismatch de MAJOR) + regra arquitetural **R9** (constantes de framing casam com o contrato) |

### Documento Blueprint (projeto `.gridsmith.json`)

| Campo | Conteúdo |
|---|---|
| Componente | Documento declarativo do projeto (`exportBlueprint` / load por replay) |
| Formato da versão | Inteiro — `BLUEPRINT_DOCUMENT_VERSION = 4`; documento sem `schemaVersion` é tratado como versão `0` |
| Fonte de verdade | `middleware/src/canonical/BlueprintSerializer.ts` |
| Regra de compatibilidade | Versão exata é carregada direto; versões anteriores são **migradas em cadeia** `v(n) → v(n+1)` antes do replay |
| Breaking change | Qualquer mudança estrutural do documento exige nova versão **+** entrada correspondente no registro `MIGRATIONS` |
| Migração | `migrateBlueprintDocument(raw)` + `MIGRATIONS` encadeado (`0 → 1 → 2 → 3 → 4`); v2 introduz `projectId`, derivado deterministicamente para v1; v3 introduz `metadata` (nome, resolução de referência e convenção espacial declarada) e converte coordenadas **apenas** nos quatro ramos descritos abaixo; v4 traz a paleta de significados para dentro do documento (era constante de build do editor), dando entradas default a todo nível que não tinha e nomeando deterministicamente os valores pintados fora dela; `project/openDocument` prepara e valida antes da troca; `expectedProjectSessionId` protege o commit contra candidato obsoleto |
| Fallback | Versão acima da suportada é **rejeitada** com `BlueprintDocumentError` (mensagem clara); versão sem migrador registrado é rejeitada |
| Teste | `middleware/test/blueprint-migration.test.ts` (um teste nomeado por ramo da 2 → 3 + round-trip do corpus) + `grid-coordinates.test.ts` + `project-session-manager.test.ts` (projectId v1 determinístico, replay isolado, rollback, CAS e troca A→B) |
| Nome do arquivo | **Leitura aceita `.gridsmith.json` E `.p7m.json`**; a escrita de um caminho NOVO (Novo / Salvar como) emite `.gridsmith.json`. Um projeto aberto como `.p7m.json` continua salvando nele — o rebrand não move o arquivo de ninguém. Fonte única: `frontend/src/core/projectExtensions.ts` (filtro do diálogo, roteamento de `argv` e nome sugerido saem daí) |

#### Os quatro ramos da migração 2 → 3

A v3 declara no arquivo o que antes era acordo tácito entre camadas: a unidade
de posição é o **pixel do mundo**, com origem da célula no canto superior
esquerdo, eixo Y para baixo e entidade ancorada no centro. Declarar isso
obrigou a resolver uma ambiguidade herdada — existem DOIS documentos v2 no
mundo, um com posições em célula (o template de plataforma antes da correção
de unidade) e outro em pixels.

Nenhuma heurística de magnitude resolve o caso: `3` é uma célula plausível e um
pixel plausível. A migração portanto **reconhece origens conhecidas por
impressão digital** do documento e não especula sobre o resto:

| Ramo | Documento | Coordenadas | `metadata.name` |
|---|---|---|---|
| (a) | template de plataforma **pré**-correção | convertidas para pixel | `Plataforma 2D` |
| (b) | template de plataforma **pós**-correção | intactas | `Plataforma 2D` |
| (c) | template top-down | intactas | `Aventura top-down` |
| (d) | **qualquer outro** documento | **intactas, bit a bit** | `Projeto importado` |

O ramo (d) cobre todo projeto real de usuário, edição manual e documento gerado
por agente — converter um deles às cegas destruiria o projeto.

> **A v4 altera a 2 → 3, e isso é deliberado.** A partir da v4 um documento que
> simula v2 pode carregar `palette`. Como a impressão digital compara o
> documento inteiro, sem remover a paleta antes do hash o template
> pré-correção deixaria de ser reconhecido e a conversão de coordenadas
> pararia de disparar **em silêncio**. Por isso o strip entra junto com a v4:
> antes dela seria código morto impossível de testar. Os shapes
reconhecidos são congelados em
`middleware/src/canonical/legacyBlueprintShapes.ts`, e o corpus de documentos
v2 reais vive em `middleware/test/fixtures/documents/`. **O corpus só cresce:**
cada bump acrescenta arquivos, nenhum arquivo existente é regenerado — eles são
a única prova de que documentos antigos ainda abrem.

### Envelope de eventos (gRPC)

| Campo | Conteúdo |
|---|---|
| Componente | `EventEnvelope` do `contracts/grpc/gridsmith_editor.proto` |
| Regra de compatibilidade | **Os campos 7, 8 e 9 são IMUTÁVEIS**: já foram publicados como `has_projection`/`projection_status`/`projection_reason`. Todo campo de histórico entra **a partir do 10** |
| Por quê | Em proto3 o número do campo É a identidade no fio. Reaproveitar 7/8/9 não seria conflito de texto: um build decodificaria um campo como o outro **em silêncio** |
| Teste | `middleware/test/envelope-compat.test.ts` — serializa com o proto novo e decodifica com o antigo (e vice-versa), mais uma verificação textual de que nenhum campo de histórico usa número abaixo de 10 |

### Artefato versionável

| Campo | Conteúdo |
|---|---|
| Componente | Envelope de artefato (ex.: `sprite-document`) no `ArtifactStore` |
| Formato da versão | Inteiro `schemaVersion` (`≥ 1`) + `revision` (inteiro monotônico a partir de 1) |
| Fonte de verdade | `contracts/schemas/artifact.envelope.schema.json` · `middleware/src/canonical/ArtifactStore.ts` |
| Regra de compatibilidade | Revisões são **append-only**; dedup por `(contentHash, schemaVersion)`; histórico preservado e legível |
| Breaking change | Bump de `schemaVersion` na mudança de forma do payload |
| Migração | Não há migrador formal — as revisões históricas continuam legíveis pela sua própria `schemaVersion` |
| Fallback | — |
| Teste | `middleware/test/canonical-core.test.ts` (revisão, hash estável, proveniência obrigatória, dedup) |

### Perfil de runtime

| Campo | Conteúdo |
|---|---|
| Componente | Perfil versionado de capacidades por família de runtime (`runtime/profiles/`) |
| Formato da versão | `família + versão`, versão em `major.minor[.patch]` (regex `^\d+\.\d+(\.\d+)?$`) |
| Fonte de verdade | `contracts/schemas/runtime.profile.schema.json` · `middleware/src/runtime/RuntimeProfile.ts` · `runtime/profiles/monogame.ts` |
| Regra de compatibilidade | `resolve(family, version)` = match exato; senão o **maior perfil `≤` versão pedida** (compatibilidade descendente); perfis publicados são **imutáveis** |
| Breaking change | Publicar qualquer mudança em um perfil = **nova versão** (nunca mutar um perfil publicado) |
| Migração | n/a — cada versão é um dado declarativo próprio |
| Fallback | `UnknownRuntimeError` (família desconhecida, ou nenhuma versão `≤` a pedida) |
| Teste | `middleware/test/runtime-governance.test.ts` (resolução exata/descendente, imutabilidade do registro) |

### Adapter de runtime

| Campo | Conteúdo |
|---|---|
| Componente | Tradutor de eventos canônicos → métodos do runtime (ex.: `MonoGameAdapter`) |
| Formato da versão | — (o adapter **não** carrega constante de versão própria) |
| Fonte de verdade | `middleware/src/runtime/RuntimeAdapter.ts` (contrato) · `middleware/src/runtime/MonoGameAdapter.ts` |
| Regra de compatibilidade | O adapter declara `family` e obtém a `version` do runtime vivo via `identify()` (handshake/manifesto); a compatibilidade efetiva é governada pelos **perfis** (família+versão) |
| Breaking change | n/a — o adapter acompanha os contratos JSON-RPC e os perfis; mudança incompatível recai sobre esses eixos |
| Migração | n/a |
| Fallback | Evento sem suporte no runtime → projeção `deferred`/`skipped` com **razão acionável**; compensação irrecuperável → sessão `failed`, sem aceitar mutações até recovery |
| Teste | `middleware/test/runtime-governance.test.ts` + `scripts/verify-phase4.sh` (projeção real na engine) |

### Layout de shared memory (MMF)

| Campo | Conteúdo |
|---|---|
| Componente | Header e região de dados do Memory-Mapped File (plano de dados) |
| Formato da versão | Inteiro `layoutVersion` (header MMF, offset 4) — atual `1` |
| Fonte de verdade | `contracts/shared-memory-layout.md` · header do MMF · engine |
| Regra de compatibilidade | **Binária estrita** — o `layoutVersion` e o `strideInBytes` do escritor devem coincidir com o que a engine mapeia |
| Breaking change | Qualquer mudança no header ou na struct de vértice bumpa `layoutVersion` |
| Rebrand (uma vez, pré-release) | O `magic` do header trocou de `0x4D4D3750` (ASCII `P7MM`) para `0x4D4D5347` (ASCII `GSMM`) junto com o rename do produto. É quebra binária deliberada e AUTOSSINALIZADA: um escritor antigo contra um leitor novo é recusado pelo próprio magic, sem ler um byte de vértice. Por isso o `layoutVersion` **não** foi bumpado — o header e a struct de vértice não mudaram |
| Migração | Nenhuma (dado binário; não há migração de layout em runtime) |
| Fallback | `InvalidBinaryLayout` (-32005) ao vincular a shared memory |
| Teste | `scripts/verify-phase2.sh` (checksum FNV-1a cruzado entre runtimes) + teste de reflexão (manifesto ≡ struct) |

### Layout de vértice

| Campo | Conteúdo |
|---|---|
| Componente | Struct `SkinnedVertex2D` publicada por reflexão em `engine/describe` |
| Formato da versão | Inteiro `LayoutVersion` (atual `1`), stride 36 bytes |
| Fonte de verdade | `engine/src/Gridsmith.Engine.Core/SharedMemory/SkinnedVertex2D.cs` (offsets via `Marshal.OffsetOf`) |
| Regra de compatibilidade | O escritor Node usa os **offsets publicados** pela engine, nunca valores hardcoded |
| Breaking change | Mudança de campo/ordem/tipo bumpa `LayoutVersion` |
| Migração | Nenhuma (binário) |
| Fallback | `InvalidBinaryLayout` (-32005) |
| Teste | `scripts/verify-phase2.sh` + teste de reflexão (offsets do manifesto ≡ `Marshal.OffsetOf`) |

### Contrato GraphQL do app (SDL)

| Campo | Conteúdo |
|---|---|
| Componente | Superfície baseline app ↔ middleware: `projectCreate/openDocument/close/status`, queries/mutations completas, `snapshot` e `eventBatch`; também destino do fallback (ADR-016/017/019/020) |
| Formato da versão | Sem constante própria — o SDL é o contrato, versionado como arquivo único no repositório |
| Fonte de verdade | `contracts/graphql/editor.schema.graphql` (o build do middleware copia para `dist/contracts/`; a cópia deve ser **byte-idêntica**) |
| Regra de compatibilidade | Evolução **aditiva** (campo/valor novo não quebra cliente); o enum `CommandKind` deve espelhar `COMMAND_KINDS` (mapeamento `_` ⇄ `/` — GraphQL não aceita `/` em enum) |
| Breaking change | Remover/renomear campo, tipo ou valor de enum — app e middleware são processos locais da mesma instalação e atualizam juntos |
| Migração | n/a (distribuição conjunta) |
| Continuidade | Cursor novo é `(middlewareInstanceId, projectSessionId, seq decimal uint64)`; `firstAvailableSeq`/`lastEventSeq` delimitam a partição ativa; restart, gap ou troca de projeto exigem reconstrução por `snapshot`. APIs sem identidade de sessão falham explicitamente. |
| Concorrência | `projectCreate` e `projectOpenDocument` validam `expectedProjectSessionId` no commit; `projectClose` aplica a mesma proteção. Divergência retorna `PROJECT_SESSION_CONFLICT`. |
| Autenticação | Bearer efêmero obrigatório. HTTP 401 é erro terminal e não aciona outro transport. |
| Fallback | — (o GraphQL **é** o baseline completo e o fallback do caminho quente) |
| Teste | Paridade `dist` ⇄ fonte + enum ⇄ `COMMAND_KINDS` em `middleware/test/transport-gateways.test.ts`; e2e `scripts/verify-transports.sh` |

### Contrato gRPC do app (proto)

| Campo | Conteúdo |
|---|---|
| Componente | App ↔ middleware — serviço `EditorHotPath` (`ProjectCreate`, `ProjectOpenDocument`, `ProjectClose`, `ProjectStatus`, `Dispatch`, `Query`, `Snapshot`, `StreamEventsV2`, `Health`; RPCs legados preservados) |
| Formato da versão | Package proto — `gridsmith.editor.v1` |
| Fonte de verdade | `contracts/grpc/gridsmith_editor.proto` (cópia em `dist/contracts/` gerada pelo build; byte-idêntica) |
| Regra de compatibilidade | Protobuf aditivo (campos novos com tags novas); os payloads de comando viajam como `payload_json` e são validados na **mesma fonte única** (`BlueprintStore` + `contracts/schemas/`) — o proto não introduz segunda fonte de validação |
| Breaking change | Mudança incompatível de mensagem/RPC = novo package (`gridsmith.editor.v2`) |
| Rebrand (uma vez, pré-release) | O prefixo do package passou de `p7m.editor.v1` para `gridsmith.editor.v1` junto com o rename do produto. É quebra de fio por definição — o caminho HTTP/2 do serviço muda —, absorvida porque as três camadas são distribuídas juntas e não há build publicado. O segmento de VERSÃO (`v1`) **não** foi bumpado: nenhum campo mudou de número ou de significado |
| Migração | n/a (distribuição conjunta) |
| Continuidade | `Health`/`Snapshot` expõem identidade e limites; `StreamEventsV2` envia um frame de status antes dos eventos. Restart/gap/cursor futuro/troca de sessão resultam em `resync_required` sem cauda parcial. `request_id` torna retry cross-transport idempotente. |
| Concorrência | Requests de create/open/close carregam `expected_project_session_id`; o servidor valida a identidade no commit atômico. |
| Autenticação | Metadata `authorization` com Bearer efêmero obrigatória. `UNAUTHENTICATED` nunca aciona fallback. |
| Fallback | **Somente indisponibilidade** do canal → GraphQL; autenticação, domínio e incompatibilidade de contrato não são cobertos por fallback. Default/freeze segue ADR-019. |
| Teste | Paridade `dist` ⇄ fonte em `middleware/test/transport-gateways.test.ts`; fallback ao vivo em `frontend/test/editor-client.integration.test.ts`; e2e `scripts/verify-transports.sh` |

### Rebrand P7M → Gridsmith (eixo fechado, uma vez, pré-release)

O produto foi renomeado antes de existir build publicado. Três identidades já
estão registradas no eixo a que pertencem (magic do MMF, package proto e sufixo
do documento); estas duas não têm eixo próprio e ficam aqui:

| Identidade | Antes | Depois | Efeito |
|---|---|---|---|
| Nome default do endpoint local | `p7m-engine` / `p7m-middleware` | `gridsmith-engine` / `gridsmith-middleware` | No POSIX muda o caminho do socket. **No Windows muda a PORTA**, porque ela é derivada por FNV-1a do nome do endpoint (`middleware/src/transport/endpoints.ts`) — um processo antigo e um novo não se encontram, que é o comportamento correto: são builds incompatíveis |
| Estado local do app (`userData`) | derivado do `name` do pacote npm | **fixo** em `Gridsmith` (`app.setName`) | Recentes e posição da janela recomeçam UMA vez. Nenhum dado de projeto se perde: o documento e os sidecars (`.bak`, `.autosave`) moram ao lado do arquivo do usuário, não no `userData`. O nome deixou de depender do escopo npm, então um rename de pacote não move mais o diretório em silêncio |

O layout de painéis do workbench **não** recomeça: a chave herdada
(`p7m.workbench.layout`) é lida como fallback, com precedência da nova
(`frontend/src/core/workbench/workbenchLayout.ts`, coberto por teste).

### Freeze do default (não é eixo de versão)

O baseline oficial de 2026-07-19 manteve gRPC como default de
dispatch/eventos: contra GraphQL, o p95 de dispatch foi 35,2% menor no payload
pequeno e 39,3% no médio; `event-flow` foi 30,8% e 16,5% menor,
respectivamente, sem erro, perda ou resync. Isso **não** implica vantagem em
queries: o p95 gRPC regrediu entre 16,6% e 251,8% nos quatro cenários de query.

O default só pode permanecer se dispatch conservar ganho p95 de pelo menos 20%
nos dois payloads, `event-flow` não regredir mais de 10% e os fluxos seguirem
sem erro/perda/resync. Falha rebaixa gRPC à feature flag até o PreviewHost.
GraphQL permanece baseline completo. O gateway JSON-RPC legado teve menor p50
e p95 nas oito combinações payload×operação, mas não em todo p99; permanece
somente compatibilidade enquanto houver dependentes e não participa de
promoção. Números, ambiente e tabela completa:
[ADR-019](adr/ADR-019-freeze-medido-dos-transports.md).
