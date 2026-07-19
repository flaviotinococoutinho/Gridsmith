# Transport benchmark

Este benchmark mede somente os transports existentes do editor: gRPC,
GraphQL e o gateway JSON-RPC legado. Ele não cria um quarto transport, não
usa doubles de servidor e não inicia a engine. Cada fork sobe um processo real
e novo do middleware, executa a matriz e o encerra.

## Baseline oficial e decisão

O baseline oficial de 2026-07-19 está versionado em
[`results/2026-07-19-github-ubuntu.json`](./results/2026-07-19-github-ubuntu.json)
e a leitura completa está na
[`ADR-019`](../docs/adr/ADR-019-freeze-medido-dos-transports.md). O relatório
é válido, foi produzido no GitHub Actions com três forks e registrou zero erro,
perda de evento ou resync.

| Comparação p95 | small | medium | Decisão |
|---|---:|---:|---|
| gRPC dispatch vs GraphQL | 1,511 vs 2,333 ms (-35,2%) | 1,765 vs 2,907 ms (-39,3%) | passa o limiar de -20% nos dois payloads |
| gRPC event-flow vs GraphQL | 1,359 vs 1,962 ms (-30,8%) | 2,063 vs 2,472 ms (-16,5%) | não regride |
| gRPC query-small vs GraphQL | 1,257 vs 1,078 ms (+16,6%) | 3,212 vs 0,913 ms (+251,8%) | regressão registrada |
| gRPC query-document vs GraphQL | 1,140 vs 0,923 ms (+23,5%) | 2,407 vs 1,132 ms (+112,6%) | regressão registrada |

O gRPC permanece default congelado por causa do ganho mensurável em dispatch e
eventos, não por uma alegação geral de superioridade. GraphQL permanece o
baseline completo. O gateway legado teve menor p50/p95 nas oito combinações
payload×operação; isso não vale para todo p99 (por exemplo,
`query-document/medium`). Ele continua somente para compatibilidade enquanto
houver dependentes e não será promovido.

## Execução

Na raiz do repositório:

```bash
npm run benchmark:transports
```

O script compila middleware e frontend, gera um token efêmero em
`P7M_EDITOR_AUTH_TOKEN` quando ele não foi fornecido e imprime o caminho do
relatório JSON. Para escolher o destino:

```bash
npm run benchmark:transports -- --output /tmp/p7m-transport-benchmark.json
```

Defaults de medição:

- 3 forks, cada um com middleware novo;
- 20 warmups e 100 amostras por chamada;
- concorrência 1 (latência sem carga concorrente);
- fluxo de exatamente 1.000 eventos por transport e classe de payload;
- polling GraphQL de eventos a cada 10 ms durante o teste de vazão;
- timeout de request de 10 s e de conclusão de fluxo de 30 s.

Os defaults podem ser alterados apenas para experimentos diagnósticos:

| Variável | Default | Efeito |
|---|---:|---|
| `P7M_BENCH_FORKS` | 3 | Processos independentes do middleware |
| `P7M_BENCH_WARMUPS` | 20 | Chamadas descartadas antes da medição |
| `P7M_BENCH_SAMPLES` | 100 | Chamadas medidas por operação e fork |
| `P7M_BENCH_CONCURRENCY` | 1 | Chamadas simultâneas por worker pool |
| `P7M_BENCH_EVENT_COUNT` | 1000 | Eventos do fluxo; relatório oficial deve manter 1000 |
| `P7M_BENCH_GRAPHQL_POLL_MS` | 10 | Intervalo explícito do consumidor GraphQL |
| `P7M_BENCH_REQUEST_TIMEOUT_MS` | 10000 | Deadline por chamada |
| `P7M_BENCH_FLOW_TIMEOUT_MS` | 30000 | Deadline para receber todos os eventos |

## Matriz e semântica

Cada transport executa, com payload pequeno e médio:

1. `level/update` (dispatch canônico);
2. consulta pequena da projeção `camera`;
3. consulta da projeção `document`;
4. dispatch e conclusão da entrega de 1.000 eventos `levelUpdated`.

Os dois payloads são `LevelSpec` válidos e determinísticos (grades 4×4 e
32×32). O relatório inclui o JSON canônico completo, SHA-256 e o número exato
de bytes UTF-8. `applicationPayloadBytes` não pretende ser tamanho no fio:
framing protobuf/HTTP/JSON-RPC, headers e compressão exigiriam captura de IPC
específica de plataforma. Declarar essa estimativa como medição seria falso.

Latências p50, p95 e p99 usam nearest-rank sobre todas as chamadas bem
sucedidas dos forks. O relatório também registra throughput, bytes das respostas
desserializadas, conclusão e vazão de eventos, erros e resyncs. Em transports
legados sem sinal de resync, `resyncObservable` é `false`; zero nessa coluna não
é apresentado como prova de continuidade.

O arquivo deve validar contra
[`transport-benchmark.schema.json`](./transport-benchmark.schema.json). Um run
com erro, perda/duplicidade de eventos ou resync é gravado com `valid: false` e
termina com exit code diferente de zero.

Uma repetição só pode sustentar o default gRPC se `dispatch` mantiver p95 pelo
menos 20% menor que GraphQL nos dois payloads, `event-flow` não regredir mais de
10% e não houver erro, perda ou resync. Falhar em qualquer condição rebaixa
gRPC à feature flag até o PreviewHost; a regra normativa está na ADR-019.
