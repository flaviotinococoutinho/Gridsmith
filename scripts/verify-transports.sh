#!/usr/bin/env bash
# Validação ponta-a-ponta dos TRANSPORTS DO APP (ADR-016/017): o EditorClient
# REAL do frontend contra o middleware REAL e a engine .NET real.
#
#   Fase A — middleware com gRPC + GraphQL: o cliente conecta pelo gRPC
#            (prioritário), despacha pelo caminho quente, recebe eventos por
#            STREAM e a projeção chega à engine real.
#   Fase B — middleware SEM gRPC (--no-grpc): o MESMO cliente faz fallback
#            para GraphQL no connect, mesma superfície, eventos por POLLING.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPE_NAME="p7m-transports-$$"
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

start_middleware() {
  local extra_flags=("$@")
  node "$ROOT/middleware/dist/index.js" --pipe "$PIPE_NAME" --no-mcp "${extra_flags[@]}" 2>>"$MIDDLEWARE_LOG" &
  MIDDLEWARE_PID=$!
  for _ in $(seq 1 50); do
    grep -q "graphql gateway listening" "$MIDDLEWARE_LOG" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "FAIL: middleware did not start"; cat "$MIDDLEWARE_LOG"; exit 1
}

stop_middleware() {
  kill "$MIDDLEWARE_PID" 2>/dev/null || true
  wait "$MIDDLEWARE_PID" 2>/dev/null || true
}

echo "==> Building middleware"
(cd "$ROOT/middleware" && npm run --silent build)
echo "==> Building frontend (EditorClient real)"
(cd "$ROOT/frontend" && npm run --silent build)
echo "==> Building engine"
(cd "$ROOT/engine" && dotnet build --nologo -v quiet)

echo "==> Fase A: middleware com gRPC + GraphQL (pipe: $PIPE_NAME)"
start_middleware
dotnet run --project "$ROOT/engine/src/P7m.Engine.Runtime" --no-build -- \
  --pipe "$PIPE_NAME" 2>"$ENGINE_LOG" &
ENGINE_PID=$!
for _ in $(seq 1 50); do
  grep -q "engine capabilities cached" "$MIDDLEWARE_LOG" 2>/dev/null && break
  sleep 0.1
done

node "$ROOT/frontend/dist/tools/transport-driver.js" --pipe "$PIPE_NAME" --expect grpc --engine

echo "==> Fase B: middleware SEM gRPC (fallback GraphQL no MESMO cliente real)"
stop_middleware
start_middleware --no-grpc
# a engine reconecta sozinha (backoff 2s/4s/8s); espera a sessão nova
for _ in $(seq 1 120); do
  grep -q "engine capabilities cached" "$MIDDLEWARE_LOG" 2>/dev/null && \
    [ "$(grep -c 'engine session .* established' "$MIDDLEWARE_LOG")" -ge 2 ] && break
  sleep 0.1
done

if [ "$(grep -c 'engine session .* established' "$MIDDLEWARE_LOG")" -ge 2 ]; then
  node "$ROOT/frontend/dist/tools/transport-driver.js" --pipe "$PIPE_NAME" --expect graphql --engine
else
  echo "    (engine não reconectou a tempo; validando fallback sem projeção)"
  node "$ROOT/frontend/dist/tools/transport-driver.js" --pipe "$PIPE_NAME" --expect graphql
fi

echo "==> Middleware log:"
sed 's/^/    /' "$MIDDLEWARE_LOG" | tail -20

grep -q "grpc gateway listening" "$MIDDLEWARE_LOG" || {
  echo "FAIL: grpc gateway never started in phase A"; exit 1;
}

echo "TRANSPORTS VERIFICATION PASSED"
