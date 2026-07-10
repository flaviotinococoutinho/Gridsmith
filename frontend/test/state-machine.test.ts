import assert from "node:assert/strict";
import { test } from "node:test";
import { CubicBezierEasing } from "../src/core/bezier.js";
import { VisualStateMachine } from "../src/core/stateMachine.js";

function buttonMachine(): VisualStateMachine {
  return new VisualStateMachine()
    .addState({ name: "enabled", assignments: { alpha: 1, scale: 1, labelColor: "#ffffff", clickable: true } })
    .addState({ name: "disabled", assignments: { alpha: 0.4, scale: 0.95, labelColor: "#777777", clickable: false } })
    .addState({ name: "highlighted", assignments: { alpha: 1, scale: 1.1 } });
}

test("estado é um conjunto nomeado de atribuições: instanciar aplica tudo", () => {
  const instance = buttonMachine().instantiate("enabled");
  assert.deepEqual(instance.properties, { alpha: 1, scale: 1, labelColor: "#ffffff", clickable: true });
  assert.equal(instance.state, "enabled");
});

test("transição instantânea (default) aplica o alvo imediatamente", () => {
  const instance = buttonMachine().instantiate("enabled");
  instance.setState("disabled");
  assert.equal(instance.properties["alpha"], 0.4);
  assert.equal(instance.properties["clickable"], false);
  assert.equal(instance.transition, undefined);
});

test("numéricos interpolam com easing; discretos aplicam no início", () => {
  const machine = buttonMachine().setDefaultTransition({
    durationMs: 100,
    easing: CubicBezierEasing.Linear,
  });
  const instance = machine.instantiate("enabled");
  instance.setState("disabled");

  // discretos: já valem no início da transição
  assert.equal(instance.properties["clickable"], false);
  assert.equal(instance.properties["labelColor"], "#777777");
  // numéricos: ainda no valor de partida
  assert.equal(instance.properties["alpha"], 1);

  instance.update(50); // metade, easing linear
  assert.ok(Math.abs((instance.properties["alpha"] as number) - 0.7) < 1e-6);
  assert.ok(Math.abs((instance.properties["scale"] as number) - 0.975) < 1e-6);

  const completed = instance.update(50);
  assert.equal(completed?.done, true);
  assert.equal(completed?.from, "enabled");
  assert.equal(completed?.to, "disabled");
  assert.equal(instance.properties["alpha"], 0.4);
});

test("easing Bézier governa a curva da interpolação", () => {
  const easing = CubicBezierEasing.EaseIn;
  const machine = buttonMachine().setDefaultTransition({ durationMs: 100, easing });
  const instance = machine.instantiate("enabled");
  instance.setState("disabled"); // alpha 1 → 0.4

  instance.update(25);
  const expected = 1 + (0.4 - 1) * easing.evaluate(0.25);
  assert.ok(Math.abs((instance.properties["alpha"] as number) - expected) < 1e-6);
});

test("interromper transição no meio parte dos valores correntes (interrupt-safe)", () => {
  const machine = buttonMachine().setDefaultTransition({
    durationMs: 100,
    easing: CubicBezierEasing.Linear,
  });
  const instance = machine.instantiate("enabled");
  instance.setState("disabled");
  instance.update(50); // alpha = 0.7

  instance.setState("highlighted"); // interrompe: 0.7 → 1
  instance.update(50);
  assert.ok(Math.abs((instance.properties["alpha"] as number) - 0.85) < 1e-6);
  instance.update(50);
  assert.equal(instance.properties["alpha"], 1);
  assert.equal(instance.properties["scale"], 1.1);
  // propriedade não tocada pelo estado novo permanece do estado anterior
  assert.equal(instance.properties["clickable"], false);
});

test("transição por par sobrepõe a default e status expõe progresso", () => {
  const machine = buttonMachine()
    .setDefaultTransition({ durationMs: 1000, easing: CubicBezierEasing.Linear })
    .setTransition("enabled", "highlighted", { durationMs: 50, easing: CubicBezierEasing.Linear });
  const instance = machine.instantiate("enabled");
  instance.setState("highlighted");

  instance.update(25);
  assert.equal(instance.transition?.progress, 0.5);
  instance.update(25);
  assert.equal(instance.transition, undefined);
});

test("estado desconhecido e nome duplicado são rejeitados", () => {
  const machine = buttonMachine();
  assert.throws(() => machine.getState("nope"), /Unknown state/);
  assert.throws(() => machine.addState({ name: "enabled", assignments: {} }), /already defined/);
  assert.throws(() => machine.instantiate("ghost"), /Unknown state/);
});
