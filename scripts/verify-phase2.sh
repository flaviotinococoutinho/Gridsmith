#!/usr/bin/env bash
# Validação ponta-a-ponta da Fase 2: o driver Node.js sobe o plano de controle,
# a engine .NET real conecta em modo serviço, e o plano de dados (memory-mapped
# file + seqlock + checksum FNV-1a) é verificado byte a byte entre os runtimes,
# usando o layout binário publicado pela própria engine via engine/describe.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPE_NAME="p7m-phase2-$$"
ENGINE_LOG="$(mktemp)"

cleanup() {
  if [[ -n "${ENGINE_PID:-}" ]] && kill -0 "$ENGINE_PID" 2>/dev/null; then
    kill "$ENGINE_PID" 2>/dev/null || true
    wait "$ENGINE_PID" 2>/dev/null || true
  fi
  rm -f "$ENGINE_LOG"
}
trap cleanup EXIT

echo "==> Building middleware"
(cd "$ROOT/middleware" && npm run --silent build)

echo "==> Building engine"
(cd "$ROOT/engine" && dotnet build --nologo -v quiet)

echo "==> Starting engine service (pipe: $PIPE_NAME)"
dotnet run --project "$ROOT/engine/src/P7m.Engine.Runtime" --no-build -- \
  --pipe "$PIPE_NAME" 2>"$ENGINE_LOG" &
ENGINE_PID=$!

echo "==> Running phase 2 driver (engine connects with retry/backoff)"
node "$ROOT/middleware/dist/tools/phase2-driver.js" --pipe "$PIPE_NAME"

echo "==> Engine log:"
sed 's/^/    /' "$ENGINE_LOG"

echo "PHASE 2 VERIFICATION PASSED"
