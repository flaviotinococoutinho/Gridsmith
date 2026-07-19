# Transport benchmark

Este benchmark mede somente os transports existentes do editor: gRPC,
GraphQL e o gateway JSON-RPC legado. Ele não cria um quarto transport, não
usa doubles de servidor e não inicia a engine. Cada fork sobe um processo real
e novo do middleware, executa a matriz e o encerra.

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
