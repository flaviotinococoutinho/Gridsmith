/**
 * Catálogo de erros acionáveis do editor (frente F5).
 *
 * Toda falha que chega ao usuário passa por aqui e sai como **causa + ação**
 * em pt-BR — nunca como mensagem técnica crua em inglês. O núcleo é PURO
 * (sem Electron, sem Node, sem rede): recebe o erro já normalizado em texto e
 * devolve o que a UI deve mostrar.
 *
 * A fonte dos códigos é `contracts/schemas/error-codes.md` (faixa de domínio
 * -32000..-32099) mais os códigos padrão do JSON-RPC 2.0. Código desconhecido
 * NÃO é engolido: vira uma entrada genérica que preserva o texto original,
 * para o usuário poder reportar e o desenvolvedor reconhecer.
 */

export interface ErrorPresentation {
  /** Título curto, imperativo ou descritivo — cabe em um banner. */
  readonly title: string;
  /** Por que aconteceu, em linguagem de usuário. */
  readonly cause: string;
  /** O que fazer agora. Sempre acionável. */
  readonly action: string;
  /** Mensagem técnica original, para diagnóstico (nunca some). */
  readonly detail?: string;
}

interface CatalogEntry {
  readonly title: string;
  readonly cause: string;
  readonly action: string;
}

/** Códigos JSON-RPC (padrão + faixa de domínio do P7M). */
export const ERROR_CATALOG: Readonly<Record<number, CatalogEntry>> = {
  [-32700]: {
    title: "Mensagem corrompida",
    cause: "Os serviços do P7M trocaram uma mensagem que não pôde ser lida.",
    action: "Reinicie os serviços pela barra de status. Se repetir, reporte com o log da Saída.",
  },
  [-32600]: {
    title: "Requisição inválida",
    cause: "O editor enviou uma mensagem fora do protocolo esperado.",
    action: "Atualize a instalação do P7M — editor e serviços podem estar em versões diferentes.",
  },
  [-32601]: {
    title: "Operação não disponível",
    cause: "Os serviços em execução não conhecem esta operação.",
    action: "Atualize a instalação inteira do P7M para alinhar editor e serviços.",
  },
  [-32602]: {
    title: "Dados inválidos",
    cause: "Os valores enviados não passaram na validação do modelo canônico.",
    action: "Revise os campos destacados e tente novamente.",
  },
  [-32603]: {
    title: "Falha interna dos serviços",
    cause: "Um erro não previsto ocorreu no middleware.",
    action: "Reinicie os serviços pela barra de status; o trabalho salvo não é afetado.",
  },
  [-32000]: {
    title: "Runtime não está pronto",
    cause: "A engine ainda não terminou de iniciar ou não está conectada.",
    action: "Aguarde a engine ficar em execução na barra de status; o comando fica pendente até lá.",
  },
  [-32001]: {
    title: "Versões incompatíveis",
    cause: "As versões do editor e dos serviços P7M são incompatíveis.",
    action: "Atualize a instalação inteira do P7M e abra o aplicativo novamente.",
  },
  [-32002]: {
    title: "Esqueleto desconhecido",
    cause: "O esqueleto referenciado não existe mais na sessão do runtime.",
    action: "Reabra o projeto para reidratar o runtime a partir do documento.",
  },
  [-32003]: {
    title: "Malha desconhecida",
    cause: "A malha referenciada não existe mais na sessão do runtime.",
    action: "Reabra o projeto para reidratar o runtime a partir do documento.",
  },
  [-32004]: {
    title: "Memória compartilhada indisponível",
    cause: "O canal de dados em massa com a engine não pôde ser aberto.",
    action: "Reinicie a engine pela barra de status.",
  },
  [-32005]: {
    title: "Layout binário incompatível",
    cause: "Editor e engine discordam do formato binário dos dados de malha.",
    action: "Atualize a instalação inteira do P7M — os dois lados precisam da mesma versão.",
  },
  [-32006]: {
    title: "Identificador já existe",
    cause: "Já existe um objeto com este identificador no projeto.",
    action: "Escolha outro nome ou edite o objeto existente.",
  },
  [-32007]: {
    title: "Falha de autenticação local",
    cause: "O editor não conseguiu provar identidade para os serviços locais.",
    action: "Reinicie o aplicativo. Se repetir, reinicie os serviços pela barra de status.",
  },
  [-32008]: {
    title: "Nenhum projeto aberto",
    cause: "A operação exige um projeto ativo e nenhum está aberto.",
    action: "Crie um projeto novo ou abra um existente e repita a operação.",
  },
  [-32009]: {
    title: "O projeto mudou durante a operação",
    cause: "Outro fluxo trocou a sessão de projeto antes desta operação terminar.",
    action: "Confira qual projeto está aberto na barra de status e repita a operação.",
  },
};

const GENERIC: CatalogEntry = {
  title: "Não foi possível concluir a operação",
  cause: "Os serviços do P7M recusaram a operação.",
  action: "Tente novamente. Se repetir, veja a aba Saída para o detalhe técnico.",
};

/**
 * Extrai o código JSON-RPC de uma mensagem de erro. As bordas anexam o código
 * ao texto: o GraphQL em `extensions.code` (que o cliente concatena como
 * `(code -32008)`) e o gRPC em `details` (`(código -32008)`).
 */
export function extractErrorCode(message: string): number | undefined {
  const match = /\(c[oó]d(?:e|igo)\s+(-?\d{4,5})\)/i.exec(message);
  if (match?.[1] === undefined) return undefined;
  const code = Number.parseInt(match[1], 10);
  return Number.isFinite(code) ? code : undefined;
}

/** Remove o sufixo `(code -32008)` que só serve para diagnóstico. */
function stripCode(message: string): string {
  return message.replace(/\s*\(c[oó]d(?:e|igo)\s+-?\d{4,5}\)\s*$/i, "").trim();
}

/**
 * Traduz um erro em apresentação acionável. Aceita o objeto de erro, uma
 * string ou qualquer valor — nunca lança, porque roda no caminho de exibição
 * de falha (um erro aqui deixaria o usuário sem nenhuma mensagem).
 */
export function presentError(error: unknown, explicitCode?: number): ErrorPresentation {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error === undefined || error === null
          ? ""
          : String(error);
  const code = explicitCode ?? extractErrorCode(raw);
  const entry = code !== undefined ? ERROR_CATALOG[code] : undefined;
  const detail = stripCode(raw);
  const base = entry ?? GENERIC;
  return {
    title: base.title,
    cause: base.cause,
    action: base.action,
    ...(detail.length > 0 ? { detail } : {}),
  };
}
