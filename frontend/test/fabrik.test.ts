import assert from "node:assert/strict";
import { test } from "node:test";
import { solveFabrik, type Vec2 } from "../src/core/fabrik.js";

const CHAIN: Vec2[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 20, y: 0 },
  { x: 30, y: 0 },
];

function segmentLengths(joints: readonly Vec2[]): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < joints.length - 1; i++) {
    lengths.push(Math.hypot(joints[i + 1]!.x - joints[i]!.x, joints[i + 1]!.y - joints[i]!.y));
  }
  return lengths;
}

test("alvo alcançável: efetuador converge e a raiz permanece fixa", () => {
  const target = { x: 15, y: 12 };
  const result = solveFabrik(CHAIN, target, { tolerance: 0.01 });

  assert.equal(result.reached, true);
  const effector = result.joints.at(-1)!;
  assert.ok(Math.hypot(effector.x - target.x, effector.y - target.y) <= 0.01);
  assert.deepEqual(result.joints[0], { x: 0, y: 0 });
});

test("comprimentos de segmento são preservados", () => {
  const result = solveFabrik(CHAIN, { x: 8, y: 18 });
  const lengths = segmentLengths(result.joints);
  for (const length of lengths) {
    assert.ok(Math.abs(length - 10) < 1e-4, `segment length ${length}`);
  }
});

test("alvo inalcançável: cadeia estica na direção do alvo", () => {
  const target = { x: 100, y: 0 }; // além do alcance total (30)
  const result = solveFabrik(CHAIN, target);

  assert.equal(result.reached, false);
  const effector = result.joints.at(-1)!;
  // efetuador na extensão máxima, na direção do alvo
  assert.ok(Math.abs(effector.x - 30) < 1e-6);
  assert.ok(Math.abs(effector.y) < 1e-6);
  for (const length of segmentLengths(result.joints)) {
    assert.ok(Math.abs(length - 10) < 1e-6);
  }
});

test("determinismo e limite de iterações respeitado", () => {
  const target = { x: 12, y: 9 };
  const a = solveFabrik(CHAIN, target, { maxIterations: 16 });
  const b = solveFabrik(CHAIN, target, { maxIterations: 16 });
  assert.deepEqual(a, b);

  const limited = solveFabrik(CHAIN, target, { maxIterations: 1 });
  assert.ok(limited.iterations <= 1);
});

test("um único osso rígido: aponta para o alvo mantendo o comprimento", () => {
  // Um osso de comprimento 5 só ALCANÇA pontos a exatamente 5 da raiz; para
  // um alvo mais próximo ele deve apontar na direção do alvo, sem encolher.
  const result = solveFabrik([{ x: 0, y: 0 }, { x: 5, y: 0 }], { x: 0, y: 3 });
  const effector = result.joints[1]!;
  assert.equal(result.reached, false);
  assert.ok(Math.abs(Math.hypot(effector.x, effector.y) - 5) < 1e-6, "length preserved");
  assert.ok(Math.abs(effector.x) < 1e-6 && effector.y > 0, "points toward the target");
});

test("validações: cadeia curta, segmento nulo, opções inválidas", () => {
  assert.throws(() => solveFabrik([{ x: 0, y: 0 }], { x: 1, y: 1 }), RangeError);
  assert.throws(
    () => solveFabrik([{ x: 0, y: 0 }, { x: 0, y: 0 }], { x: 1, y: 1 }),
    /zero length/,
  );
  assert.throws(() => solveFabrik(CHAIN, { x: 1, y: 1 }, { tolerance: 0 }), RangeError);
});
