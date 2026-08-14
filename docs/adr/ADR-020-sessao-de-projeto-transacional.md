# ADR-020 — Sessão de projeto transacional e substituição atômica

- **Status:** Accepted · **Data:** 2026-07-19
- **Código:** [`ProjectSessionManager.ts`](../../middleware/src/canonical/ProjectSessionManager.ts), [`EditorSurface.ts`](../../middleware/src/canonical/EditorSurface.ts), [`RuntimeAdapter.ts`](../../middleware/src/runtime/RuntimeAdapter.ts), [`EventJournal.ts`](../../middleware/src/transport/EventJournal.ts)
- **Contratos:** [`editor.schema.graphql`](../../contracts/graphql/editor.schema.graphql), [`gridsmith_editor.proto`](../../contracts/grpc/gridsmith_editor.proto), [`engine.reset_session.schema.json`](../../contracts/schemas/engine.reset_session.schema.json)
- **Testes:** [`project-session-manager.test.ts`](../../middleware/test/project-session-manager.test.ts), [`transport-gateways.test.ts`](../../middleware/test/transport-gateways.test.ts), [`editor-client.integration.test.ts`](../../frontend/test/editor-client.integration.test.ts), [`EngineSessionResetTests.cs`](../../engine/tests/Gridsmith.Engine.Ipc.Tests/EngineSessionResetTests.cs)

## Contexto

`EditorSurface`, JSON-RPC e MCP conservavam referências ao primeiro
`BlueprintStore`/`CanonicalOrchestrator`. O load reproduzia comandos nesse store
vivo e publicava cada evento. Uma falha no quinto comando deixava quatro mudanças
visíveis; fechar no Electron não fechava o middleware; uma reconexão da engine
reidratava a referência antiga.

## Decisão

`ProjectSessionManager` é o dono da sessão ativa. Cada `ProjectSession` possui
identidade, projeto, store, orquestrador, `CommandHistory` e data de criação.
Open executa parse, migração, validação, replay e validações semânticas numa
sessão temporária sem actions, journal ou runtime. Depois de preparar a projeção,
o manager reseta e reidrata o runtime sob exclusão; só publica a nova referência
após sucesso. Em falha, reseta e reidrata A antes de propagar o erro.

Create e open aceitam `expectedProjectSessionId` como compare-and-swap. A
identidade é validada somente no commit, depois da preparação privada; um
candidato preparado sobre A não pode sobrescrever B se outro cliente já trocou
a sessão. Close e dispatch usam a mesma proteção quando o chamador informa a
identidade esperada.

Todos os transports recebem a mesma `EditorSurface`, que consulta o manager a
cada operação. Eventos são enriquecidos com `projectSessionId`, `projectId` e
`commandSequence`. O `EventJournal` troca o objeto-partição por sessão; cursor de
A em B retorna `project_session_changed` e exige snapshot completo.

`BlueprintStore.apply` apenas valida, altera o estado privado e devolve o evento;
ele não possui publicação própria. O manager publica somente depois de o
`CommandHistory` confirmar a mesma sequência, impedindo que um observer interrompa
o commit entre store e histórico. A deduplicação de `requestId` também registra a
sessão de origem: um retry tardio de A após a ativação de B falha com conflito e
nunca é reaplicado no novo projeto.

`RuntimeAdapter` inclui `resetSession` e `rehydrateFrom`. A engine implementa
`engine/reset_session` sob um lock, usando `Reset()` dedicado nos stores e
descartando readers de shared memory antes da reidratação.

`EnginePipeServer` incrementa um `runtimeSessionEpoch` em toda troca efetiva da
engine, inclusive disconnect. O reset devolve o epoch realmente limpo e o
manager o passa ao replay e à compensação. `MonoGameAdapter` mantém o peer
preso a esse epoch e o valida antes e depois de cada RPC; supersession aborta a
ativação em vez de misturar projeções de duas engines. Reidratação por reconnect
usa a mesma barreira de leitura da ativação, portanto snapshot/status não são
observáveis enquanto o runtime está parcialmente reconstruído.

## Alternativas rejeitadas

1. **Reproduzir no store ativo e desfazer em erro** — exige compensação por
   comando, permite eventos parciais e não restaura side-effects de hooks/runtime
   com segurança.
2. **Esvaziar coleções (`Map.clear`) antes do load** — limpa apenas uma
   implementação de estado; não substitui store, orquestrador, histórico,
   identidade, journal e runtime como uma unidade.
3. **Fechar A antes de preparar B** — deixa o editor sem sessão íntegra se parse,
   migração, replay ou validação de B falhar.
4. **Publicar B e reidratar depois** — permite que clientes observem B enquanto o
   runtime ainda contém A. A ativação permanece uma transação com compensação;
   indisponibilidade conhecida da engine é representada por `deferred`.

## Consequências

- Documento inválido ou replay interrompido não altera sessão, dirty state,
  journal nem runtime ativos.
- Troca desconectada é aceita com estado `deferred`; a reconexão captura e
  reidrata somente a sessão ainda ativa. Falha de compensação marca a sessão
  como `failed` e bloqueia novas mutações até uma reidratação integral concluir.
- APIs incrementais sem identidade de sessão permanecem nominalmente para
  compatibilidade, mas falham de forma explícita.
- `CommandHistory` nesta decisão é append-only e fornece relógio lógico; undo e
  redo continuam fora do escopo.

## Riscos e mitigação

- Reset/reidratação são side-effects externos e não oferecem rollback nativo. O
  manager compensa reidratando A; se a compensação também falhar, conserva a
  referência de A, marca `failed` e bloqueia mutações em vez de alegar sucesso.
- `expectedProjectSessionId` é opcional no fio por compatibilidade. O
  `EditorClient` sempre o envia ao substituir uma sessão observada; clientes
  externos que o omitem aceitam explicitamente semântica last-writer-wins.
- Aliases `blueprint/load` e `project/new` permanecem durante a migração, mas
  delegam nas operações transacionais e não mantêm um segundo caminho de load.

## Critérios de revisão

Revisar esta decisão se o runtime passar a oferecer transação/snapshot nativo,
se a sessão precisar persistir histórico de undo/redo, ou quando a remoção dos
aliases legados for compatível com todos os clientes. Nenhuma dessas condições
autoriza reintroduzir replay no estado publicado ou eventos parciais.
