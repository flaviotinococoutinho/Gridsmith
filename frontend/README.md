# @p7m/frontend — Editor visual (Electron)

Editor visual do ecossistema P7M EaaS. **Shell fina + núcleos de domínio
testáveis**: nenhuma lógica de jogo vive no Electron — comandos são
despachados pelo caminho canônico do middleware e o gating de UI vem da
governança de runtime.

## Estrutura

| Módulo | Papel |
|---|---|
| `src/core/bezier.ts` | Easing Bézier cúbica (convenção CSS, Newton + bisseção) — motor do editor de curvas e das transições de estado |
| `src/core/fabrik.ts` | Solver FABRIK 2D para edição interativa de rigs (comprimentos preservados, alvo inalcançável estica a cadeia, determinístico) |
| `src/core/stateMachine.ts` | Máquina de estados visuais com semântica Gum: estado = conjunto nomeado de atribuições; numéricos interpolam com easing (interrupt-safe), discretos aplicam no início |
| `src/core/experienceGate.ts` | Gate da UI sobre a matriz de decisões da governança — painéis desabilitados carregam a RAZÃO do perfil/manifesto |
| `src/core/transportRouter.ts` | Política **pura** de transporte: gRPC prioritário, fallback imediato para GraphQL em falha DE TRANSPORTE, sondas com backoff e histerese — falha de domínio nunca troca transporte (ADR-017) |
| `src/core/projectLifecycle.ts` | Máquina de estados do documento vinculada a `projectSessionId`; dirty tracking e autosave só avançam para a sessão confirmada |
| `src/core/projectApi.ts` | Contratos tipados compartilhados por main/preload/renderer para New/Open/Save/Save As/Close/Recovery/Recentes |
| `src/core/projectWizardModel.ts` | Estado e validação puros do wizard de projeto, alimentado pelos templates reais do middleware |
| `src/core/levelEditorTools.ts` | Ferramentas puras do editor de níveis (brush/rect/line/picker, drag de células, hit-test de marcadores) |
| `src/core/intGridDocument.ts` | Projeção otimista do IntGrid: agrega um patch por gesto, confirma ack/evento e recompõe/reverte rejeições sem histórico paralelo |
| `src/core/logging.ts` | Logger puro com escopo hierárquico e sink injetável (`P7M_VERBOSITY`) |
| `src/main/transport/` | Clientes dos transports (`GrpcTransport`, `GraphQlTransport`) — os **únicos** módulos com SDKs de transporte (regra F5) |
| `src/main/EditorClient.ts` | Cliente do middleware: gRPC quente/fallback GraphQL, cursor `(middlewareInstanceId, projectSessionId, seq)`, snapshot integral em resync e operações transacionais de projeto |
| `src/main/appConfig.ts` | Configuração refinada do Electron: instância única, estado de janela persistido, `sandbox` + navegação/popups bloqueados |
| `src/main/project/` | `ProjectController` e adapters injetáveis de dialogs/filesystem: escrita durável (rename POSIX; swap recuperável no Windows), backup, recovery, lease e composição segura com a sessão transacional |
| `src/main/main.ts` + `preload.ts` | Shell Electron: contextIsolation; lifecycle exposto apenas por APIs tipadas e nomeadas, sem comando genérico |
| `src/renderer/` | Start screen + wizard “Novo projeto”, régua de painéis do ExperienceGate e editor de níveis hidratado pelos IDs/dimensões do documento real |

### Modelo de processos

```mermaid
graph TD
  subgraph FE["Frontend (Electron/TS)"]
    direction TB
    FEmain["main (Node privilegiado)<br/>supervisor + ciclo de projeto + dialogos"]
    FEpre["preload (window.p7m, contextIsolation)"]
    FErnd["renderer (UI)"]
    FEcore["core/ (nucleos puros)"]
    FEmain --> FEpre
    FEpre --> FErnd
    FErnd --> FEcore
  end
  GW(["Gateways do app (middleware)<br/>gRPC + GraphQL"])
  FEmain == "quente: gRPC (prioritario)" ==> GW
  FEmain -. "baseline/fallback: GraphQL" .-> GW
  F["F1-F5 (fitness import-graph)"] -. "impoem as fronteiras deste grafo" .-> FE
```

*Mostra o modelo de processos do frontend — main -> preload -> renderer -> core/ — com os transports do app no main (gRPC prioritario, GraphQL fallback) e as fitness functions F1-F5 que fixam essas fronteiras de importação.*

## Comandos

```bash
# o middleware precisa estar compilado (dependência file:../middleware)
cd ../middleware && npm run build && cd ../frontend

npm install        # ELECTRON_SKIP_BINARY_DOWNLOAD=1 para pular o binário (CI)
npm run build
npm test           # núcleos + integração real com o EditorGateway
npm run test:project-lifecycle-product  # gate explícito de New/Open/Save/Recovery/Recentes

# execução (requer o binário do Electron e um middleware rodando):
node ../middleware/dist/index.js --pipe p7m-engine --no-mcp &
npm run app -- --pipe p7m-engine

# e2e dos transports (gRPC quente + fallback GraphQL), da raiz do repo:
../scripts/verify-transports.sh
```

O app fala com o middleware por gRPC no caminho quente e cai para GraphQL em
falha de transporte (ADR-016/017/018/019/020 em
[`../docs/adr/`](../docs/adr/README.md)).
Verbosidade dos dois lados: `P7M_VERBOSITY=silent|error|warn|info|debug|trace`
(default `info`).

Create/open/close consultam `project/status` e usam
`expectedProjectSessionId` + `expectedCommandSequence` como compare-and-swap.
O lifecycle local só troca o
descritor depois da confirmação do middleware; documento inválido ou falha de
replay deixa projeto e dirty state anteriores intactos. `runtimeState` distingue
`synchronized`, `deferred` (engine ausente) e `failed` (fail-closed). Ao detectar
restart, gap ou `project_session_changed`, o `EditorClient` busca um snapshot
completo, substitui todas as projeções e só então retoma stream/polling da nova
tripla de cursor.

## Ciclo de vida do projeto

New, Open, Save, Save As, Close, Recovery, exemplo e Recentes passam por um
único `ProjectController`. Menu, toolbar e argumentos da segunda instância não
possuem caminhos alternativos. O preload publica apenas
`listProjectTemplates`, `createProjectFromTemplate`, `openProject`,
`saveProject`, `saveProjectAs`, `closeProject`, `restoreAutosave`,
`discardAutosave` e `openRecent` para essas operações.

O wizard materializa o template canônico `platformer-2d` com nome, resolução e
tile size escolhidos, grava o `.p7m.json` com temporário + flush + publicação
exclusiva no-clobber e só
então ativa a sessão transacional. O editor abre o primeiro nível do documento
e preserva IDs, dimensões e posições; células são convertidas para
`world-pixel` pela função canônica do middleware.

Close dirty nunca prossegue depois de Save cancelado ou com erro. Um projeto
sem caminho usa Save As. `.autosave` posterior ao arquivo confirmado oferece
Restaurar, Abrir cópia, Ignorar ou Cancelar e só é removido por Save confirmado
ou descarte explícito. O exemplo distribuído sempre abre como cópia sem caminho.
Recentes usam menu nativo, canonicalização e lease; segunda instância encaminha
o arquivo à janela ativa. Rebind após restart exige documento e watermark
iguais ao cache; `projectId` sozinho nunca associa conteúdo remoto ao caminho
local. Decisão completa:
[ADR-021](../docs/adr/ADR-021-ciclo-de-vida-duravel-do-projeto.md).

## Edição canônica e histórico

Pincel contínuo, borracha, linha, retângulo e balde aplicam feedback local e
enviam um único `level/patch` no fim do gesto. O patch carrega
`transactionId`, label e mudanças `{index,before,after}`; ack confirma a camada
otimista e rejeição a recompõe com mensagem acionável. Não existe “Publicar
nível”: “Recalcular arte” recalcula somente a projeção derivada.

Undo/redo é global e pertence à `ProjectSession`. Menu, toolbar e atalhos
chamam a operação canônica mesmo quando outro painel está ativo. Eventos de
outros clientes atualizam a mesma projeção; resync substitui a base inteira.
Save/autosave/Close não capturam gesto pendente. Decisão:
[ADR-022](../docs/adr/ADR-022-historico-global-transacional.md).

## Regras da casa

- **CQRS**: o renderer nunca muta estado — despacha comandos canônicos e
  re-renderiza projeções/eventos.

```mermaid
graph LR
  R["renderer (UI)"] -->|"dispatch(command)"| P["preload (window.p7m)"]
  P == "IPC do Electron (contextBridge)" ==> M["main (EditorClient)"]
  M == "quente: gRPC / fallback: GraphQL" ==> GW(["EditorSurface (caminho canonico)"])
  GW --> SESS["ProjectSessionManager<br/>sessao ativa"]
  SESS -->|"store.apply + projecao"| EV(["evento de sessao / projecao"])
  EV -.-> M
  M -.-> P
  P -.->|"re-render"| R
```

*Mostra o laço CQRS do editor: o comando flui em mão única do renderer ao caminho canônico do middleware, e só eventos/projeções voltam para re-renderizar — o renderer nunca muta estado localmente.*

- **Governança visível**: painel desabilitado sempre mostra a razão vinda do
  perfil de runtime ou do manifesto vivo — nunca um genérico "indisponível".

```mermaid
graph TD
  A["ExperienceGate sobre ExperienceGovernor.decide(rule)"] --> B{"effect == disable?"}
  B -->|"sim"| D1(["desabilitado (source: profile-rule)"])
  B -->|"nao"| C{"requiresCapability ausente do perfil?"}
  C -->|"sim"| D1
  C -->|"nao"| E{"requiresSubsystem?"}
  E -->|"nao"| OK(["habilitado"])
  E -->|"sim"| F{"subsystem == available no manifesto?"}
  F -->|"nao / sem engine"| D2(["desabilitado (source: live-manifest, FAIL-SAFE)"])
  F -->|"sim"| OK
```

*Mostra como o ExperienceGate materializa cada FeatureDecision: a razão do painel desabilitado vem do perfil (profile-rule) ou do manifesto vivo (live-manifest, fail-safe quando não há engine).*
- Editores de canvas pesados (curvas, rigs, grafos) rodam fora da main thread
  (Worker Threads/OffscreenCanvas) — os solvers em `src/core/` são puros
  exatamente para isso.

## Máquinas de estado

O processo `main` hospeda duas máquinas de estado: o **ProjectLifecycle** (ciclo
de vida do projeto aberto) e o **ServiceState** do **ProcessSupervisor** (supervisão
dos serviços locais, ex. middleware/engine).

```mermaid
stateDiagram-v2
  state "ProjectLifecycle (Frontend main)" as PL {
    [*] --> no_project
    no_project --> opening : open
    open_clean --> opening : substituir
    open_dirty --> opening : substituir confirmado
    opening --> open_clean : ok / restaura A limpo
    opening --> open_dirty : falha, restaura A sujo
    opening --> no_project : falha sem sessao anterior
    open_clean --> open_dirty : editar
    open_dirty --> open_clean : salvar
    open_clean --> saving : save
    open_dirty --> saving : save
    saving --> open_clean : ok
    open_clean --> closing : close
    open_dirty --> closing : close
    closing --> no_project : fechado
  }
  state "ProcessSupervisor ServiceState" as SS {
    [*] --> stopped
    stopped --> starting : start
    starting --> running : up
    running --> retrying : queda
    retrying --> starting : retry
    starting --> failed : esgota tentativas
    running --> stopped : shutdown
  }
```

*Mostra as duas máquinas de estado do `main`: o ProjectLifecycle com o par open-clean<->open-dirty e retorno por openFailed, e o ServiceState do ProcessSupervisor com o laço de retry e o ramo failed ao esgotar tentativas.*
