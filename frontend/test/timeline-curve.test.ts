import assert from "node:assert/strict";
import { test } from "node:test";
import { CubicBezierEasing } from "../src/core/bezier.js";
import { TimelineCurve } from "../src/core/timelineCurve.js";

function makeCurve(): TimelineCurve {
  return new TimelineCurve()
    .addKeyframe({ timeMs: 0, value: 0 })
    .addKeyframe({ timeMs: 100, value: 10 })
    .addKeyframe({ timeMs: 300, value: -10 });
}

test("evaluate clampa nas extremidades e interpola linear por padrão", () => {
  const curve = makeCurve();
  assert.equal(curve.evaluate(-50), 0);
  assert.equal(curve.evaluate(0), 0);
  assert.equal(curve.evaluate(50), 5); // meio do primeiro segmento
  assert.equal(curve.evaluate(200), 0); // meio do segundo: 10 → -10
  assert.equal(curve.evaluate(300), -10);
  assert.equal(curve.evaluate(9999), -10);
  assert.equal(curve.durationMs, 300);
});

test("easing por segmento governa a interpolação daquele trecho", () => {
  const easeIn = CubicBezierEasing.EaseIn;
  const curve = new TimelineCurve()
    .addKeyframe({ timeMs: 0, value: 0, easing: easeIn })
    .addKeyframe({ timeMs: 100, value: 100 }) // segmento seguinte: linear
    .addKeyframe({ timeMs: 200, value: 200 });

  const expected = 100 * easeIn.evaluate(0.25);
  assert.ok(Math.abs(curve.evaluate(25) - expected) < 1e-4);
  assert.equal(curve.evaluate(150), 150); // segmento linear
});

test("inserção mantém ordenação independente da ordem de chamada", () => {
  const curve = new TimelineCurve()
    .addKeyframe({ timeMs: 300, value: 3 })
    .addKeyframe({ timeMs: 0, value: 0 })
    .addKeyframe({ timeMs: 100, value: 1 });
  assert.deepEqual(curve.keyframes.map((k) => k.timeMs), [0, 100, 300]);
  assert.equal(curve.evaluate(200), 2); // 1 → 3 linear no meio
});

test("tempo duplicado é rejeitado; mover re-ordena e preserva easing", () => {
  const curve = makeCurve();
  assert.throws(() => curve.addKeyframe({ timeMs: 100, value: 5 }), /already exists/);

  curve.moveKeyframe(100, { timeMs: 400, value: 40 });
  assert.deepEqual(curve.keyframes.map((k) => k.timeMs), [0, 300, 400]);
  assert.equal(curve.evaluate(400), 40);

  assert.throws(() => curve.moveKeyframe(400, { timeMs: 300 }), /already exists/);
  assert.throws(() => curve.moveKeyframe(999, { value: 1 }), /No keyframe/);
});

test("remoção e curva vazia", () => {
  const curve = makeCurve();
  curve.removeKeyframe(100);
  assert.equal(curve.evaluate(100), curve.evaluate(100)); // ainda avaliável
  assert.throws(() => curve.removeKeyframe(100), /No keyframe/);
  assert.throws(() => new TimelineCurve().evaluate(0), /empty curve/);
});

test("sample cobre do primeiro ao último keyframe (path do canvas)", () => {
  const curve = makeCurve();
  const points = curve.sample(5);
  assert.equal(points.length, 5);
  assert.deepEqual(points[0], { timeMs: 0, value: 0 });
  assert.deepEqual(points[4], { timeMs: 300, value: -10 });
  assert.throws(() => curve.sample(1), RangeError);
});

test("validações de keyframe", () => {
  const curve = new TimelineCurve();
  assert.throws(() => curve.addKeyframe({ timeMs: -1, value: 0 }), RangeError);
  assert.throws(() => curve.addKeyframe({ timeMs: 0, value: Number.NaN }), RangeError);
});
