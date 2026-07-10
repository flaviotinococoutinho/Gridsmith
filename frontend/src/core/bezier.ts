/**
 * Easing por Bézier cúbica — o motor matemático do editor de curvas e das
 * transições de estado (escopo original: "curvas de Bézier cúbicas para
 * controle fino de aceleração e velocidade").
 *
 * Convenção CSS `cubic-bezier(x1, y1, x2, y2)`: âncoras fixas em (0,0) e
 * (1,1); x é o tempo normalizado e y o progresso. `evaluate(x)` resolve o
 * parâmetro t para o x dado (Newton-Raphson com fallback de bisseção — a
 * curva é monotônica em x porque x1,x2 ∈ [0,1]) e devolve y(t).
 *
 * Puro e sem alocações por chamada: seguro para rodar por frame no editor e
 * nos previews de transição.
 */

export class CubicBezierEasing {
  static readonly Linear = new CubicBezierEasing(0, 0, 1, 1);
  static readonly EaseIn = new CubicBezierEasing(0.42, 0, 1, 1);
  static readonly EaseOut = new CubicBezierEasing(0, 0, 0.58, 1);
  static readonly EaseInOut = new CubicBezierEasing(0.42, 0, 0.58, 1);

  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;

  constructor(x1: number, y1: number, x2: number, y2: number) {
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
      throw new RangeError(`x1 and x2 must be in [0, 1] for a monotonic time curve (got ${x1}, ${x2})`);
    }
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
  }

  /** Progresso y para o tempo normalizado x ∈ [0, 1] (clampado). */
  evaluate(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return this.sampleY(this.solveT(x));
  }

  /** Ponto (x, y) da curva para o parâmetro t — usado pelo editor para desenhar. */
  pointAt(t: number): { x: number; y: number } {
    return { x: this.sampleX(t), y: this.sampleY(t) };
  }

  /** Amostra a curva em N pontos igualmente espaçados em t (path do editor). */
  samplePath(samples: number): Array<{ x: number; y: number }> {
    if (!Number.isInteger(samples) || samples < 2) {
      throw new RangeError("samples must be an integer >= 2");
    }
    const path: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < samples; i++) {
      path.push(this.pointAt(i / (samples - 1)));
    }
    return path;
  }

  private sampleX(t: number): number {
    const inv = 1 - t;
    return 3 * inv * inv * t * this.x1 + 3 * inv * t * t * this.x2 + t * t * t;
  }

  private sampleY(t: number): number {
    const inv = 1 - t;
    return 3 * inv * inv * t * this.y1 + 3 * inv * t * t * this.y2 + t * t * t;
  }

  private sampleDxDt(t: number): number {
    const inv = 1 - t;
    return 3 * inv * inv * this.x1 + 6 * inv * t * (this.x2 - this.x1) + 3 * t * t * (1 - this.x2);
  }

  private solveT(x: number): number {
    // Newton-Raphson: converge em ~4 iterações para curvas bem-comportadas
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = this.sampleX(t) - x;
      if (Math.abs(error) < 1e-7) return t;
      const derivative = this.sampleDxDt(t);
      if (Math.abs(derivative) < 1e-6) break; // derivada ~0: cai para bisseção
      t -= error / derivative;
      if (t < 0 || t > 1) break;
    }

    // Bisseção: sempre converge (x(t) é monotônica)
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 32; i++) {
      const current = this.sampleX(t);
      if (Math.abs(current - x) < 1e-7) return t;
      if (current < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  }
}
