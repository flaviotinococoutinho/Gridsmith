/**
 * Vocabulário das CONTRIBUIÇÕES do workbench (E10).
 *
 * A casca do editor deixou de conhecer os seus painéis: cada capacidade
 * (painel, comando, ferramenta, seção de inspector) se DECLARA como uma
 * contribuição, e a casca só materializa o que os registros lhe entregam.
 * Antes o rail era uma lista literal no renderer e cada vista instalava os
 * próprios atalhos — era isso que fazia o Ctrl+Z ter dois donos.
 *
 * Módulo puro (regra F1): sem DOM, sem Electron, sem Node.
 */

/**
 * O que uma contribuição EXIGE para habilitar. Os dois eixos são distintos de
 * propósito: `requires` é governança de runtime (perfil/manifesto vivo) e
 * `requiresProject` é fato de sessão. Fundi-los perderia a origem da razão,
 * que a UI promete nunca genericizar.
 */
export interface Requirement {
  /** Recursos governados; a contribuição habilita sse TODOS estiverem ativos. */
  readonly requires: readonly string[];
  /** Exige projeto aberto. Default de quem edita; `false` só para o que é global. */
  readonly requiresProject: boolean;
}

/** Base de toda contribuição: identidade, rótulo humano e ordem de exibição. */
export interface Contribution extends Requirement {
  readonly id: string;
  /**
   * Rótulo humano em pt-BR. É o próprio rótulo, não uma chave: o vocabulário
   * traduz IDs de catálogos fechados (eventos, estados), mas contribuição é
   * conteúdo aberto — quem contribui nomeia.
   */
  readonly label: string;
  /** Ordem crescente dentro do grupo; empate desempata pelo id (estável). */
  readonly order: number;
}

/** De onde veio a razão de um "desabilitado" — a UI mostra a razão, o teste checa a origem. */
export type ReasonOrigin =
  /** A governança de runtime (perfil ou manifesto vivo) negou. */
  | "governance"
  /** A sessão negou: não há projeto aberto. */
  | "session"
  /** Nada foi resolvido ainda, ou o recurso não é conhecido: fail-safe. */
  | "fail-safe";

export interface CapabilityAnswer {
  readonly enabled: boolean;
  /** Sempre preenchida quando `enabled` é falso; nunca um genérico "indisponível". */
  readonly reason: string;
  readonly origin: ReasonOrigin;
}

/** Ordenação canônica de contribuições: `order`, e o id como desempate estável. */
export function byOrder<T extends Contribution>(a: T, b: T): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Registro genérico com identidade única. Registrar o mesmo id duas vezes é
 * ERRO, não "o último vence": duas contribuições disputando um id significa
 * que uma delas some sem aviso — exatamente a classe de bug que o registro
 * existe para eliminar.
 */
export class ContributionConflictError extends Error {
  constructor(kind: string, id: string) {
    super(`já existe ${kind} com o id "${id}"`);
    this.name = "ContributionConflictError";
  }
}

export class ContributionRegistry<T extends Contribution> {
  private readonly items = new Map<string, T>();

  /** `kind` aparece na mensagem do conflito ("já existe painel com o id ..."). */
  constructor(private readonly kind: string) {}

  register(contribution: T): T {
    if (this.items.has(contribution.id)) {
      throw new ContributionConflictError(this.kind, contribution.id);
    }
    this.items.set(contribution.id, contribution);
    return contribution;
  }

  registerAll(contributions: Iterable<T>): void {
    for (const contribution of contributions) this.register(contribution);
  }

  /**
   * Remove uma contribuição. Existe porque contribuição pode ser de VIDA
   * CURTA: um painel montado contribui os seus comandos e os devolve ao ser
   * desmontado. Sem isso, remontar o mesmo painel bateria no conflito de id —
   * e a alternativa (deixar o último vencer) é justamente o que permitia dois
   * donos do mesmo atalho.
   */
  unregister(id: string): boolean {
    return this.items.delete(id);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  get size(): number {
    return this.items.size;
  }

  /** Todas as contribuições em ordem canônica — habilitadas ou não. */
  all(): readonly T[] {
    return [...this.items.values()].sort(byOrder);
  }
}
