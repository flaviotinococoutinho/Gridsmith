/**
 * "Abrir exemplo" — a política, sem tocar em disco.
 *
 * O exemplo é VERSIONADO no repositório, e o repositório (ou a instalação) não
 * é lugar de guardar o trabalho de ninguém: abrir o arquivo original ligaria o
 * `Ctrl+S` do usuário ao exemplo distribuído, e a primeira edição destruiria a
 * cópia de referência de todo mundo. Por isso "Abrir exemplo" COPIA para um
 * destino gravável e abre a cópia pelo mesmo `openPath` de sempre — o exemplo
 * não ganha caminho especial de abertura, só um caminho especial de origem.
 *
 * Abrir duas vezes tem de dar dois projetos: se a segunda abertura reusasse o
 * diretório, ela apagaria as edições da primeira — e um exemplo que come o
 * próprio trabalho do avaliador é pior que exemplo nenhum.
 *
 * Módulo puro (regra F1): quem lista diretórios e copia bytes é o main.
 */

import { isProjectPath } from "./projectExtensions.js";

/**
 * Nome livre para a cópia: o base quando ninguém o ocupa, senão o primeiro
 * sufixo numérico livre a partir de 2 (`plataforma-2d`, `plataforma-2d-2`…).
 *
 * A comparação é case-insensitive porque macOS e Windows tratam
 * "Plataforma-2D" e "plataforma-2d" como o MESMO diretório: escolher pelo
 * nome exato acharia livre um nome que o `mkdir` recusaria.
 */
export function planExampleCopyName(baseName: string, taken: Iterable<string>): string {
  const occupied = new Set<string>();
  for (const name of taken) {
    if (typeof name === "string" && name.length > 0) occupied.add(name.toLowerCase());
  }
  if (!occupied.has(baseName.toLowerCase())) return baseName;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${baseName}-${suffix}`;
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * O documento de projeto dentro do diretório do exemplo.
 *
 * Devolve `undefined` quando há zero ou MAIS DE UM: com dois documentos, qual
 * abrir é uma escolha que o exemplo não declarou, e adivinhar abriria um
 * projeto diferente do que o botão promete. O `assets/` ao lado não conta —
 * `isProjectPath` só aceita as extensões de documento.
 */
export function pickExampleDocument(fileNames: Iterable<string>): string | undefined {
  let found: string | undefined;
  for (const name of fileNames) {
    if (typeof name !== "string" || !isProjectPath(name)) continue;
    if (found !== undefined) return undefined;
    found = name;
  }
  return found;
}
