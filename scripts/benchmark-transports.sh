#!/usr/bin/env bash
# Benchmark dos transports reais do editor. O driver sobe um middleware novo
# por fork e grava um JSON auditável em benchmarks/results/ (ou --output).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# O benchmark sempre entrega o segredo ao middleware e aos clientes pelo
# ambiente. Quando o chamador não fornece um, gera um token efêmero apenas para
# esta execução; ele nunca é escrito no relatório ou na linha de comando.
if [[ -z "${P7M_EDITOR_AUTH_TOKEN:-}" ]]; then
  export P7M_EDITOR_AUTH_TOKEN
  P7M_EDITOR_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
fi
# Este runner tem uma fonte única e explícita: o ambiente direto.
unset P7M_EDITOR_AUTH_TOKEN_FILE

echo "==> Building middleware"
(cd "$ROOT/middleware" && npm run --silent build)

echo "==> Building frontend benchmark"
(cd "$ROOT/frontend" && npm run --silent build)

echo "==> Running real transport matrix"
export P7M_BENCH_ROOT="$ROOT"
cd "$ROOT"
node "$ROOT/frontend/dist/tools/transport-benchmark.js" "$@"
