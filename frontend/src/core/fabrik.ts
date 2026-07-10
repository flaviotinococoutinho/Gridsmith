/**
 * FABRIK — Forward And Backward Reaching Inverse Kinematics (2D).
 *
 * Solver interativo do editor de rigs (escopo original, Subsistema 1): o
 * usuário arrasta o alvo de IK e a cadeia de ossos resolve em tempo real.
 * Roda no worker de edição; apenas os keyframes resultantes viram Comandos
 * canônicos.
 *
 * Propriedades garantidas (e testadas):
 * - comprimentos de segmento preservados;
 * - raiz fixa na posição original;
 * - alvo alcançável → converge dentro da tolerância;
 * - alvo inalcançável → cadeia esticada na direção do alvo;
 * - determinístico: mesmas entradas, mesmo resultado.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface FabrikOptions {
  /** Distância aceitável entre efetuador e alvo. Default 0.01. */
  readonly tolerance?: number;
  /** Limite de iterações forward/backward. Default 16. */
  readonly maxIterations?: number;
}

export interface FabrikResult {
  /** Posições resolvidas das juntas (mesmo tamanho da entrada). */
  readonly joints: readonly Vec2[];
  /** true se o efetuador terminou dentro da tolerância. */
  readonly reached: boolean;
  readonly iterations: number;
}

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

const lerpTowards = (from: Vec2, to: Vec2, length: number): Vec2 => {
  const d = distance(from, to);
  if (d < 1e-9) return { x: from.x + length, y: from.y }; // degenerado: direção arbitrária estável
  const t = length / d;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
};

/**
 * Resolve a cadeia para o alvo. `joints` é a pose corrente da cadeia (raiz
 * primeiro); os comprimentos dos segmentos são medidos dela.
 */
export function solveFabrik(joints: readonly Vec2[], target: Vec2, options: FabrikOptions = {}): FabrikResult {
  if (joints.length < 2) {
    throw new RangeError("FABRIK requires a chain of at least 2 joints");
  }
  const tolerance = options.tolerance ?? 0.01;
  const maxIterations = options.maxIterations ?? 16;
  if (tolerance <= 0 || maxIterations < 1) {
    throw new RangeError("tolerance must be > 0 and maxIterations >= 1");
  }

  const lengths: number[] = [];
  let totalLength = 0;
  for (let i = 0; i < joints.length - 1; i++) {
    const len = distance(joints[i]!, joints[i + 1]!);
    if (len < 1e-9) {
      throw new RangeError(`Segment ${i} has zero length — joints must be distinct`);
    }
    lengths.push(len);
    totalLength += len;
  }

  const root = joints[0]!;
  const work: Vec2[] = joints.map((j) => ({ x: j.x, y: j.y }));

  // Alvo inalcançável: estica a cadeia na direção do alvo (uma passada)
  if (distance(root, target) > totalLength) {
    for (let i = 0; i < work.length - 1; i++) {
      work[i + 1] = lerpTowards(work[i]!, target, lengths[i]!);
    }
    return { joints: work, reached: false, iterations: 1 };
  }

  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;

    // FORWARD: âncora o efetuador no alvo e propaga em direção à raiz
    work[work.length - 1] = { x: target.x, y: target.y };
    for (let i = work.length - 2; i >= 0; i--) {
      work[i] = lerpTowards(work[i + 1]!, work[i]!, lengths[i]!);
    }

    // BACKWARD: re-âncora a raiz e propaga em direção ao efetuador
    work[0] = { x: root.x, y: root.y };
    for (let i = 0; i < work.length - 1; i++) {
      work[i + 1] = lerpTowards(work[i]!, work[i + 1]!, lengths[i]!);
    }

    if (distance(work[work.length - 1]!, target) <= tolerance) {
      return { joints: work, reached: true, iterations };
    }
  }

  return { joints: work, reached: distance(work[work.length - 1]!, target) <= tolerance, iterations };
}
