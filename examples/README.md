# Projetos de exemplo

Projetos versionados que o editor oferece em "Abrir exemplo" na tela inicial.
São a primeira coisa que um avaliador abre — e por isso são documentos reais,
não maquetes: cada um passa pelo mesmo `openPath` de qualquer projeto do
usuário, e `middleware/test/example-project.test.ts` falha se um deles deixar
de abrir.

## `plataforma-2d/`

| Arquivo | O que é |
|---|---|
| `plataforma-2d.gridsmith.json` | Documento na versão corrente do Blueprint |
| `assets/atlas.png` | Atlas 64×64 — 4×4 tiles de 16 px |

Nível de 32×18 com chão, paredes, duas plataformas e um bloco de pedra; a arte
é derivada do significado por regras de auto-tiling (a grama vem antes da terra
porque a primeira regra que casa vence), e o jogador aparece com o **sprite**
da definição de entidade, o mesmo que a janela do host desenha.

## Nada aqui é escrito à mão

Os dois arquivos são **gerados**, e os geradores são versionados ao lado deles:

```bash
cd middleware && npm run build          # o gerador do documento usa o dist
node scripts/make-example-atlas.mjs     # examples/plataforma-2d/assets/atlas.png
node scripts/make-example-project.mjs   # examples/plataforma-2d/*.gridsmith.json
```

O documento não é montado por um `JSON.stringify` paralelo: o gerador reproduz
o conteúdo pelo caminho canônico (`documentToCommands` → `CanonicalOrchestrator`)
e serializa o resultado com `exportBlueprint`, de modo que o arquivo versionado
é a serialização que o próprio middleware produz. A arte é desenhada por código
pelo mesmo motivo pelo qual as migrações não inventam arte: um binário sem
origem no repositório não pode ser distribuído junto de um exemplo.

Ambos aceitam `--check`, que não escreve e falha quando o arquivo versionado
diverge do gerado — é o que o CI roda para impedir edição manual silenciosa.

## Abrir um exemplo não edita o que está aqui

"Abrir exemplo" **copia** o diretório para `Documentos/Gridsmith/<nome>` e abre
a cópia. Abrir duas vezes dá dois projetos (`plataforma-2d`,
`plataforma-2d-2`…): se a segunda abertura reusasse o diretório, ela apagaria
as edições da primeira.
