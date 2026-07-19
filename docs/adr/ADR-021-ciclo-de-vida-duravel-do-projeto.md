# ADR-021 — Ciclo de vida durável do arquivo de projeto

- **Status:** Accepted · **Data:** 2026-07-19
- **Código:** [`ProjectController.ts`](../../frontend/src/main/project/ProjectController.ts), [`ProjectFileService.ts`](../../frontend/src/main/project/ProjectFileService.ts), [`NodeProjectFileSystem.ts`](../../frontend/src/main/project/NodeProjectFileSystem.ts), [`preload.ts`](../../frontend/src/main/preload.ts), [`ProjectTemplates.ts`](../../middleware/src/canonical/ProjectTemplates.ts), [`GridCoordinates.ts`](../../middleware/src/leveldesign/GridCoordinates.ts)
- **Documento de exemplo:** [`platformer-2d-example.p7m.json`](../../frontend/examples/platformer-2d-example.p7m.json)
- **Testes:** [`project-controller.test.ts`](../../frontend/test/project-controller.test.ts), [`project-file-service.test.ts`](../../frontend/test/project-file-service.test.ts), [`project-wizard.test.ts`](../../frontend/test/project-wizard.test.ts), [`project-artifacts.test.ts`](../../frontend/test/project-artifacts.test.ts), [`project-templates.test.ts`](../../middleware/test/project-templates.test.ts), [`blueprint-migration.test.ts`](../../middleware/test/blueprint-migration.test.ts)

## Contexto

A sessão canônica já era transacional pela ADR-020, mas o ciclo do arquivo no
Electron ainda não tinha a mesma garantia. O comando Novo podia trocar apenas a
máquina local, Save escrevia diretamente no destino, fechar podia prosseguir
depois de um Save As cancelado e um autosave mais novo não oferecia recuperação.
O renderer também reconstruía IDs e dimensões de um nível presumido, divergindo
do documento criado pelo template.

As duas transações são diferentes e precisam se compor: a transação de arquivo
garante bytes duráveis sem destruir a última versão válida; a transação de
sessão garante que parse, migração, replay e runtime não publiquem estado
parcial. Sucesso em apenas uma delas não pode ser apresentado como conclusão do
fluxo de produto.

## Decisão

`ProjectController` é o único caso de uso de New, Open, Save, Save As, Close,
Recovery, exemplo e Recentes. Ele serializa operações concorrentes e depende de
portas injetáveis para cliente do editor, diálogos, filesystem e lease de
arquivo. A main do Electron liga essas portas; os testes exercitam as mesmas
decisões sem depender de Electron nem do filesystem real.

O preload expõe operações de aplicação tipadas e nomeadas:
`listProjectTemplates`, `createProjectFromTemplate`, `openProject`,
`saveProject`, `saveProjectAs`, `closeProject`, `restoreAutosave`,
`discardAutosave` e `openRecent`. Não existe comando genérico de lifecycle que
permita ao renderer contornar o controller.

### Novo e exemplo

O wizard consulta o registro canônico de templates pelo `EditorClient`, mostra
descrição e preview e coleta nome, diretório, resolução de referência e tile
size. O middleware materializa uma função pura de template com IDs definitivos.
O controller grava esse documento e, só depois da publicação exclusiva confirmada, abre-o
pela operação transacional de sessão. A resposta identifica o nível real a ser
exibido; o renderer hidrata IDs, dimensões e entidades do documento, sem criar
substitutos.

O exemplo distribuído é somente leitura do ponto de vista do produto. “Abrir
exemplo” clona o documento com um novo `projectId`, abre uma sessão sem
`filePath` e obriga o primeiro Save a passar por Save As. O arquivo da
instalação nunca é destino de escrita.

### Save e Close

`ProjectFileService` escreve um temporário exclusivo no mesmo diretório,
executa write, flush e close, preserva a versão anterior em `.bak` quando
aplicável e publica Save por rename. New usa hard-link no-clobber para que uma
criação concorrente nunca seja sobrescrita. Em POSIX, o diretório também recebe
flush. O rename substitutivo é atômico onde o sistema operacional o suporta;
no Windows, o adapter trata colisão com um swap restaurável, recuperável mas
não estritamente atômico, e restaura um swap interrompido na leitura seguinte.
O documento válido não é truncado antes de o novo conteúdo estar completo.

Close com alterações só confirma o fechamento remoto depois de Save
concluído. Projeto sem `filePath` abre Save As; cancelar o diálogo ou falhar a
escrita mantém sessão, dirty state e lease ativos. Save e Save As compartilham
esta regra.

Dirty tracking usa `commandSequence` como watermark. A resposta síncrona de
dispatch e o evento posterior do journal são deduplicados; o snapshot de Save
carrega documento e sequência do mesmo ponto. Um comando posterior ao snapshot
mantém o estado dirty mesmo que o rename anterior conclua. Dispatch, Save e
Close passam pela mesma fila do controller. New/Open/Close também enviam
`expectedProjectSessionId` + `expectedCommandSequence`; o commit no middleware
recusa uma revisão obsoleta, inclusive quando o evento concorrente ainda
aguarda na fila do controller.

Um restart do middleware nunca vira Close implícito. O controller conserva uma
projeção completa associada ao watermark observado e reabre somente essa sessão,
preservando `filePath`, recovery, dirty state e lease. Cache atrasado não é
reidratado silenciosamente. Uma nova sessão só herda o caminho local quando o
documento completo também coincide; igualdade de `projectId` não basta.

### Recovery e Recentes

Para um projeto conhecido, um sidecar `.autosave` com timestamp posterior ao
arquivo confirmado produz uma oferta nativa com Restaurar, Abrir cópia,
Ignorar e Cancelar. Restaurar conserva o caminho original e deixa o projeto
dirty; Abrir cópia cria outra identidade sem caminho. Ignorar é a confirmação
explícita para `discardAutosave` depois de abrir a versão salva com sucesso. O autosave só é
removido depois de Save confirmado ou desse descarte confirmado; falhas de
leitura, replay, descarte ou escrita não eliminam a recuperação.
“Descartar” em Close/Replace remove o sidecar somente depois do commit; se a
operação falhar, a recuperação permanece.

Recentes são apresentados num submenu nativo. Entradas inexistentes são
podadas. Argumentos de uma segunda instância são encaminhados à janela já
ativa, que recebe foco. Caminho canônico, instância única do Electron e lease
no controller impedem que dois fluxos da aplicação editem simultaneamente o
mesmo arquivo.

### Documento e coordenadas

O Blueprint passa à versão 3. `metadata` registra nome, resolução de referência
e semântica espacial: posição em `world-pixel`, origem da célula no canto
superior esquerdo, eixo Y para baixo e âncora da entidade no centro. A migração
`2 → 3` preserva posições genéricas já interpretadas pelo runtime. A exceção é
o factory v2 publicado do template Plataforma 2D: sua forma completa (grid,
câmera, regras, IDs e coordenadas), exceto o `projectId` que o fluxo histórico
substituía por UUID, é convertida por `cellToWorldCenter`, sem heurística sobre
documentos ou posições editadas.

Templates convertem célula para mundo exclusivamente por
`cellToWorldCenter`. IDs de nível, definição, instância e luz pertencem ao
documento materializado e são preservados pela UI.

## Alternativas rejeitadas

1. **Manter lógica de arquivos em handlers IPC independentes** — permite que
   menu, toolbar, segunda instância e fechamento tenham regras divergentes.
2. **Escrever diretamente com truncamento** — uma queda entre truncar e
   concluir destrói a última versão válida.
3. **Ativar a sessão antes de criar o arquivo de Novo** — falha de permissão
   deixaria um projeto “criado” que nunca existiu em disco.
4. **Restaurar autosave silenciosamente** — pode substituir intenção do usuário
   e oculta qual versão está sendo aberta.
5. **Recriar IDs ou inferir unidade no renderer** — cria dois modelos de
   verdade e torna save/reopen dependente de heurísticas.
6. **Usar `Map.clear` ou reset local como lifecycle** — não cobre arquivo,
   sessão, runtime, journal, recovery nem concorrência.

## Consequências

- O editor inicia sem projeto e oferece New, Open, exemplo e Recentes sem
  terminal ou edição manual de JSON.
- O template Plataforma 2D cria um documento real com nível, Player, câmera e
  luz antes de ativar a sessão.
- Cancelamento e falha são resultados observáveis; nenhum deles é convertido
  em fechamento bem-sucedido.
- Escrita segura e sessão transacional formam duas barreiras consecutivas.
- Blueprint v3 elimina a ambiguidade de unidade para novos documentos e
  preserva compatibilidade por migração encadeada.
- Undo/redo, preview, assets visuais e gameplay não fazem parte desta decisão.

## Riscos e mitigação

- Rename e flush têm diferenças entre sistemas operacionais. O adapter mantém
  temporário no mesmo volume, usa backup e possui caminho de swap recuperável
  no Windows; falhas continuam sendo propagadas ao controller.
- O lease é da aplicação, não um protocolo distribuído. Instância única e
  canonicalização cobrem a execução desktop suportada; múltiplas instalações
  independentes ou filesystems remotos exigiriam lock interprocesso próprio.
- Cópias ainda sem `filePath` (exemplo e “Abrir cópia”) exigem Save As antes de
  possuírem sidecar recuperável; uma futura área de drafts em `userData` deve
  cobrir crash anterior ao primeiro Save sem escrever no exemplo distribuído.
- Ignorar tenta apagar o autosave somente após confirmação no diálogo e Open
  concluído; falha no descarte preserva a recuperação sem desfazer a sessão já
  confirmada.
- O arquivo é gravado antes da ativação de Novo. Depois da publicação exclusiva,
  ele é preservado mesmo se a resposta da ativação for ambígua: pode ser a única
  evidência de um commit remoto concluído e continua reabrível. Um destino
  preexistente nunca é substituído.
- A migração espacial v2 usa fingerprint estrito para evitar falso positivo.
  Um derivado do template que alterou campos não espaciais mas preservou as
  coordenadas históricas não é convertido automaticamente e exige revisão
  assistida, em vez de reinterpretar um documento genérico.

## Critérios de revisão

Revisar esta decisão se o editor suportar múltiplas janelas editando projetos
diferentes, se projetos forem hospedados em filesystems sem rename atômico ou
se surgir sincronização remota. Essas condições podem exigir locking e commit
distribuídos, mas não autorizam escrita por truncamento nem IDs inferidos pela
UI.
