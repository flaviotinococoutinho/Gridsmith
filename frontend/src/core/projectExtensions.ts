/**
 * Extensões do documento de projeto — fonte ÚNICA.
 *
 * O rebrand P7M → Gridsmith trocou o sufixo do documento. A extensão é nome de
 * ARQUIVO, não parte do contrato do documento: nenhum byte dentro de um projeto
 * existente muda, e `BLUEPRINT_DOCUMENT_VERSION` não é bumpado por causa disso.
 *
 * Por isso a LEITURA aceita as duas: um projeto `.p7m.json` que já esteja no
 * disco continua abrindo, pelo diálogo, por argumento de linha de comando ou
 * pelo gerenciador de arquivos. Só a ESCRITA de um caminho novo (Novo/Salvar
 * como) emite `.gridsmith.json` — quem abriu um `.p7m.json` continua salvando
 * nele, sem migração surpresa de caminho.
 *
 * Estas quatro decisões viviam espalhadas em três arquivos e em três formatos
 * diferentes (com ponto, sem ponto, dentro de regex). Um rename parcial
 * passava por TODAS as suítes e só aparecia quando o usuário não achava o
 * próprio projeto no diálogo.
 *
 * Módulo puro (regra F1).
 */

/** Sufixo emitido ao gravar um caminho novo. */
export const PROJECT_EXTENSION = "gridsmith.json";

/** Sufixo herdado, aceito na LEITURA para não deixar projeto antigo órfão. */
export const LEGACY_PROJECT_EXTENSION = "p7m.json";

/**
 * Todas as extensões aceitas na leitura, sem o ponto inicial — é a forma que o
 * filtro de diálogo do Electron exige.
 */
export const PROJECT_EXTENSIONS: readonly string[] = [
  PROJECT_EXTENSION,
  LEGACY_PROJECT_EXTENSION,
];

/** O caminho aponta para um documento de projeto (novo ou herdado)? */
export function isProjectPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return PROJECT_EXTENSIONS.some((extension) => lower.endsWith(`.${extension}`));
}

/** Nome do arquivo a sugerir ao gravar um projeto novo. */
export function defaultProjectFileName(projectName: string): string {
  return `${projectName}.${PROJECT_EXTENSION}`;
}

/**
 * Nome exibível derivado do caminho: tira o diretório e QUALQUER sufixo aceito.
 *
 * Tirar só o sufixo novo faria um projeto herdado abrir chamado "jogo.p7m" na
 * barra de título e nos recentes — a compatibilidade de leitura estaria lá,
 * mas o rebrand vazaria para o nome do trabalho do usuário.
 */
export function projectNameFromPath(filePath: string): string {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
  for (const extension of PROJECT_EXTENSIONS) {
    const suffix = `.${extension}`;
    if (fileName.toLowerCase().endsWith(suffix)) {
      return fileName.slice(0, fileName.length - suffix.length);
    }
  }
  return fileName;
}
