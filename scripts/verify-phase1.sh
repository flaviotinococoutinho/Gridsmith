#!/usr/bin/env bash
# Validação ponta-a-ponta da Fase 1: sobe o middleware Node.js real, conecta o
# host da engine .NET real e prova o fluxo JSON-RPC 2.0 bidirecional sobre o
# canal IPC (Named Pipe no Windows, Unix Domain Socket no Linux/macOS).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIPE_NAME="p7m-verify-$$"
MIDDLEWARE_LOG="$(mktemp)"
export P7M_EDITOR_AUTH_TOKEN="${P7M_EDITOR_AUTH_TOKEN:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')}"

cleanup() {
  if [[ -n "${MIDDLEWARE_PID:-}" ]] && kill -0 "$MIDDLEWARE_PID" 2>/dev/null; then
    kill "$MIDDLEWARE_PID" 2>/dev/null || true
    wait "$MIDDLEWARE_PID" 2>/dev/null || true
  fi
  rm -f "$MIDDLEWARE_LOG"
}
trap cleanup EXIT

echo "==> Building middleware"
(cd "$ROOT/middleware" && npm run --silent build)

echo "==> Building engine"
(cd "$ROOT/engine" && dotnet build --nologo -v quiet)

echo "==> Starting middleware pipe server (pipe: $PIPE_NAME)"
node "$ROOT/middleware/dist/index.js" --pipe "$PIPE_NAME" --no-mcp 2>"$MIDDLEWARE_LOG" &
MIDDLEWARE_PID=$!

# Aguarda o endpoint subir
for _ in $(seq 1 50); do
  if grep -q "control-plane endpoint listening" "$MIDDLEWARE_LOG" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
grep -q "control-plane endpoint listening" "$MIDDLEWARE_LOG" || {
  echo "FAIL: middleware did not start"; cat "$MIDDLEWARE_LOG"; exit 1;
}

echo "==> Running engine self-test against live middleware"
dotnet run --project "$ROOT/engine/src/P7m.Engine.Runtime" --no-build -- \
  --pipe "$PIPE_NAME" --self-test

echo "==> Middleware log:"
sed 's/^/    /' "$MIDDLEWARE_LOG"

# O middleware deve ter registrado a sessão e o welcome ping bem-sucedido
grep -q "engine session .* established: P7m.Engine.Runtime" "$MIDDLEWARE_LOG" || {
  echo "FAIL: middleware never registered the engine session"; exit 1;
}
grep -q 'welcome ping ok (echo "welcome")' "$MIDDLEWARE_LOG" || {
  echo "FAIL: middleware→engine welcome ping did not complete"; exit 1;
}

echo "PHASE 1 VERIFICATION PASSED"
