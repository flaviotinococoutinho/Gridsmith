# ADR-022 — Host gráfico como composição, e como verificá-lo sem GPU

- **Status:** Accepted · **Data:** 2026-08-14
- **Código:** [`FrameComposer.cs`](../../engine/src/Gridsmith.Engine.Core/Rendering/FrameComposer.cs), [`Gridsmith.Engine.Host/`](../../engine/src/Gridsmith.Engine.Host), [`DeferredRenderer.cs`](../../engine/src/Gridsmith.Engine.Graphics/DeferredRenderer.cs)
- **Testes:** [`FrameComposerTests.cs`](../../engine/tests/Gridsmith.Engine.Ipc.Tests/FrameComposerTests.cs), [`ArchitectureTests.cs`](../../engine/tests/Gridsmith.Engine.Ipc.Tests/ArchitectureTests.cs) (regra E6)
- **Plano:** [`DEVELOPMENT-PLAN.md`](../DEVELOPMENT-PLAN.md) §9.6 (receita F1, onda A)

## Contexto

O ecossistema tem uma camada `Graphics` madura — pipeline deferred 2D com MRT,
skinning na GPU, LUT cromática, tudo com referência de CPU testada — e **nenhum
processo que a instancie**. `Gridsmith.Engine.Runtime` é um serviço JSON-RPC
headless: o `csproj` dele não referencia `Graphics`, não existe `Game` nem
`GraphicsDeviceManager` em lugar nenhum, e o executável que a barra de status do
editor chama de "Runtime MonoGame" nunca carregou MonoGame.

O efeito no produto é o item B1 da fila: **nenhum pixel do jogo é desenhado**.
O canvas do editor mostra quadrados coloridos, "pinte significado, derive arte"
termina num `tileId` inteiro, e não existe captura de tela do produto.

Duas restrições moldam qualquer solução, e as duas são anteriores a esta ADR:

1. **A regra E4 proíbe o Runtime de ver Graphics.** Ela existe para que o plano
   de controle continue testável sem GPU — é o que permite as fases 1–4 e os
   transports rodarem no CI.
2. **Shader não compila no CI.** O MGCB exige Wine no Linux
   (`Gridsmith.Engine.Graphics/Content/README.md`), e o runner não tem GPU. O
   repositório já convive com isso: cada `.fx` tem uma **referência de CPU
   espelhada e testada** (`Lighting2D`, `ColorLut`, `LinearBlendSkinning`,
   `BonePacker`), e é ela que o CI verifica.

## Decisão

### 1. O host é composição, nunca domínio

`Gridsmith.Engine.Host` é um projeto **Exe** novo que referencia Core, Ipc,
Graphics e Runtime. Ele instancia `Game` + `GraphicsDeviceManager` e desenha os
stores DOD **por referência** — eles já são propriedades públicas do
`EngineService`, então o loop de desenho e o plano de controle compartilham
estado sem cópia.

`Runtime` **continua sem referência a Graphics** (E4 intacta). O acoplamento é
por fora: quem quer pixels sobe o Host; quem quer só o plano de controle sobe o
Runtime, e continua subindo sem SDL, sem OpenGL e sem GPU.

A regra **E6** nova torna isso executável: entre os assemblies de produção,
**só o Host** referencia `Graphics` — e é ele, e só ele, que junta Graphics com
Runtime.

### 2. O que desenhar é DOMÍNIO PURO; como desenhar é que é MonoGame

O passo que torna esta etapa verificável: a decisão de **o que** compõe o frame
sai do host e vira `FrameComposer`, um módulo puro em `Core/Rendering/`.

O composer lê os stores e escreve uma lista de quads num buffer **do chamador**
— nenhuma alocação por frame, mesma política Zero-GC dos outros hot loops. Ele
não conhece `GraphicsDevice`, `Texture2D` nem `Effect`: devolve posição, tamanho,
`tileId` e camada. O Host apenas **executa** essa lista.

Isso não é indireção decorativa. É o que faz a pergunta "o editor e a engine
desenham a mesma coisa?" ter uma resposta **determinística**, comparável campo a
campo, em vez de depender de dois rasterizadores concordarem em RGB.

### 3. A paridade visual é verificada na DESCRIÇÃO do frame, não no framebuffer

A receita original previa comparar o checksum de uma região do framebuffer do
host com o mesmo trecho renderizado pelo editor. **Recusado**, por duas razões
verificadas e não por preferência:

- **Não roda no CI.** Precisaria de Xvfb + rasterização por software (llvmpipe)
  *e* dos `.xnb` compilados, que exigem MGCB com Wine. Seria a única etapa do
  repositório cuja verificação não cabe no gate.
- **Com tolerância, vira teatro.** Comparar llvmpipe contra o canvas 2D do
  Electron obriga a uma tolerância larga, e uma tolerância larga passa a aceitar
  justamente as divergências que o teste existe para pegar — foi o alerta que a
  própria receita registrou.

A paridade passa a ser: dada a MESMA tabela de atlas e o MESMO estado, o
`FrameComposer` e o núcleo puro do editor (`frontend/src/core/tilesetAtlas.ts`,
onda seguinte) produzem a MESMA lista de quads. Igualdade exata, sem tolerância,
sem GPU, sem Wine — e ainda mais estrita que o checksum de pixels.

A verificação de PIXEL continua existindo, como script **local e opcional**
documentado no host, fora do gate: é onde se confere que o pipeline deferred de
fato desenha o que o composer descreveu. O gate cobre a descrição; o olho humano
e o script local cobrem a rasterização.

### 4. A capability de preview embutido continua desabilitada

`preview.embedded` **não** vira `enable` em perfil nenhum nesta onda. Ela
descreve o jogo rodando DENTRO do painel do editor, que é a onda B (composição
de janela nativa, frágil por plataforma). Habilitá-la agora faria o gate de
experiência prometer ao usuário um painel que abre vazio — exatamente o falso
affordance que a governança existe para impedir.

O host desta onda roda em **janela própria**, supervisionado pelo Electron.

## Consequências

**Ganhos.** Existe um processo que desenha. A camada Graphics deixa de ser
código morto. "O que é desenhado" fica sob teste determinístico e Zero-GC, sem
GPU. A separação composer/executor é o que permitirá, na onda B, embutir a
janela sem tocar na lógica de composição.

**Custos aceitos.** O host não é exercitado ponta a ponta pelo CI: o gate
compila o projeto e testa o composer, mas quem confirma que o `DeferredRenderer`
desenha é execução local. É o mesmo contrato que o repositório já aceita para os
shaders, e a alternativa (Wine + Xvfb no CI) foi medida como desproporcional ao
risco que cobre.

**Fica em aberto para a onda seguinte.** O comando canônico `tileset/define`
(mapa `tileId` → região de atlas) com o DoD completo, a tabela espelhada no
núcleo do editor, e a telemetria de frame como notificação — nunca no caminho
síncrono do dispatch.

## Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Desenhar dentro do `Runtime` | Quebra E4. O plano de controle deixaria de ser testável sem GPU, e as fases 1–4 e os transports sairiam do CI junto |
| Xvfb + llvmpipe + `.xnb` versionados no repositório | Binário gerado no git, dependente de versão do MGCB, para cobrir com tolerância larga o que a comparação de descrição cobre com igualdade exata |
| Host com `BasicEffect` quando o `.xnb` falta | Cria dois caminhos de desenho. O teste de paridade passaria a comparar o caminho degradado, não o real — o editor e o host precisam falhar JUNTOS quando a tabela diverge |
| Adiar o host até a onda B | A composição de janela nativa é a parte frágil por plataforma; amarrá-la ao valor "o jogo desenha" atrasaria os dois |
