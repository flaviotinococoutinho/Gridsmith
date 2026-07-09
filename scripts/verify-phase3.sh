#!/usr/bin/env bash
# Validação ponta-a-ponta da Fase 3: com a engine .NET real conectada ao
# driver Node.js, verifica a física da câmera (convergência, overshoot,
# determinismo, shake limitado com decaimento) e a equação de iluminação do
# shader através de uma reimplementação TypeScript independente.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPE_NAME="p7m-phase3-$$"
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

echo "==> Running phase 3 driver"
node "$ROOT/middleware/dist/tools/phase3-driver.js" --pipe "$PIPE_NAME"

echo "PHASE 3 VERIFICATION PASSED"
