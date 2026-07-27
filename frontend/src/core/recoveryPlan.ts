/**
 * Recuperação de autosave (etapa E2) — o NÚCLEO da decisão.
 *
 * O autosave grava um sidecar `.autosave` ao lado do projeto. Se o editor cair
 * entre dois saves, esse sidecar é a única cópia do trabalho recente. Até aqui
 * ele era gravado e nunca lido: o trabalho existia no disco e ninguém o
 * oferecia de volta.
 *
 * Este módulo decide o que fazer com a recuperação; o diálogo nativo e o
 * sistema de arquivos ficam no `main`. Puro e testável.
 *
 * REGRA CENTRAL: o sidecar só é apagado depois de um **save confirmado** ou de
 * um **descarte explícito** do usuário. Nunca por abrir, nunca por ignorar em
 * silêncio — apagar cedo é perder trabalho sem pedir licença.
 */

export type RecoveryDecision = "restore" | "copy" | "ignore" | "cancel";

export interface RecoveryPlan {
  /** Prosseguir com a abertura; `false` aborta sem tocar no ciclo de vida. */
  readonly proceed: boolean;
  /** De onde ler o documento a abrir. */
  readonly source: "autosave" | "original";
  /**
   * Vincular a sessão ao arquivo original. Em `copy` fica `false`: a sessão
   * nasce sem caminho, então o primeiro Salvar vira "Salvar como" e o projeto
   * original permanece intocado.
   */
  readonly bindToFile: boolean;
  /** Apagar o sidecar agora (só no descarte explícito). */
  readonly discardAutosave: boolean;
  /**
   * Abrir com alterações não salvas. Restaurar traz conteúdo que nunca foi
   * gravado no arquivo: marcar limpo faria o usuário fechar e perder de novo.
   */
  readonly openDirty: boolean;
  /** Mensagem para a barra de status; vazia quando não há o que dizer. */
  readonly notice: string;
}

const PLANS: Readonly<Record<RecoveryDecision, RecoveryPlan>> = {
  restore: {
    proceed: true,
    source: "autosave",
    bindToFile: true,
    discardAutosave: false,
    openDirty: true,
    notice: "Recuperação restaurada — salve para gravar no arquivo do projeto.",
  },
  copy: {
    proceed: true,
    source: "autosave",
    bindToFile: false,
    discardAutosave: false,
    openDirty: true,
    notice: "Cópia da recuperação aberta — o projeto original não foi alterado.",
  },
  ignore: {
    proceed: true,
    source: "original",
    bindToFile: true,
    discardAutosave: true,
    openDirty: false,
    notice: "Recuperação descartada; o projeto salvo foi aberto.",
  },
  cancel: {
    proceed: false,
    source: "original",
    bindToFile: true,
    discardAutosave: false,
    openDirty: false,
    notice: "",
  },
};

/** Plano para a decisão do usuário diante de uma recuperação disponível. */
export function planRecovery(decision: RecoveryDecision): RecoveryPlan {
  return PLANS[decision] ?? PLANS.cancel;
}

/** Abertura sem recuperação pendente: segue direto, sem tocar no sidecar. */
export function planWithoutRecovery(): RecoveryPlan {
  return {
    proceed: true,
    source: "original",
    bindToFile: true,
    discardAutosave: false,
    openDirty: false,
    notice: "",
  };
}
