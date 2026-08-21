#!/usr/bin/env bash
# Paridade visual (ADR-022): o editor e a engine compõem o MESMO frame?
#
# O driver Node resolve o IntGrid pelo AutoTiler real (o papel do adapter),
# compõe a lista de quads com o espelho puro do editor e grava o cenário
# RESOLVIDO; o Runtime headless compõe a mesma lista via FrameComposer
# (--describe-frame — Core puro, sem GPU, sem janela). As duas descrições são
# comparadas BYTE a BYTE: sem tolerância, qualquer divergência de culling,
# ordem do pintor, âncora ou formato é um diff visível — nunca "ficou
# parecido". O que o host desenha É essa lista; verificada a lista, o desenho
# é só rasterização (conferida localmente, fora do gate — custo aceito e
# registrado na ADR-022).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$OUT_DIR"
}
trap cleanup EXIT

echo "==> Building middleware (AutoTiler + espelho do editor)"
(cd "$ROOT/middleware" && npm run build >/dev/null)

echo "==> Compondo o frame do lado do EDITOR"
(cd "$ROOT/frontend" && npx tsx src/tools/parity-driver.ts --out-dir "$OUT_DIR")

echo "==> Compondo o frame do lado da ENGINE (FrameComposer, headless)"
(cd "$ROOT/engine" && dotnet run --project src/Gridsmith.Engine.Runtime -- \
  --describe-frame "$OUT_DIR/scenario.json") > "$OUT_DIR/engine-frame.txt"

echo "==> Comparando as descrições byte a byte"
if ! diff -u "$OUT_DIR/editor-frame.txt" "$OUT_DIR/engine-frame.txt"; then
  echo "VISUAL PARITY VERIFICATION FAILED: o editor e a engine descrevem frames diferentes" >&2
  exit 1
fi

QUADS="$(head -1 "$OUT_DIR/editor-frame.txt")"
echo "    [assert    ] descrições idênticas ($QUADS)"
echo "VISUAL PARITY VERIFICATION PASSED"
