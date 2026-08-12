/**
 * Serviço de seleção (E10): a fonte ÚNICA do "o que está selecionado".
 *
 * Antes a seleção era uma variável local da vista de níveis
 * (`selectedEntityId` no closure) — nada fora dela conseguia saber o que o
 * usuário tinha em mãos, e por isso não existia inspector: não havia o que
 * inspecionar. A seleção sai do closure e vira estado observável do workbench.
 *
 * Módulo puro (regra F1).
 */

/**
 * Tipos selecionáveis. Fechado de propósito: uma seleção de tipo desconhecido
 * não teria seção de inspector nem comandos aplicáveis, e apareceria como uma
 * caixa vazia sem explicação.
 */
export type SelectionKind = "entity" | "level" | "light" | "camera" | "asset";

export interface Selection {
  readonly kind: SelectionKind;
  /** Ids selecionados, na ordem em que entraram; nunca vazio. */
  readonly ids: readonly string[];
  /**
   * Painel que originou a seleção. O inspector mostra a seção certa mesmo
   * quando o usuário troca de painel sem mexer na seleção.
   */
  readonly panelId?: string;
}

export class SelectionService {
  private selection: Selection | undefined;
  private readonly listeners = new Set<(selection: Selection | undefined) => void>();

  get current(): Selection | undefined {
    return this.selection;
  }

  /** Primeiro id da seleção — o que um inspector de item único mostra. */
  get primary(): string | undefined {
    return this.selection?.ids[0];
  }

  get isEmpty(): boolean {
    return this.selection === undefined;
  }

  /** Substitui a seleção. Lista vazia limpa (não existe seleção de zero itens). */
  select(kind: SelectionKind, ids: readonly string[], panelId?: string): void {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      this.clear();
      return;
    }
    const next: Selection = {
      kind,
      ids: unique,
      ...(panelId === undefined ? {} : { panelId }),
    };
    if (this.sameAs(next)) return;
    this.selection = next;
    this.notify();
  }

  /**
   * Adiciona ou remove um item mantendo o tipo. Trocar de tipo no meio de uma
   * seleção múltipla SUBSTITUI: uma seleção heterogênea não tem inspector que
   * a represente, e mostrar a interseção vazia seria pior que recomeçar.
   */
  toggle(kind: SelectionKind, id: string, panelId?: string): void {
    if (!this.selection || this.selection.kind !== kind) {
      this.select(kind, [id], panelId);
      return;
    }
    const ids = this.selection.ids.includes(id)
      ? this.selection.ids.filter((existing) => existing !== id)
      : [...this.selection.ids, id];
    this.select(kind, ids, panelId ?? this.selection.panelId);
  }

  clear(): void {
    if (this.selection === undefined) return;
    this.selection = undefined;
    this.notify();
  }

  /**
   * Remove ids que deixaram de existir (a entidade foi apagada, o nível
   * removido). Sem isso o inspector continuaria mostrando um objeto morto.
   */
  retain(existing: (id: string) => boolean): void {
    if (!this.selection) return;
    const kept = this.selection.ids.filter(existing);
    if (kept.length === this.selection.ids.length) return;
    this.select(this.selection.kind, kept, this.selection.panelId);
  }

  onChange(listener: (selection: Selection | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private sameAs(next: Selection): boolean {
    const current = this.selection;
    return (
      current !== undefined &&
      current.kind === next.kind &&
      current.panelId === next.panelId &&
      current.ids.length === next.ids.length &&
      current.ids.every((id, index) => id === next.ids[index])
    );
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.selection);
  }
}
