/**
 * Curva de timeline com keyframes e easing Bézier por segmento — o modelo do
 * editor de curvas (escopo original: "curvas de Bézier cúbicas para controle
 * fino de aceleração e velocidade dos quadros-chave").
 *
 * Cada keyframe carrega o easing do segmento que SAI dele (keyframe → próximo).
 * `evaluate(t)` clampa nas extremidades — comportamento padrão de samplers de
 * animação. Puro e determinístico; roda no worker do editor de curvas e no
 * preview de transições da VisualStateMachine.
 */

import { CubicBezierEasing } from "./bezier.js";

export interface Keyframe {
  readonly timeMs: number;
  readonly value: number;
  /** Easing do segmento que sai deste keyframe. Default: linear. */
  readonly easing: CubicBezierEasing;
}

export interface KeyframeInput {
  readonly timeMs: number;
  readonly value: number;
  readonly easing?: CubicBezierEasing;
}

export class TimelineCurve {
  private keys: Keyframe[] = [];

  get keyframes(): readonly Keyframe[] {
    return this.keys;
  }

  get durationMs(): number {
    return this.keys.length === 0 ? 0 : this.keys.at(-1)!.timeMs;
  }

  /** Insere mantendo a ordenação por tempo. Tempos duplicados são rejeitados. */
  addKeyframe(input: KeyframeInput): this {
    if (!Number.isFinite(input.timeMs) || input.timeMs < 0) {
      throw new RangeError(`timeMs must be a non-negative finite number (got ${input.timeMs})`);
    }
    if (!Number.isFinite(input.value)) {
      throw new RangeError("value must be a finite number");
    }
    if (this.keys.some((k) => k.timeMs === input.timeMs)) {
      throw new Error(`A keyframe already exists at ${input.timeMs}ms — move it instead`);
    }
    this.keys.push({
      timeMs: input.timeMs,
      value: input.value,
      easing: input.easing ?? CubicBezierEasing.Linear,
    });
    this.keys.sort((a, b) => a.timeMs - b.timeMs);
    return this;
  }

  removeKeyframe(timeMs: number): this {
    const index = this.keys.findIndex((k) => k.timeMs === timeMs);
    if (index < 0) {
      throw new Error(`No keyframe at ${timeMs}ms`);
    }
    this.keys.splice(index, 1);
    return this;
  }

  /** Move/edita um keyframe (drag no editor). Re-ordena se o tempo mudou. */
  moveKeyframe(
    timeMs: number,
    changes: { timeMs?: number; value?: number; easing?: CubicBezierEasing },
  ): this {
    const index = this.keys.findIndex((k) => k.timeMs === timeMs);
    if (index < 0) {
      throw new Error(`No keyframe at ${timeMs}ms`);
    }
    const target = changes.timeMs ?? timeMs;
    if (target !== timeMs && this.keys.some((k) => k.timeMs === target)) {
      throw new Error(`A keyframe already exists at ${target}ms`);
    }
    const current = this.keys[index]!;
    this.keys[index] = {
      timeMs: target,
      value: changes.value ?? current.value,
      easing: changes.easing ?? current.easing,
    };
    this.keys.sort((a, b) => a.timeMs - b.timeMs);
    return this;
  }

  /** Valor da curva em t (ms). Clampa antes do primeiro e após o último keyframe. */
  evaluate(timeMs: number): number {
    if (this.keys.length === 0) {
      throw new Error("Cannot evaluate an empty curve");
    }
    const first = this.keys[0]!;
    const last = this.keys.at(-1)!;
    if (timeMs <= first.timeMs) return first.value;
    if (timeMs >= last.timeMs) return last.value;

    // busca binária do segmento que contém t
    let lo = 0;
    let hi = this.keys.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid]!.timeMs <= timeMs) lo = mid;
      else hi = mid;
    }

    const from = this.keys[lo]!;
    const to = this.keys[hi]!;
    const t = (timeMs - from.timeMs) / (to.timeMs - from.timeMs);
    return from.value + (to.value - from.value) * from.easing.evaluate(t);
  }

  /** Amostra uniforme para desenhar a curva no canvas do editor. */
  sample(samples: number): Array<{ timeMs: number; value: number }> {
    if (!Number.isInteger(samples) || samples < 2) {
      throw new RangeError("samples must be an integer >= 2");
    }
    if (this.keys.length === 0) {
      throw new Error("Cannot sample an empty curve");
    }
    const start = this.keys[0]!.timeMs;
    const span = this.durationMs - start;
    const points: Array<{ timeMs: number; value: number }> = [];
    for (let i = 0; i < samples; i++) {
      const timeMs = start + (span * i) / (samples - 1);
      points.push({ timeMs, value: this.evaluate(timeMs) });
    }
    return points;
  }
}
