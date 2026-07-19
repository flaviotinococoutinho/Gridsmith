# ADR-023 — Workbench adaptativo por contribuições internas

**Status:** Accepted  
**Data:** 2026-07-19

- **Código:** `frontend/src/core/{panelRegistry,commandRegistry,toolRegistry,inspectorRegistry,selectionService,workbenchLayout}.ts` e `frontend/src/renderer/workbenchApplication.ts`
- **Gate:** `cd frontend && npm run test:adaptive-workbench`

## Contexto

A primeira casca do editor concentrava a escolha de painéis, comandos e abas
inferiores em condicionais dentro de `renderer.ts`. A barra do editor de níveis
também materializava ferramentas diretamente. Esse formato atendia à primeira
vertical slice, mas exigia editar pontos centrais para adicionar assets,
entidades, câmera, luzes ou painéis de diagnóstico. Seleção e inspector não
possuíam um contrato transversal.

O MVP precisa crescer sem transformar a casca Electron em uma segunda camada de
domínio. Ao mesmo tempo, ainda não há necessidade de estabilizar uma API pública
de plugins ou um marketplace.

## Decisão

O renderer passa a ser composto por contribuições internas registradas no boot:

- `PanelRegistry` monta painéis por região, seleção, modo e capacidades;
- `CommandRegistry` fornece a mesma ação para menu, toolbar, menu de contexto,
  paleta, atalhos e ações corretivas;
- `ToolRegistry` descreve ferramentas e sua disponibilidade, sem o workbench
  conhecer IDs concretos;
- `SelectionService` publica uma união discriminada compartilhada por canvas,
  árvore, inspector e Problems;
- `InspectorRegistry` resolve schemas de campos por tipo de seleção e oferece
  validação, reset, edição múltipla, unidades e modo de aplicação;
- `WorkbenchLayoutController` mantém tamanhos, visibilidade e adaptação a janela
  estreita atrás de uma porta de persistência injetável.

`CapabilityRegistry` é fail-closed: capability desconhecida desabilita a
contribuição com razão, sem transformar ausência de runtime em permissão. O
`EditorModeService` apenas troca o conjunto de contribuições visíveis entre
`edit`, `playing` e `paused`; os comandos de modo não iniciam engine, PreviewHost
ou gameplay nesta decisão.

`PanelHostController` é dono do mount/activate/dispose. Uma instância pode ser
reutilizada em refreshes contextuais da mesma região quando contribuição e sessão
continuam iguais; troca de `projectSessionId` força descarte para impedir estado
visual do projeto anterior. O catálogo built-in registra Projeto, Início, editor de nível,
Inspector, Problemas, Saída, Histórico e Performance sem condicionais na shell.

O renderer projeta os placements `menu` e `shortcut` do `CommandRegistry` em
descritores serializáveis. O main valida o lote inteiro, impõe limites e só então
substitui atomicamente o menu nativo; callbacks, roles Electron e Recentes nunca
atravessam o preload. Um clique publica uma `ProjectCommandInvocation` de volta
ao mesmo registry de toolbar, contexto, atalhos e paleta. Assim, menu e segunda
instância não mantêm handlers paralelos do ciclo de projeto.
Accelerators de contribuições são normalmente apenas exibidos pelo Electron
(`registerAccelerator:false`): o shortcut registry do renderer decide entre
undo textual e histórico global conforme o foco. Como essa opção não impede a
captura no macOS, `Cmd+Z`/`Cmd+Shift+Z` são omitidos do menu nativo nesse sistema
e continuam pertencendo ao renderer. A role nativa de reload foi removida porque
não atravessava o boundary de drafts/preflight.

Commits assíncronos do Inspector são registrados no `PendingEditCoordinator`.
Save, Close, Open, New e histórico aguardam esses commits; atalhos e invocações
nativas desfocam primeiro o controle ativo. O fechamento da janela usa um
preflight main→renderer com deadline: falha de validação, commit ou timeout
cancela o fechamento antes de o `ProjectController` oferecer Save.
Uma recusa `{applied:false}` vira falha rastreada, e a chave inclui sessão e
identidade semântica normalizada da seleção. New/Open cancelam o gesto visual e
tornam canvas/Inspector inertes antes da troca. `ExternalOpenIntentQueue`
serializa intents de arquivo do sistema operacional; um draft inválido preserva
o path e sua correção reativa exatamente o mesmo intent, sem abrir parcialmente
nem depender da chegada de um segundo pedido.

As contribuições consultam capabilities por uma função fail-safe. Uma
contribuição indisponível fica oculta ou bloqueada segundo sua política e sempre
expõe uma razão humana. Modo `edit`, `playing` ou `paused` apenas seleciona
contribuições de UI nesta decisão; não implementa preview ou gameplay.

`renderer.ts` permanece como composition root mínimo: boot, registro dos módulos
e roteamento de eventos globais. `EditorWorkbenchApplication` coordena os
registries e portas do preload; lógica de gesto continua em módulos puros de
`core/` e a vista de nível apenas adapta ponteiro/DOM a esses módulos.

## Acessibilidade

Todas as regiões e comandos são alcançáveis por teclado. Splitters implementam
semântica de separador e redimensionamento por setas; drawers estreitos usam abas
com estado anunciado; comandos indisponíveis fornecem texto explicativo. Cor
nunca é o único sinal: paleta, estados, problemas e seleção mantêm rótulo, ícone
ou texto visível.

## Consequências

- Um novo painel ou comando é adicionado por registro, sem switch na shell.
- O menu nativo deriva do mesmo catálogo e recebe enablement/razão do contexto
  atual, sem duplicar labels e atalhos no fluxo normal.
- Canvas, árvore e inspector observam a mesma seleção sem referências mútuas.
- O layout pode ser testado com armazenamento em memória, fora do Electron.
- Somente tamanhos/visibilidade no formato versionado `v1` são persistidos;
  breakpoint e drawer aberto são derivados e efêmeros. Falha de `localStorage`
  é best-effort e não bloqueia edição.
- Comandos em Exibir alternam as três regiões e restauram o layout padrão, sem
  introduzir IDs de painéis na shell.
- Contribuições são uma fronteira interna e podem mudar durante o MVP; não são
  uma promessa de compatibilidade para terceiros.
- Ferramentas que exigem comportamento novo ainda precisam fornecer seu handler
  puro; o registry remove acoplamento de composição, não elimina implementação.
- Câmera, luz, spawn e trigger podem existir como contribuições bloqueadas para
  explicar a capability ausente; isso não equivale a implementar gizmo,
  PreviewHost ou gameplay.

## Riscos

- O gate atual combina testes puros e inspeção estrutural de source; não prova
  CSS, foco ou eventos num Electron real. E2e visual continua obrigatório para
  declarar a jornada pronta.
- IDs e schemas dos registries são internos. Um consumidor externo que os trate
  como API está assumindo um contrato que esta ADR deliberadamente não oferece.
- Preferências de layout são locais e best-effort; não fazem parte do documento
  de projeto nem sincronizam entre máquinas.
- O renderer traduz os diagnósticos estruturais conhecidos do governor e mantém
  fallback textual para razões de produto já fornecidas pelo perfil.

## Alternativas rejeitadas

1. **Continuar ampliando switches em `renderer.ts`.** Mantém um ponto de mudança
   global e acopla funcionalidades independentes.
2. **Usar IDs de elementos como barramento.** Não oferece tipos, capability gate
   nem ciclo de vida de montagem/limpeza.
3. **Publicar uma API de plugins agora.** Congelaria contratos antes de assets,
   preview e ferramentas validarem as extensões necessárias.
4. **Duplicar seleção em cada painel.** Produz divergência entre canvas, árvore e
   inspector e dificulta ações corretivas de Problems.

## Critérios de revisão

Revisar esta decisão antes de publicar plugins de terceiros, persistir layout no
documento do projeto, sincronizar preferências ou ligar modos de UI a um
PreviewHost real. Mudança incompatível em `PersistedWorkbenchLayout` exige nova
versão e estratégia explícita de leitura; adicionar contribuição built-in não.
