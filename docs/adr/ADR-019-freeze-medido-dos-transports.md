# ADR-019 — Freeze medido dos transports do editor

- **Status:** Accepted · **Data:** 2026-07-19
- **Escopo:** gRPC, GraphQL e gateway JSON-RPC legado na borda app ↔ middleware
- **Evidência:** [`benchmarks/results/2026-07-19-github-ubuntu.json`](../../benchmarks/results/2026-07-19-github-ubuntu.json)
- **Harness:** `frontend/src/tools/transport-benchmark.ts`, `scripts/benchmark-transports.sh`
- **Decisões relacionadas:** ADR-016, ADR-017 e ADR-018

## Contexto

A introdução de gRPC prioritário com fallback GraphQL criou custo operacional
que só se justifica por ganho mensurável ou por uma necessidade concreta de
streaming. A camada precisa ser encerrada para que o trabalho volte ao MVP do
editor, sem um quarto transport nem uma alegação genérica de que gRPC é mais
rápido.

O gateway JSON-RPC legado ainda atende scripts e clientes existentes. Sua
presença na medição serve para acompanhar compatibilidade; não o transforma em
candidato a novo default.

## Critério objetivo de manutenção

O gRPC **permanece default** somente enquanto uma execução oficial válida
satisfizer simultaneamente:

1. `dispatch` com p95 pelo menos **20% menor que GraphQL** nos payloads
   `small` e `medium`;
2. p95 de `event-flow` (`latencyMs.p95`) sem regressão maior que **10%** em
   nenhum dos dois payloads;
3. zero erro, zero evento perdido/duplicado e zero ressincronização nos
   cenários gRPC de `dispatch` e `event-flow`.

Se qualquer condição falhar, gRPC deixa de ser default e permanece atrás da
feature flag existente até o PreviewHost fornecer uma necessidade concreta de
streaming. GraphQL continua sendo o baseline completo em qualquer resultado.
Uma mudança do default exige novo relatório versionado; números locais
diagnósticos não substituem a execução oficial.

## Metodologia e proveniência

O relatório oficial foi produzido no GitHub Actions para o head da branch
`0d4a5cc4aee44a4420daa63594819ff61a0d5479`. O checkout do job era o merge
efêmero `53200ffd32bc1d76c05320a5f561468cdfec854a`, que é o valor registrado no
JSON; ele não é apresentado como head da branch. O runner usou Linux x64
(`6.17.0-1020-azure`), Node `v22.23.1`, V8 `12.4.254.21-node.56`, CPU AMD EPYC
7763 (2 CPUs lógicas disponíveis) e 8.32 GB de memória. O relatório está
marcado `valid: true` e o worktree medido estava limpo.

- três forks, cada um com processo real e novo do middleware;
- 20 warmups e 100 amostras por operação e fork, concorrência 1;
- payload canônico pequeno de 141 bytes e médio de 2.159 bytes;
- fluxo de 1.000 eventos por fork, com polling GraphQL fixo em 10 ms;
- percentis nearest-rank sobre as chamadas bem-sucedidas dos três forks;
- engine não iniciada, isolando a borda de transport e o caminho canônico;
- implementações de produção de gRPC e GraphQL e `EditorGateway` real no
  legado, sem doubles de servidor.

`applicationPayloadBytes` mede o JSON canônico UTF-8, não bytes no fio. Os
números abaixo descrevem esse runner e essa configuração; não são uma promessa
universal para outra máquina ou carga concorrente.

## Resultado completo

Latências em milissegundos; vazão em operações por segundo. Cada linha de
chamada agrega 300 amostras, exceto `event-flow`, que agrega 3.000 dispatches.

| Transport | Payload | Operação | p50 | p95 | p99 | ops/s |
|---|---|---|---:|---:|---:|---:|
| gRPC | small | dispatch | 0,875 | 1,511 | 2,968 | 1.009,623 |
| gRPC | small | event-flow | 0,762 | 1,359 | 3,969 | 1.107,265 |
| gRPC | small | query-small | 0,632 | 1,257 | 3,284 | 1.286,020 |
| gRPC | small | query-document | 0,633 | 1,140 | 2,384 | 1.309,994 |
| gRPC | medium | dispatch | 0,913 | 1,765 | 2,734 | 899,319 |
| gRPC | medium | event-flow | 0,943 | 2,063 | 4,591 | 879,363 |
| gRPC | medium | query-small | 0,622 | 3,212 | 6,439 | 1.010,987 |
| gRPC | medium | query-document | 0,621 | 2,407 | 5,778 | 1.139,440 |
| GraphQL | small | dispatch | 0,920 | 2,333 | 3,543 | 911,524 |
| GraphQL | small | event-flow | 0,803 | 1,962 | 3,466 | 1.019,645 |
| GraphQL | small | query-small | 0,664 | 1,078 | 3,233 | 1.291,772 |
| GraphQL | small | query-document | 0,616 | 0,923 | 2,531 | 1.426,362 |
| GraphQL | medium | dispatch | 0,955 | 2,907 | 6,269 | 749,138 |
| GraphQL | medium | event-flow | 0,940 | 2,472 | 3,977 | 842,210 |
| GraphQL | medium | query-small | 0,656 | 0,913 | 2,047 | 1.394,622 |
| GraphQL | medium | query-document | 0,618 | 1,132 | 1,862 | 1.401,808 |
| JSON-RPC legado | small | dispatch | 0,175 | 0,246 | 0,275 | 5.106,681 |
| JSON-RPC legado | small | event-flow | 0,183 | 0,302 | 0,501 | 4.762,490 |
| JSON-RPC legado | small | query-small | 0,121 | 0,172 | 1,224 | 6.120,190 |
| JSON-RPC legado | small | query-document | 0,121 | 0,176 | 0,190 | 7.096,960 |
| JSON-RPC legado | medium | dispatch | 0,249 | 0,339 | 0,397 | 3.615,423 |
| JSON-RPC legado | medium | event-flow | 0,264 | 0,399 | 0,899 | 3.213,451 |
| JSON-RPC legado | medium | query-small | 0,116 | 0,132 | 0,148 | 8.082,984 |
| JSON-RPC legado | medium | query-document | 0,149 | 0,291 | 2,163 | 4.078,578 |

Conclusão do fluxo completo de eventos, também em milissegundos:

| Transport | Payload | conclusão p50 | conclusão p95 | conclusão p99 | eventos/s |
|---|---|---:|---:|---:|---:|
| gRPC | small | 835,426 | 1.068,801 | 1.068,801 | 1.107,408 |
| gRPC | medium | 1.161,122 | 1.228,877 | 1.228,877 | 879,497 |
| GraphQL | small | 996,441 | 1.103,700 | 1.103,700 | 1.016,558 |
| GraphQL | medium | 1.123,635 | 1.376,992 | 1.376,992 | 838,150 |
| JSON-RPC legado | small | 207,262 | 264,593 | 264,593 | 4.763,075 |
| JSON-RPC legado | medium | 298,577 | 343,716 | 343,716 | 3.212,869 |

## Leitura objetiva

- Em `dispatch`, gRPC reduz o p95 contra GraphQL em **35,2%** no payload
  pequeno (`1,511` vs `2,333` ms) e **39,3%** no médio (`1,765` vs
  `2,907` ms). Os dois casos passam o limiar de 20%.
- Em `event-flow`, gRPC reduz o p95 de cada dispatch do fluxo em **30,8%** no
  payload pequeno e **16,5%** no médio. A conclusão p95 dos 1.000 eventos
  também não regride: `1.068,801` vs `1.103,700` ms e `1.228,877` vs
  `1.376,992` ms.
- Os 6.000 eventos esperados nos cenários gRPC foram recebidos, sem erro,
  perda, duplicidade ou resync. O relatório inteiro também registrou zero
  falha e zero resync nos 24 cenários.
- gRPC **regride queries** no p95 contra GraphQL: `query-small` +16,6%
  (`small`) e +251,8% (`medium`); `query-document` +23,5% (`small`) e
  +112,6% (`medium`). Esta ADR não alega vantagem de gRPC para queries.
- O gateway legado teve menor p50 e p95 nas oito combinações
  payload×operação, mas não venceu todos os percentis: em
  `query-document/medium`, seu p99 foi `2,163` ms contra `1,862` ms do
  GraphQL. Além disso, `resyncObservable` é `false` nesse caminho e ele
  permanece contrato de compatibilidade. A sua latência não compensa trocar o
  baseline tipado nem criar nova promoção.

## Decisão

1. **Manter gRPC como default congelado para dispatch e entrega de eventos.**
   O ganho medido satisfaz o critério acima e o server streaming é usado pelo
   fluxo vivo do editor.
2. **Manter GraphQL como baseline completo e fallback.** Nenhuma operação do
   editor pode existir apenas em gRPC.
3. **Aceitar e monitorar a regressão de query sem criar roteamento por operação
   nesta estabilização.** O `TransportRouter` escolhe um transport ativo para o
   cliente inteiro; portanto, `Query` também usa gRPC enquanto ele está ativo.
   Isso é um risco explícito, não uma alegação de performance.
4. **Manter o gateway JSON-RPC legado somente por compatibilidade** enquanto
   scripts ou clientes dependerem dele. Não promovê-lo e não removê-lo sem
   inventário de dependentes e migração.
5. **Congelar a camada:** nenhum novo transport e nenhuma expansão funcional
   até uma condição de revisão abaixo ocorrer.

## Consequências, riscos e revisão

- Há custo de duas superfícies do app, mitigado por ambas delegarem à mesma
  `EditorSurface` e por GraphQL permanecer completo.
- Os percentis de query do gRPC, especialmente com documento médio, são o
  principal risco mensurável. Uma otimização futura precisa preservar os
  contratos existentes e demonstrar novo relatório; não autoriza um transport
  adicional.
- Três forks num único tipo de runner não medem variância entre CPUs, Windows,
  macOS ou concorrência. Repetir o mesmo perfil antes de mudar o default e
  executar perfis de plataforma como diagnóstico quando o empacotamento os
  tornar disponíveis.
- Revisar a decisão se: (a) qualquer limiar objetivo falhar; (b) a implementação
  de transport, framing, polling ou autenticação mudar materialmente; (c) o
  padrão real de queries se tornar gargalo do MVP; ou (d) antes do PreviewHost.
- Ausência de dependentes do gateway legado precisa ser provada por inventário
  de scripts/clientes antes de propor sua remoção.
