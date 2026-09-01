/**
 * Um GESTO de pintura e o comando canônico que ele vira (frente F6).
 *
 * Antes disto o editor tinha duas verdades: o `IntGridDocument` local, com
 * pilha de undo própria, e o documento do projeto — que só recebia o grid
 * quando alguém clicava "Publicar nível". Pintar não sujava o projeto, o
 * Ctrl+Z desfazia no rascunho e o histórico canônico não sabia da ação mais
 * frequente do editor. Aqui a pincelada passa a ser um comando.
 *
 * Por que um acumulador, e não um comando por célula: uma pincelada de arrasto
 * toca dezenas de células a 60 Hz. Despachar cada uma inundaria o histórico
 * (um item de desfazer por célula) e o diário de eventos. O gesto inteiro vira
 * UM `level/patch` com um `transactionId` — que é exatamente o agrupamento que
 * a E9 preparou no `CommandHistory`.
 *
 * A regra de coalescência tem uma razão de correção, não de economia: o
 * domínio recusa o patch quando o `before` de uma célula não bate com o que
 * ele tem (é assim que ele percebe que o cliente pintou sobre leitura velha).
 * Se uma célula é tocada duas vezes no MESMO gesto, o `before` que o servidor
 * conhece é o da PRIMEIRA vez; o `after` que vale é o da última. Guardar o
 * `before` da segunda passada faria o servidor recusar um gesto legítimo.
 *
 * Módulo puro (regra F1).
 */

import type { CellChange } from "./intGridDocument.js";

/**
 * Acumula as células tocadas por um gesto, preservando o `before` original de
 * cada uma. Célula que volta ao valor de origem dentro do próprio gesto SAI do
 * lote: pintar e apagar a mesma célula numa pincelada não é uma edição.
 */
export class PaintGesture {
  private readonly touched = new Map<number, { before: number; after: number }>();

  record(changes: readonly CellChange[]): void {
    for (const change of changes) {
      const existing = this.touched.get(change.index);
      if (existing) {
        existing.after = change.after; // o before original é preservado
      } else {
        this.touched.set(change.index, { before: change.before, after: change.after });
      }
    }
  }

  get isEmpty(): boolean {
    return this.changes().length === 0;
  }

  /** Lote final, sem no-ops e em ordem de índice (payload determinístico). */
  changes(): readonly CellChange[] {
    const changes: CellChange[] = [];
    for (const [index, cell] of this.touched) {
      if (cell.before === cell.after) continue;
      changes.push({ index, before: cell.before, after: cell.after });
    }
    return changes.sort((a, b) => a.index - b.index);
  }
}

export interface GestureCommand {
  readonly kind: "level/patch" | "level/define";
  readonly payload: Record<string, unknown>;
}

export interface GesturePlanOptions {
  readonly levelId: string;
  /** Identifica o gesto; é o que o histórico usa para coalescer (E9). */
  readonly transactionId: string;
  readonly changes: readonly CellChange[];
  /** O nível já existe no Blueprint? `level/patch` exige que sim. */
  readonly levelInBlueprint: boolean;
  /** Payload de `level/define`, calculado só quando for preciso criar. */
  readonly definePayload: () => Record<string, unknown>;
}

/**
 * Traduz um gesto no comando canônico a despachar.
 *
 * Duas decisões vivem aqui, e as duas são de correção:
 *
 * - **Gesto sem mudança não vira comando.** Um clique que repinta o valor que
 *   já estava lá criaria um item de histórico que não desfaz nada — e o
 *   domínio recusa `changes` vazio, então despachar seria erro garantido.
 * - **Nível ainda não publicado nasce com `level/define`.** `level/patch`
 *   exige um nível existente; sem este ramo, a primeira pincelada de um
 *   projeto novo falharia e a pintura voltaria a ser local até alguém clicar
 *   "Publicar". O gesto carrega o grid inteiro nesse primeiro comando.
 */
export function planGestureCommand(options: GesturePlanOptions): GestureCommand | undefined {
  if (options.changes.length === 0) return undefined;
  if (!options.levelInBlueprint) {
    return {
      kind: "level/define",
      payload: { ...options.definePayload(), transactionId: options.transactionId },
    };
  }
  return {
    kind: "level/patch",
    payload: {
      levelId: options.levelId,
      changes: options.changes.map((change) => ({ ...change })),
      transactionId: options.transactionId,
    },
  };
}

/**
 * Guarda a sequência de um gesto próprio, com teto.
 *
 * O conjunto só encolhe quando o evento correspondente chega. Se ele nunca
 * chegar (stream caído, sessão trocada), uma sessão longa de pintura acumula
 * uma string por pincelada para sempre. O teto descarta a mais antiga: perder
 * um perdão velho custa uma reidratação a mais, e é o lado barato do erro.
 */
export function rememberOwnSequence(sequences: Set<string>, sequence: string, cap = 256): void {
  sequences.add(sequence);
  while (sequences.size > cap) {
    const oldest = sequences.values().next();
    if (oldest.done === true) return;
    sequences.delete(oldest.value);
  }
}

/** Kinds de evento que mudam o grid de um nível — quem os vê deve reidratar. */
const LEVEL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "levelDefined",
  "levelUpdated",
  "levelPatched",
  "levelRemoved",
]);

/**
 * O evento exige reidratar o canvas?
 *
 * `ownSequences` são os gestos que ESTA vista despachou: o canvas já mostra o
 * resultado deles, e reconsultar o projeto a cada pincelada faria o editor
 * piscar a cada traço. O que precisa chegar é o que veio de FORA — o desfazer
 * canônico, um agente, outra borda.
 */
export function shouldRehydrate(
  eventKind: string,
  commandSequence: string,
  ownSequences: Set<string>,
): boolean {
  if (!LEVEL_EVENT_KINDS.has(eventKind)) return false;
  // consome: a mesma sequência nunca chega duas vezes, e deixá-la no conjunto
  // faria um evento externo futuro herdar o perdão de um gesto antigo
  if (ownSequences.delete(commandSequence)) return false;
  return true;
}
