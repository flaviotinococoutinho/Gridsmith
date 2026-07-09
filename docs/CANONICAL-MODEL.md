# Modelo Canônico e Governança de Runtimes

O P7M é uma ferramenta visual de desenvolvimento de jogos **fortemente
orientada a domínio**: o que o usuário edita é um modelo canônico próprio,
independente de runtime. Runtimes concretos (MonoGame hoje; outros no futuro)
recebem **projeções** desse modelo através de adapters, e a experiência visual
é **governada** por perfis versionados de capacidades.

```
                    ┌───────────────────────────────────────────┐
                    │           MODELO CANÔNICO                 │
                    │                                           │
  Comando ──filters──▶ BlueprintStore ──▶ Evento ──actions──▶ Hooks
                    │        │                     │           │
                    │        ▼                     ▼           │
                    │   Projeções (Query)    Pipelines ──▶ Artefatos
                    │                                    (versionados)
                    └───────────────┬───────────────────────────┘
                                    │ projeção de eventos
                     ┌──────────────┴──────────────┐
                     ▼                             ▼
             ┌──────────────┐              ┌──────────────┐
             │ MonoGame     │              │ (futuro)     │
             │ Adapter      │              │ outro adapter│
             └──────┬───────┘              └──────────────┘
                    │ JSON-RPC / shared memory
                    ▼
             engine MonoGame
```

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

### Orquestração (`canonical/CanonicalOrchestrator.ts`)

O caminho canônico de qualquer mutação:

```
dispatch(comando)
  = applyFilters("command:<kind>", comando)   // filters
  → store.apply(...)                          // validação + evento
  → doAction("event:<kind>", evento)          // actions
  → adapter.project(evento)                   // projeção no runtime (se conectado)
```

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
| `entityDefDefined`/`entityPlaced` | `skipped` (domínio puramente editorial hoje — vira spawn table na Fase 4) |

Adapters declaram `family` (grupo tecnológico) e obtêm a versão concreta do
handshake/describe do runtime vivo.

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

## 5. Migração e regras de evolução

- `EngineBridge` permanece como transporte MonoGame (sessões, reidratação);
  o `MonoGameAdapter` é a face canônica dele. Na Fase 4, as ferramentas MCP
  de domínio migram para `CanonicalOrchestrator.dispatch` (hoje: `blueprint_command`
  já usa o orquestrador).
- Perfis novos entram como arquivos versionados; alterar um perfil publicado
  exige nova versão (imutabilidade por versão, como pacotes).
- Um runtime novo = um adapter + um perfil; o modelo canônico e a UI não mudam.
