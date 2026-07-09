# Pesquisa: paisagem de editores 2D e o que o P7M absorve de cada um

Investigação de seis ferramentas consolidadas do ecossistema 2D — FlatRedBall,
LDtk, Tiled, Gum, Ogmo Editor 3 e Aseprite — para extrair o melhor de cada
experiência de edição e integrá-lo ao ecossistema P7M EaaS. Cada seção termina
com a **decisão de projeto** correspondente e onde ela vive no código.

Fontes primárias: [LDtk](https://ldtk.io/) e [auto-layers](https://ldtk.io/docs/general/auto-layers/) /
[IntGrid](https://ldtk.io/docs/general/intgrid-layers/) · [Tiled 1.12](https://doc.mapeditor.org/)
e [custom properties](https://doc.mapeditor.org/en/stable/manual/custom-properties/) /
[terrains-Wang](https://doc.mapeditor.org/en/stable/manual/terrain/) ·
[Ogmo Editor 3](https://ogmo-editor-3.github.io/docs/) ·
[Aseprite CLI](https://www.aseprite.org/docs/cli/) ·
[FlatRedBall generated code](https://docs.flatredball.com/flatredball/glue-reference/glue-reference-generated-code) ·
[Gum states](https://docs.flatredball.com/flatredball/gum/tutorials/tutorials-gum-states) e
[MonoGameGum](https://docs.flatredball.com/gum/code/monogame).

---

## 1. LDtk — o padrão-ouro de UX para níveis

**O que ele faz de melhor:**
- **IntGrid layers**: o designer pinta *significado* (colisão, água, perigo) como
  inteiros coloridos, não tiles. A arte vem depois, derivada.
- **Auto-layers**: regras de padrão (NxN com wildcards e negações) transformam o
  IntGrid em tiles automaticamente — pinta-se a jogabilidade e a decoração
  "acontece". Grupos de regras por bioma podem ser ativados por nível.
- **Entities com campos tipados**: um "Mob" com `hitPoints: int [0..10]` — o
  editor materializa a UI a partir da definição, com defaults e limites.
- **World map**: níveis organizados espacialmente (Grid-vania/linear/free) com
  vizinhança navegável.

**Decisão P7M:** o IntGrid + auto-tiling é a espinha do nosso subsistema de
níveis. A resolução de regras é **determinística e roda no middleware** (função
pura, testável, com seed) — a engine recebe tiles já resolvidos e os consolida
em buffer estático (casa com a diretriz "entidades stateless em um único buffer
de vértices" do escopo original). Campos tipados de entidades entram no
Blueprint com validação na borda (mesma filosofia dos nossos editor hints).
→ `middleware/src/leveldesign/AutoTiler.ts`, `BlueprintStore` (entity defs),
`engine Core/Level/TilemapStore.cs`, métodos `tilemap/*`.

## 2. Tiled — generalidade e propriedades customizadas

**O que ele faz de melhor:**
- **Custom property types** (1.8+): enums e classes definidos pelo usuário,
  reutilizados em mapas, objetos e tiles — um sistema de tipos do projeto.
- **Terrains/Wang tiles**: transições automáticas entre terrenos por
  coloração de bordas/cantos.
- **Infinite maps** com alocação por chunk; camadas de objetos independentes
  de grid.

**Decisão P7M:** o sistema de tipos do projeto (enums + classes) converge com
os campos tipados do LDtk num único registro de definições no Blueprint
(`entitydef/define` com `enum` como tipo de campo). Wang tiles ficam como
evolução do AutoTiler (regras por borda além de padrão NxN) — registrado como
extensão futura no contrato. Mapas por chunk entram quando o plano de dados
carregar tiles via shared memory (hoje o plano de controle aguenta os níveis
típicos; o limite está documentado no contrato).

## 3. Ogmo Editor 3 — o projeto como schema

**O que ele faz de melhor:**
- O arquivo de projeto **é um schema**: templates de camadas e de entidades com
  valores tipados; o editor é gerado a partir dele; níveis exportam JSON limpo
  com os tipos corretos.
- Minimalismo: Grid/Tile/Entity/Decal layers cobrem 95% dos jogos 2D.

**Decisão P7M:** confirma a nossa aposta da Fase 2: **o editor é uma projeção
de definições** (`engine/describe` + definições do Blueprint), nunca uma UI
hardcoded. O que o Ogmo faz com o arquivo de projeto, nós fazemos com o AST do
middleware: `entitydef/define` é o "template de entidade" e `editorConcepts()`
entrega a paleta pronta para a UI.

## 4. FlatRedBall (Glue) — artefatos gerados + código custom

**O que ele faz de melhor:**
- **Generated code + partial classes**: o editor gera código determinístico a
  partir das definições; o dev estende em arquivos custom que nunca são
  sobrescritos. Screens/Entities como conceito de primeira classe.
- **Variáveis tunáveis**: campos expostos no editor com tipo e faixa, editáveis
  em runtime (live edit).
- Integração nativa com MonoGame e content pipeline.

**Decisão P7M:** nosso equivalente de "generated code" é o **artefato binário
determinístico**: blueprint → resolução (auto-tiling, skinning bind, clips) →
buffers consumidos pela engine. A separação gerado/custom vira separação
plano-declarativo (AST, sempre regenerável) / código da engine. As variáveis
tunáveis já existem como `properties` nos editor hints; a Fase 4 as liga a
live edit via `camera/configure`-style RPCs por subsistema.

## 5. Gum — estados visuais como cidadãos de primeira classe

**O que ele faz de melhor:**
- **States e categorias de estados**: um botão "disabled" é um estado que
  atribui N variáveis visuais de uma vez; o código só seta o estado.
  Interpolação entre estados vem de graça.
- Layout hierárquico com unidades relativas (percent/pixels/relative-to-
  container) e componentes instanciáveis; runtime NuGet para MonoGame.

**Decisão P7M:** os grafos de máquina de estados da Fase 4 (escopo original)
adotam a semântica Gum: **um estado é um conjunto nomeado de atribuições de
propriedades; transições interpolam** — reutilizando as curvas de Bézier do
editor de animação para easing. Isso unifica FSM de gameplay, estados visuais
de UI e clipes de animação sob o mesmo modelo declarativo no Blueprint.
Registrado no manifesto como conceito do subsistema `stateMachines` (planned,
Fase 4).

## 6. Aseprite — a fonte da verdade da arte

**O que ele faz de melhor:**
- **Frame tags** (`meta.frameTags`: name/from/to/direction) definem clipes de
  animação DENTRO do arquivo de arte — o artista é dono do timing.
- **Slices** (`meta.slices`: bounds/center/pivot) carregam 9-slice e pivôs.
- **CLI batch** (`aseprite -b --sheet out.png --data out.json`) automatiza a
  exportação de spritesheet + metadados JSON (json-hash/json-array) — perfeito
  para um watcher de assets.

**Decisão P7M:** o pipeline de assets (Fase 4) trata o export JSON do Aseprite
como **formato de ingestão de primeira classe**: o importador converte
frameTags → clipes (com direção forward/reverse/pingpong expandida
deterministicamente), durations por frame → timeline, slices → pivôs/9-slice.
O watcher taxonômico dispara o CLI e o importador, e o MGCB compila o `.png`
para `.xnb` — encaixando no fluxo já especificado no escopo original.
→ `middleware/src/assets/AsepriteImporter.ts` (implementado já; o watcher entra
na Fase 4).

---

## Síntese: o modelo unificado P7M

As seis ferramentas convergem para quatro princípios que o P7M adota como lei:

1. **Definições geram o editor** (Ogmo/LDtk/Tiled): toda UI de edição é
   projeção de um schema vivo — `engine/describe` para capacidades da engine,
   `entitydef/*` para o domínio do jogo. Nada de painéis hardcoded.
2. **Pinte significado, derive arte** (LDtk/Tiled): o designer edita IntGrid e
   regras; a resolução é uma função pura determinística no middleware,
   verificável por testes e reproduzível por seed.
3. **Estados são conjuntos nomeados de atribuições** (Gum/FlatRedBall): FSMs de
   gameplay, UI e animação compartilham o mesmo modelo com interpolação.
4. **A arte manda no timing** (Aseprite): metadados de animação viajam com o
   asset; o importador é quem adapta, nunca o artista.

### Ajustes aplicados agora (esta iteração)

| Ajuste | Inspiração | Onde |
|---|---|---|
| `AutoTiler` determinístico (padrões NxN, wildcard/negação, chance com seed, variantes) | LDtk auto-layers, Tiled Wang | `middleware/src/leveldesign/AutoTiler.ts` + testes |
| Definições de entidade com campos tipados (int/float/bool/string/enum/point/color, min/max/default) e instâncias validadas | LDtk entities, Ogmo templates, Tiled property types | `BlueprintStore` (`entitydef/define`, `entity/place`) + testes |
| Importador Aseprite (frameTags → clipes com pingpong expandido, slices → pivô/9-slice, json-hash e json-array) | Aseprite CLI | `middleware/src/assets/AsepriteImporter.ts` + testes |
| `TilemapStore` DOD na engine (IntGrid + tiles resolvidos pré-alocados, consolidação estática) + RPC `tilemap/define`/`tilemap/inspect` | LDtk/Tiled + diretriz de buffer estático do escopo original | `engine Core/Level/TilemapStore.cs`, `EngineService` + testes |
| Manifesto: subsistema `level` disponível; `assets` enriquecido (aseprite-import, tag-taxonomy); `stateMachines` planejado com semântica Gum; gizmo `onion-skin` no rigging | todos | `EngineDescriptor` |

### Adiado com registro (Fase 4/5)

- **World map** de níveis com vizinhança (LDtk) — entra com o editor Electron.
- **Wang/terrain rules** por borda (Tiled) — extensão do AutoTiler.
- **Watcher de assets + CLI Aseprite + MGCB** — Fase 4 (o importador já está pronto).
- **Live edit de variáveis tunáveis** (FlatRedBall) — RPCs por subsistema já
  estabelecem o padrão (`camera/configure`); generalizar na Fase 4.
- **Runtime de UI com layout relativo** (Gum) — Fase 4, sobre o mesmo modelo de
  estados.
- **Tiles via shared memory** para mapas gigantes/infinitos (Tiled chunks) —
  quando o plano de dados ganhar múltiplos buffers nomeados (Fase 5).
