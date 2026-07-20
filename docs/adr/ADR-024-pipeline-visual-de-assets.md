# ADR-024 — Pipeline visual de assets como serviço de aplicação

**Status:** Accepted  
**Data:** 2026-07-19

- **Código:** `middleware/src/application/AssetApplicationService.ts`,
  `middleware/src/assets/AssetPipelineService.ts` e `frontend/src/core/assetApi.ts`
- **Gate:** testes de contrato de assets no middleware, GraphQL e workbench

## Contexto

O middleware já normalizava exports do Aseprite e compilava spritesheets pelo
MGCB, mas o fluxo só era alcançável por watcher/CLI e pelo MCP. A composição do
Electron sequer fornecia `--assets` ao middleware. Copiar essa orquestração para
o renderer criaria uma segunda implementação de importação, sem os mesmos
artefatos, erros, segurança ou proveniência.

Assets são operações frias e dominadas por I/O externo. Elas não justificam
novos RPCs no caminho quente gRPC. Ao mesmo tempo, progresso de pipeline não é
uma mutação do Blueprint e não pode sujar o projeto, entrar no CommandHistory ou
acionar autosave.

## Decisão

`AssetApplicationService` pertence à camada de aplicação do middleware. Ele é a
única fachada de produto sobre `AssetPipelineService`, `ArtifactStore` e
`PipelineRunner`: valida o workspace, mantém catálogo, agenda/cancela operações,
configura/testa ferramentas, interpreta falhas e oferece reveal de paths já
conhecidos. Watcher e GraphQL delegam a essa fachada; nenhuma borda executa
Aseprite/MGCB diretamente. MCP conserva apenas consulta de catálogo: iniciar
binários requer uma ação confirmada na interface visual.

As operações frias são expostas pela `EditorSurface` e pelo baseline GraphQL:
catálogo, detalhes, import, reimport, remove, configuração de ferramentas,
cancelamento e reveal. O contrato gRPC permanece inalterado. O Electron expõe
somente IPCs tipados e seletores nativos específicos; o renderer não recebe
`fs`, `child_process`, GraphQL ou uma API genérica de diálogo.

Uma importação recebe `operationId` e retorna ACK de aceitação. Progresso,
conclusão, cancelamento e erro usam `EditorApplicationEvent` com domínio,
severidade, progresso, payload e timestamp. Esses envelopes compartilham o
`EventJournal`/stream existente para preservar uma única ordem e cursor, mas
continuam semanticamente separados: `EditorClient` os encaminha para
`onApplicationEvent` antes de qualquer listener de `BlueprintEvent`, dirty
state, histórico ou autosave.

O catálogo é particionado pela sessão ativa. Uma troca cancela operações da
sessão anterior e resultados tardios são descartados. A referência persistida
no projeto é `EntityDefinition.spriteRenderer { assetId, defaultClip? }`; ela é
alterada pelo comando canônico `entitydef/update`, participa de undo/redo e
permanece reparável quando o asset está ausente. O documento Blueprint v5
adiciona esse campo opcional sem inventar referências durante a migração v4→v5.

Thumbnails atravessam o boundary apenas como `data:image/png` limitado ou por
fallback visual. Paths locais nunca viram `file://` no DOM e a CSP não é
relaxada. Imports externos são copiados para um destino validado dentro do
catálogo antes do pipeline; nomes/diretórios não podem escapar por `..`, path
absoluto ou symlink.

Configurações Aseprite/MGCB possuem escopo de usuário ou projeto. O escopo de
projeto usa `projectId` estável, não `projectSessionId`; ambos são gravados pelo
serviço e testados executando a ferramenta, sem solicitar edição manual de JSON.

## Consequências

- Import, watcher e reimport produzem os mesmos artefatos e diagnósticos; MCP é
  deliberadamente somente leitura para assets.
- A UI pode montar fila e Problems sem contaminar documento/histórico.
- Save/reopen preserva associação de sprite mesmo se o catálogo estiver
  temporariamente ausente; a interface oferece reparo em vez de recusar Open.
- Reimport publica uma nova revisão e evento; Asset Browser/Inspector recarregam
  detalhes. Um PreviewHost futuro poderá consumir o mesmo evento sem mudar o
  contrato de importação.
- O catálogo gerenciado padrão vive no diretório de dados do aplicativo. Modo
  `--external-services` precisa fornecer um catálogo ao middleware de dev.
- Remover um asset não remove silenciosamente referências de archetypes; elas
  aparecem em Problems até serem reassociadas ou removidas por comando canônico.

## Alternativas rejeitadas

1. **Executar Aseprite/MGCB no Electron.** Duplica domínio, amplia o boundary de
   segurança e produz comportamento diferente entre UI, watcher e MCP.
2. **Adicionar RPCs gRPC de importação.** Não há benchmark nem requisito de
   latência que justifique ampliar o caminho quente para operações de arquivo.
3. **Misturar progresso com `BlueprintEvent`.** Sujaria o projeto e criaria
   histórico/autosave para fatos operacionais transitórios.
4. **Persistir paths absolutos no Blueprint.** Quebra portabilidade e transforma
   mudança de máquina em documento inválido.
5. **Invalidar projeto por asset ausente.** Impede recuperação e contamina o
   fluxo transacional de Open com disponibilidade externa.

## Critérios de revisão

Revisar antes de introduzir tipos além de Aseprite, armazenamento remoto,
catálogos compartilhados ou PreviewHost. Um novo RPC gRPC exige benchmark
reproduzível e uma necessidade concreta de streaming que o journal atual não
atenda.
