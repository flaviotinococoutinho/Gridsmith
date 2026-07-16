# Modelo Canônico e Governança de Runtimes

O P7M é uma ferramenta visual de desenvolvimento de jogos **fortemente
orientada a domínio**: o que o usuário edita é um modelo canônico próprio,
independente de runtime. Runtimes concretos (MonoGame hoje; outros no futuro)
recebem **projeções** desse modelo através de adapters, e a experiência visual
é **governada** por perfis versionados de capacidades.

```mermaid
graph TD
  subgraph MC["Modelo Canonico"]
    CMD["Comando (BlueprintCommand)"] -->|"applyFilters"| STORE[("BlueprintStore (AST)")]
    STORE -->|"validacao + mutacao"| EV["Evento (BlueprintEvent)"]
    EV -->|"doAction"| HK["Hooks / Actions"]
    STORE --> QRY["Projecoes (Query)"]
    HK --> PIPE["Pipelines"]
    PIPE --> ART[("Artefatos versionados")]
  end
  EV -->|"projecao de eventos"| MGA["MonoGame Adapter"]
  EV -->|"projecao de eventos"| OTH["(futuro) outro adapter"]
  MGA ==>|"JSON-RPC / shared memory"| ENG(["engine MonoGame"])
```

*Mostra o modelo canonico como unica fonte de mutacao (comando -> store -> evento -> hooks/pipelines/artefatos) e o fan-out do evento para adapters de runtime, sendo o MonoGame o unico ligado hoje a engine por JSON-RPC e memoria compartilhada.*

## 1. O modelo canônico

### Comandos → Eventos (já existente, formalizado)

Toda mutação entra como um **Comando** imutável (`BlueprintCommand`), é
validada e aplicada ao `BlueprintStore` (AST), que emite um **Evento**
(`BlueprintEvent`). Nenhuma camada externa muta estado diretamente.

### Hooks e Filters (`canonical/HookBus.ts`)

Extensibilidade no estilo consolidado do WordPress, adaptado a comandos:

- **Filters** transformam valores em cadeia com prioridade:
  `applyFilters("command:light/add", comando)` permite que plugins/agentes
  ajustem um comando antes da aplicação (ex.: clamping de intensidade,
  injeção de metadados de proveniência).
- **Actions** notificam sem transformar: `doAction("event:lightAdded", evento)`
  aciona side-effects desacoplados (telemetria, watchers, invalidação de
  preview). Erros em um handler são isolados — nunca derrubam o dispatch.
- O barramento é **inspecionável** (`listHooks()`): um agente LLM pode
  descobrir todos os pontos de extensão em runtime.

```mermaid
graph TD
  REG["registro de hooks"] --> ORD["ordena: prioridade ascendente (default 10)<br/>desempate por ordem de registro"]
  ORD --> T{"tipo de hook?"}
  T -->|"filter"| F["applyFilters: transforma valor em cadeia"]
  F -->|"um throw aborta a cadeia (fail-fast)"| FX(["cadeia abortada"])
  F --> FR(["valor filtrado"])
  T -->|"action"| A["doAction: notifica side-effects"]
  A -->|"throw capturado e isolado"| A
  A --> AR(["demais handlers seguem"])
  ORD --> INS(["listHooks(): barramento inspecionavel"])
```

*Mostra o HookBus: hooks ordenados por prioridade ascendente com desempate por ordem de registro, filters que falham rapido (um throw aborta a cadeia) e actions isoladas (throw capturado nao derruba os demais), tudo inspecionavel por listHooks().*

### Orquestração (`canonical/CanonicalOrchestrator.ts`)

O caminho canônico de qualquer mutação:

```mermaid
graph TD
  A["dispatch(command)"] --> B["applyFilters('command:kind')"]
  B -->|"um throw aborta a cadeia"| Bx(["cadeia abortada (fail-fast)"])
  B --> C{"filter preservou o kind?"}
  C -->|"nao"| Cx(["erro: orquestrador exige kind"])
  C -->|"sim"| D["store.apply(filtered)"]
  D --> E["validacao + mutacao + evento"]
  E --> F["doAction('event:kind')"]
  F -->|"actions isoladas: throw capturado"| F
  F --> G{"ha adapter?"}
  G -->|"sim"| H["adapter.project(event)"]
  G -->|"nao"| I["sem projecao"]
  H --> J["doAction('projection:completed')"]
  I --> J
  J --> K(["{ event, projection }"])
```

*Mostra a cadeia unica de mutacao dispatch -> filters -> store.apply -> actions -> projection, com filters em fail-fast (um throw aborta a cadeia e o kind deve ser preservado) e actions isoladas (throw capturado nao derruba os demais).*

A projeção retorna `{ status: "projected" | "skipped" | "deferred", reason }` —
eventos que o runtime não suporta são **pulados com razão registrada**, nunca
erros silenciosos.

### Pipelines e Artefatos (`canonical/ArtifactStore.ts`, `canonical/Pipeline.ts`)

- **Artefato** é um envelope versionável e endereçável:
  `{ artifactId, kind, schemaVersion, revision, contentHash, payload, metadata }`.
  Revisões são append-only; payloads idênticos (hash estável com chaves
  ordenadas) não geram revisão nova (dedup). O histórico completo é
  consultável — diffável, auditável, LLM-friendly.
- **Pipeline** é uma sequência nomeada de estágios; cada estágio é uma cadeia
  de filters no HookBus (`pipeline:<id>:<estágio>`). O resultado é publicado
  como artefato com `createdBy` e as actions `pipeline:completed` notificam o
  ecossistema. Ex.: `aseprite-import` (parse → normalize → publish
  `sprite-document`).

```mermaid
graph TD
  IN["publish(payload, metadata)"] --> HASH["contentHash estavel<br/>(chaves ordenadas)"]
  HASH --> Q{"hash igual a ultima revisao?"}
  Q -->|"sim"| DEDUP(["dedup: nenhuma revisao nova"])
  Q -->|"nao"| NEW["append nova revisao<br/>(revision++, createdBy obrigatorio)"]
  NEW --> ST[("ArtifactStore<br/>(historico append-only)")]
  ST --> HIST(["historico diffavel / auditavel / LLM-friendly"])
```

*Mostra o ciclo de revisao do ArtifactStore: o payload gera um contentHash estavel por chaves ordenadas; hash igual ao da ultima revisao faz dedup (sem revisao nova), hash diferente faz append de uma revisao com proveniencia createdBy, formando um historico append-only.*

Contratos: [`contracts/schemas/artifact.envelope.schema.json`](../contracts/schemas/artifact.envelope.schema.json).

## 2. Adapters de runtime

Um **adapter** projeta eventos canônicos nas APIs de um runtime concreto
(`runtime/RuntimeAdapter.ts`). O modelo canônico não conhece MonoGame; o
`MonoGameAdapter` conhece os métodos JSON-RPC da engine e traduz:

| Evento canônico | Projeção MonoGame |
|---|---|
| `skeletonDefined` | `skeleton/initialize` |
| `meshBound` | `mesh/bind_shared_memory` |
| `cameraConfigured` | `camera/configure` |
| `lightAdded`/`lightRemoved` | `lighting/add`/`lighting/remove` (com remapeamento de ids) |
| `levelDefined`/`levelUpdated`/`levelRemoved` | **resolve o AutoTiler (IntGrid + regras → tiles, determinístico por seed)** e envia `tilemap/define`/`tilemap/remove`+`define`/`tilemap/remove` |
| `entityPlaced`/`entityMoved`/`entityRemoved` | spawn table (P0.6): com `archetypeId` na definição, `entity/spawn`/`entity/move`/`entity/despawn` — o `entityId` canônico é a referência estável editor↔runtime; move sem spawn prévio vira upsert; sem archetype, `skipped` com razão acionável |
| `entityDefDefined` | `skipped` (definições são editoriais; instâncias com archetype spawnam) |

```mermaid
graph LR
  subgraph EV["Eventos canonicos"]
    e1["skeletonDefined"]
    e2["meshBound"]
    e3["cameraConfigured"]
    e4["lightAdded / lightRemoved"]
    e5["levelDefined / levelUpdated / levelRemoved"]
    e6["entityPlaced / entityMoved / entityRemoved"]
    e7["entityDefDefined / world*"]
  end
  subgraph RPC["Metodos RPC na engine"]
    m1["skeleton/initialize"]
    m2["mesh/bind_shared_memory"]
    m3["camera/configure"]
    m4["lighting/add | lighting/remove"]
    m5["tilemap/define | tilemap/remove<br/>(auto-tiling determinístico por seed)"]
    m6["entity/spawn | entity/move | entity/despawn"]
  end
  SK(["ProjectionResult<br/>skipped (razao editorial)"])
  e1 --> m1
  e2 --> m2
  e3 --> m3
  e4 --> m4
  e5 --> m5
  e6 -->|"exige archetypeId / spawnado"| m6
  e6 -->|"sem archetypeId / nao spawnado"| SK
  e7 --> SK
```

*Mostra o mapeamento evento canonico -> metodo RPC do MonoGameAdapter, com os casos condicionais (entity precisa de archetypeId/spawn previo; levelUpdated vira remove+define) e os eventos editoriais que terminam em ProjectionResult skipped.*

Adapters declaram `family` (grupo tecnológico) e obtêm a versão concreta do
handshake/describe do runtime vivo. O adapter também é o **único dono da
reidratação**: em cada sessão nova, `rehydrateFrom(store)` projeta o Blueprint
inteiro na ordem de dependência (esqueletos → malhas → câmera → luzes →
níveis → entidades). O `EngineBridge` ficou restrito a diagnósticos (ping, inspeções,
simulação de câmera) — toda mutação passa pelo orquestrador.

## 3. Perfis versionados e governança da experiência

### RuntimeProfile (`runtime/RuntimeProfile.ts`)

Cada **família** de runtime tem perfis **por versão** — dados declarativos e
versionáveis no repositório (`runtime/profiles/`):

```jsonc
{
  "family": "monogame",
  "version": "3.8.2",
  "capabilities": ["content-pipeline.mgcb", "render.spritebatch", ...],
  "editorRules": [
    { "feature": "assets.mgcb-compile", "effect": "enable", "requiresCapability": "content-pipeline.mgcb", ... },
    { "feature": "preview.embedded", "effect": "enable", "requiresSubsystem": "level", ... }
  ],
  "constraints": { "maxTextureSize": 4096 }
}
```

A resolução é `resolve(family, versão)`: match exato, senão o perfil mais alto
`≤` versão pedida (compatibilidade descendente), senão erro tipado.

```mermaid
graph TD
  A["resolve(family, version)"] --> B{"match exato?"}
  B -->|"sim"| R(["perfil resolvido"])
  B -->|"nao"| C{"existe versao <= pedida?"}
  C -->|"sim"| D["seleciona maior versao <= pedida<br/>(compat descendente, compareVersions numerico)"]
  D --> R
  C -->|"nao"| E(["UnknownRuntimeError"])
```

*Mostra a cascata de resolucao de perfil: match exato, senao a maior versao menor ou igual a pedida (compatibilidade descendente), senao UnknownRuntimeError. Perfis sao imutaveis por versao (re-registro rejeitado).*

Contrato: [`contracts/schemas/runtime.profile.schema.json`](../contracts/schemas/runtime.profile.schema.json).

### ExperienceGovernor (`runtime/ExperienceGovernor.ts`)

A governança cruza **três fontes** para decidir cada recurso da ferramenta
visual:

1. **Perfil estático** (família+versão): o que essa combinação suporta em tese;
2. **Manifesto vivo** (`engine/describe`): o que a instância conectada REALMENTE
   expõe (subsistemas `available` vs `planned`);
3. **Regras** do perfil: exigências (`requiresCapability`,
   `requiresSubsystem`) e desabilitações explícitas.

O resultado é uma matriz de decisões auto-explicativa:

```json
{ "feature": "assets.mgcb-compile", "enabled": true,
  "reason": "capability content-pipeline.mgcb present in monogame 3.8.2" }
```

```mermaid
graph TD
  A["ExperienceGovernor.decide(rule)"] --> B{"effect == disable?"}
  B -->|"sim"| D1(["desabilitado (source: profile-rule)"])
  B -->|"nao"| C{"requiresCapability ausente do perfil?"}
  C -->|"sim"| D1
  C -->|"nao"| E{"requiresSubsystem?"}
  E -->|"nao"| OK(["habilitado"])
  E -->|"sim"| F{"subsystem == available no manifesto?"}
  F -->|"nao / sem engine"| D2(["desabilitado (source: live-manifest, FAIL-SAFE)"])
  F -->|"sim"| OK
```

*Mostra a arvore de decisao do ExperienceGovernor cruzando perfil estatico e manifesto vivo, e a origem (source) de cada FeatureDecision: effect=disable e requiresCapability ausente => profile-rule; requiresSubsystem nao available (ou sem engine) => live-manifest com fail-safe.*

A UI da Fase 4 consome essa matriz para habilitar/desabilitar painéis, gizmos
e ações — **nunca** assume que um recurso existe. Agentes consultam a mesma
matriz via MCP (`runtime_experience`).

## 4. MCP/LLM-friendliness

- **Tudo é schema**: comandos, eventos, artefatos, perfis e manifesto têm
  JSON Schema em `contracts/`.
- **Tudo é inspecionável**: `listHooks()`, histórico de artefatos, matriz de
  decisões com razões, `editorConcepts()`.
- **Tudo é dispatchável**: a ferramenta MCP `blueprint_command` aceita
  qualquer comando canônico — um agente cria entidades, luzes e câmera pelo
  MESMO caminho validado da UI (filters aplicados, eventos emitidos,
  projeção no runtime).
- **Proveniência**: artefatos carregam `metadata.createdBy` — humano, agente
  ou pipeline — para auditoria da geração assistida.

## 4.5 Persistência do projeto

O Blueprint é salvável como **documento declarativo versionado**
(`BlueprintSerializer`): `exportBlueprint` produz um snapshot completo
(`schemaVersion` + todos os domínios) e o load **reproduz o documento como
comandos** pelo orquestrador, em ordem de dependência — mesma validação,
mesmos hooks, mesma projeção de uma edição manual. Carregar exige Blueprint
vazio ("novo projeto" é estado explícito), e o roundtrip é sem perdas
(testado por igualdade profunda do reexport). No gateway:
`blueprint/query {projection: "document"}` e `blueprint/load {document}`.

```mermaid
graph TD
  EXP["exportBlueprint"] --> DOC[("BlueprintDocument<br/>schemaVersion + dominios")]
  DOC -.-> RAW["raw carregado"]
  subgraph LOAD["LOAD"]
    RAW --> MIG["migrateBlueprintDocument(raw)<br/>(sem schemaVersion = 0)"]
    MIG --> V{"versao > suportada?"}
    V -->|"sim"| REJ(["REJEITA"])
    V -->|"nao"| CHAIN["migra encadeado v(n)->v(n+1)<br/>(MIGRATIONS: 0->1)"]
    CHAIN --> CMD["documentToCommands<br/>(ordem de dependencia)"]
    CMD --> CHK{"store vazio?"}
    CHK -->|"nao"| ERR(["replayDocument exige store vazio"])
    CHK -->|"sim"| REP["replayDocument: despacha cada comando pelo orquestrador"]
    REP --> SUM(["ReplaySummary {applied, projected, deferred, skipped}"])
  end
```

*Mostra o ciclo de persistencia: exportBlueprint produz o BlueprintDocument e o LOAD faz deteccao de versao, migracao encadeada, conversao em ordem de dependencia e replayDocument em store vazio pelo orquestrador, terminando no ReplaySummary. O mesmo caminho serve a templates (project/new).*

## 5. Migração e regras de evolução

- `EngineBridge` permanece como transporte MonoGame (sessões, reidratação);
  o `MonoGameAdapter` é a face canônica dele. Na Fase 4, as ferramentas MCP
  de domínio migram para `CanonicalOrchestrator.dispatch` (hoje: `blueprint_command`
  já usa o orquestrador).
- Perfis novos entram como arquivos versionados; alterar um perfil publicado
  exige nova versão (imutabilidade por versão, como pacotes).
- Um runtime novo = um adapter + um perfil; o modelo canônico e a UI não mudam.
