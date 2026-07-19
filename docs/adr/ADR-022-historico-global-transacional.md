# ADR-022 — Histórico global transacional e projeção otimista

- **Status:** Accepted · **Data:** 2026-07-19
- **Código:** [`CommandHistory.ts`](../../middleware/src/canonical/CommandHistory.ts), [`ProjectSessionManager.ts`](../../middleware/src/canonical/ProjectSessionManager.ts), [`BlueprintStore.ts`](../../middleware/src/domain/BlueprintStore.ts), [`intGridDocument.ts`](../../frontend/src/core/intGridDocument.ts)
- **Contratos:** [`editor.schema.graphql`](../../contracts/graphql/editor.schema.graphql), [`p7m_editor.proto`](../../contracts/grpc/p7m_editor.proto), [`blueprint.commands.schema.json`](../../contracts/schemas/blueprint.commands.schema.json), [`blueprint.document.schema.json`](../../contracts/schemas/blueprint.document.schema.json), [`command-history.schema.json`](../../contracts/schemas/command-history.schema.json)

## Contexto

O IntGrid mantinha um estado e duas pilhas locais. Blueprint, runtime, dirty e
autosave só recebiam o nível quando o usuário acionava “Publicar nível”, por
meio de um `level/update` com o grid completo. Trocar de painel descartava o
contexto de undo; Save e Close podiam observar um documento diferente daquele
exibido. Entidades em drag também permaneciam na posição otimista quando o
comando era rejeitado.

O `CommandHistory` da sessão era apenas um log append-only usado como relógio.
Usar esse mesmo relógio como cursor de undo seria incorreto: undo e redo também
produzem eventos e devem incrementar `commandSequence`, embora possam retornar
o documento exatamente a um savepoint anterior.

## Decisão

Toda edição persistente passa imediatamente pelo caminho canônico. O IntGrid é
uma projeção local otimista: um gesto agrega mudanças por índice, preserva o
primeiro `before` e o último `after`, aplica o resultado na tela e despacha um
único `level/patch`. O ack confirma a camada; uma rejeição de domínio a remove e
recompõe a projeção. Falha de disponibilidade é tratada como resultado incerto
até que retry idempotente, evento ou resync confirme o desfecho.

Cada sessão possui um histórico com entradas imutáveis:

```ts
interface HistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly forward: BlueprintCommand[];
  readonly inverse: BlueprintCommand[];
  readonly actor: "human" | "agent" | "pipeline";
  readonly transactionId: string;
  readonly timestamp: number;
  readonly barrier?: boolean;
}
```

`commandSequence` permanece um relógio monotônico de commit/evento e continua
a proteger CAS e EventJournal. `documentStateId` identifica a posição lógica
do documento e é comparado ao savepoint pelo dirty tracking. Editar depois de
undo invalida o futuro. Coalescing ocorre somente dentro de uma transação
explícita e compatível, nunca por timeout. Replay de Open/Template estabelece
um baseline não desfazível.

Inversos são calculados no middleware, sobre o comando já filtrado e o estado
canônico anterior. `level/patch` valida nível, índices únicos, faixa, valores e
todos os `before` antes de alterar uma célula. Place/remove/move de entidade,
add/remove/update de luz, câmera, world placement, propriedades e paleta têm
inversos explícitos. Comandos ainda sem operação inversa — como bind de mesh —
geram barreira; o sistema não a atravessa nem a apresenta como reversível.

Undo e redo são operações da sessão, não command kinds. JSON-RPC, GraphQL,
gRPC e MCP delegam à mesma `EditorSurface`. A borda atribui proveniência:
transports do aplicativo usam `human` e MCP usa `agent`; uma pipeline interna
que emita comando live deve passar `pipeline` explicitamente. Replay não recebe
ator de histórico porque apenas estabelece o baseline, sem entrada reversível.
O ator recebido em payload nunca é confiado. Eventos de execução, undo e redo
carregam sessão, projeto, sequência, transação, ator, entrada de histórico,
ação e `documentStateId`.

O runtime é uma consequência recuperável do Blueprint. Cada evento de undo ou
redo passa por hooks e projeção. Falha externa deixa a sessão `deferred` e a
reconexão usa `rehydrateFrom` sobre somente o estado canônico ativo.

## Escrita, autosave e gestos

Save, Save As, Close, autosave, undo e redo não capturam um gesto aberto. A
fronteira Electron aguarda sua confirmação ou cancelamento explícito. Depois do
ack, o mesmo evento que atualiza clientes e runtime avança dirty/autosave. Ctrl+S
serializa o Blueprint confirmado que corresponde à projeção exibida.

“Publicar nível” deixa de ser uma etapa de persistência. A ação equivalente é
“Recalcular arte”, que apenas recalcula a projeção derivada pelo AutoTiler.

## Alternativas rejeitadas

1. **Snapshot completo por gesto/undo** — aumenta memória e custo, mascara
   conflitos por célula e transforma operações pequenas em substituições do
   documento.
2. **Histórico somente no renderer** — não converge entre clientes, agentes e
   transports e não pode atualizar runtime, dirty ou autosave com autoridade.
3. **Usar `commandSequence` como cursor/savepoint** — undo sempre avança a
   sequência e jamais poderia voltar ao estado clean.
4. **Reexecutar filtros sobre inversos gravados** — o forward já foi filtrado;
   transformar novamente seu inverso pode quebrar atomicidade. Validação do
   domínio, eventos, hooks pós-commit e runtime continuam canônicos.
5. **Fingir inverso para comandos irreversíveis** — uma barreira explícita é
   mais segura e observável do que um rollback parcial.

## Consequências

- Uma linha, um retângulo, um balde, um pincel contínuo e um drag geram uma
  transação e uma entrada humana.
- Dois clientes observam o mesmo resultado e o mesmo cursor; não existe pilha
  privada por painel.
- Undo de agente conserva proveniência e label da entrada original.
- O documento persiste o estado final, não as pilhas de undo/redo.
- O formato v4 adiciona a paleta do nível com migração determinística de v3,
  preservando os três significados oferecidos pelo editor antigo e quaisquer
  valores customizados já usados;
  o histórico permanece efêmero e isolado por `ProjectSession`.

## Critérios de revisão

Revisar o batching se uma única transação passar a combinar comandos de
domínios independentes ou se colaboração remota exigir transações longas.
Nenhuma revisão autoriza eventos parciais, snapshot completo como operação
normal de undo ou uma segunda fonte de verdade no renderer.
