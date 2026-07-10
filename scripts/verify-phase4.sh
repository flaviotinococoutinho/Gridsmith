#!/usr/bin/env bash
# Validação ponta-a-ponta da Fase 4 (fundação do editor): sobe o middleware
# REAL (canal da engine + gateway do editor), conecta a engine .NET real e um
# cliente de edição, e prova o dispatch canônico com projeção na engine,
# broadcast de eventos e a experiência governada por perfil de runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPE_NAME="p7m-phase4-$$"
MIDDLEWARE_LOG="$(mktemp)"
ENGINE_LOG="$(mktemp)"

cleanup() {
  for pid in "${ENGINE_PID:-}" "${MIDDLEWARE_PID:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$MIDDLEWARE_LOG" "$ENGINE_LOG"
}
trap cleanup EXIT

echo "==> Building middleware"
(cd "$ROOT/middleware" && npm run --silent build)

echo "==> Building engine"
(cd "$ROOT/engine" && dotnet build --nologo -v quiet)

echo "==> Starting middleware (engine channel + editor gateway; pipe: $PIPE_NAME)"
node "$ROOT/middleware/dist/index.js" --pipe "$PIPE_NAME" --no-mcp 2>"$MIDDLEWARE_LOG" &
MIDDLEWARE_PID=$!
for _ in $(seq 1 50); do
  grep -q "editor gateway listening" "$MIDDLEWARE_LOG" 2>/dev/null && break
  sleep 0.1
done
grep -q "editor gateway listening" "$MIDDLEWARE_LOG" || {
  echo "FAIL: middleware did not start"; cat "$MIDDLEWARE_LOG"; exit 1;
}

echo "==> Starting engine service"
dotnet run --project "$ROOT/engine/src/P7m.Engine.Runtime" --no-build -- \
  --pipe "$PIPE_NAME" 2>"$ENGINE_LOG" &
ENGINE_PID=$!

echo "==> Running phase 4 driver (editor client)"
node "$ROOT/middleware/dist/tools/phase4-driver.js" --pipe "$PIPE_NAME"

echo "==> Middleware log:"
sed 's/^/    /' "$MIDDLEWARE_LOG"

grep -q "editor session .* established: phase4-driver" "$MIDDLEWARE_LOG" || {
  echo "FAIL: middleware never registered the editor session"; exit 1;
}

echo "PHASE 4 VERIFICATION PASSED"
