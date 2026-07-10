import assert from "node:assert/strict";
import { test } from "node:test";
import { CubicBezierEasing } from "../src/core/bezier.js";

test("curva linear é a identidade", () => {
  const linear = CubicBezierEasing.Linear;
  for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    assert.ok(Math.abs(linear.evaluate(x) - x) < 1e-6, `evaluate(${x})`);
  }
});

test("extremos são exatos e entradas fora da faixa clampam", () => {
  const ease = CubicBezierEasing.EaseInOut;
  assert.equal(ease.evaluate(0), 0);
  assert.equal(ease.evaluate(1), 1);
  assert.equal(ease.evaluate(-5), 0);
  assert.equal(ease.evaluate(5), 1);
});

test("ease-in começa devagar; ease-out começa rápido", () => {
  assert.ok(CubicBezierEasing.EaseIn.evaluate(0.25) < 0.25);
  assert.ok(CubicBezierEasing.EaseOut.evaluate(0.25) > 0.25);
});

test("evaluate é monotônico para curvas de easing típicas", () => {
  const curves = [
    CubicBezierEasing.EaseIn,
    CubicBezierEasing.EaseOut,
    CubicBezierEasing.EaseInOut,
    new CubicBezierEasing(0.7, 0.1, 0.3, 0.9),
  ];
  for (const curve of curves) {
    let previous = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const y = curve.evaluate(i / 100);
      assert.ok(y >= previous - 1e-9, `monotonic at ${i / 100}`);
      previous = y;
    }
  }
});

test("solver inverte sampleX com precisão (roundtrip x → t → x)", () => {
  const curve = new CubicBezierEasing(0.17, 0.67, 0.83, 0.27);
  for (let i = 1; i < 20; i++) {
    const t = i / 20;
    const { x, y } = curve.pointAt(t);
    assert.ok(Math.abs(curve.evaluate(x) - y) < 1e-4, `roundtrip at t=${t}`);
  }
});

test("overshoot é permitido em y (curvas tipo back/elastic)", () => {
  const back = new CubicBezierEasing(0.34, 1.56, 0.64, 1); // easeOutBack
  let max = 0;
  for (let i = 0; i <= 100; i++) {
    max = Math.max(max, back.evaluate(i / 100));
  }
  assert.ok(max > 1.05, `expected overshoot above 1 (got ${max})`);
  assert.equal(back.evaluate(1), 1);
});

test("x1/x2 fora de [0,1] são rejeitados e samplePath valida", () => {
  assert.throws(() => new CubicBezierEasing(-0.1, 0, 1, 1), RangeError);
  assert.throws(() => new CubicBezierEasing(0, 0, 1.5, 1), RangeError);
  assert.throws(() => CubicBezierEasing.Linear.samplePath(1), RangeError);
  const path = CubicBezierEasing.EaseIn.samplePath(11);
  assert.equal(path.length, 11);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path[10], { x: 1, y: 1 });
});
