import path from "node:path";

/**
 * Resolve a referência de imagem de um atlas para um caminho absoluto DENTRO
 * do diretório do projeto — ou recusa.
 *
 * A referência vem do documento (`TilesetSpec.image`), e documento é entrada
 * NÃO confiável: um `.gridsmith.json` editado à mão (ou gerado por um agente)
 * pode carregar `../../` ou um caminho absoluto. Como o renderer pede a
 * imagem por IPC e o main a lê do disco, aceitar qualquer caminho
 * transformaria o visualizador de tiles num leitor de arquivos arbitrários do
 * usuário. A regra é a mesma do host gráfico com `--content-root`: a imagem
 * mora no projeto, e referência que aponta para fora não é arte — é recusada.
 */
export function resolveAtlasImagePath(
  projectFilePath: string,
  imageReference: string,
): string | undefined {
  if (imageReference.length === 0) return undefined;
  // caminho absoluto nunca é aceito: a referência é relativa ao projeto por
  // contrato (o documento é portátil entre máquinas; um absoluto não seria)
  if (path.isAbsolute(imageReference) || /^[A-Za-z]:[\\/]/.test(imageReference)) {
    return undefined;
  }

  const projectDir = path.dirname(path.resolve(projectFilePath));
  const resolved = path.resolve(projectDir, imageReference);
  // o prefixo com separador impede o falso positivo de irmãos
  // ("/p/jogo" × "/p/jogo-outro")
  if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) {
    return undefined;
  }
  return resolved;
}

/** MIME por extensão — só formatos que o canvas decodifica; resto é recusado. */
export function atlasImageMime(imagePath: string): string | undefined {
  switch (path.extname(imagePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}
