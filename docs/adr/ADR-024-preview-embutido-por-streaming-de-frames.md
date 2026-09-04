# ADR-024 — Preview embutido: o frame atravessa a memória compartilhada, a janela não atravessa o Electron

- **Status:** Accepted · **Data:** 2026-09-04
- **Contrato:** [`frame-stream-layout.md`](../../contracts/frame-stream-layout.md)
- **Plano:** [`DEVELOPMENT-PLAN.md`](../DEVELOPMENT-PLAN.md) §7.1 (B3) e §8.1 (F1 onda B)
- **Antecedentes:** [ADR-022](ADR-022-host-grafico-como-composicao.md) (host gráfico como composição), [ADR-023](ADR-023-telemetria-de-frame-no-diario-de-eventos.md) (telemetria de frame)

## Contexto

A onda A entregou um processo que desenha: o `Gridsmith.Engine.Host` abre uma
janela MonoGame e compõe o mesmo frame que o canvas do editor compõe — igualdade
verificada byte a byte no CI. Falta a onda B: esse desenho aparecer **dentro** do
painel do editor, e não numa janela ao lado.

A capability `preview.embedded` já está habilitada no perfil `3.8.2`, que é o
que a engine anuncia. O painel "Pré-visualização do jogo" abre, portanto,
**vazio** — o falso affordance que a governança de experiência existe para
impedir, e que a ADR-022 se comprometeu a não criar. Ele existe hoje porque o
perfil andou à frente da interface.

Os documentos do repositório vinham assumindo, desde a análise de risco, que
embutir significaria **compor janela nativa**: pegar o handle da janela SDL do
MonoGame e reparentá-la sob a janela do Electron. Esta ADR revisita essa
suposição — ela nunca foi decidida, só herdada.

## Decisão

**O host publica os pixels do frame num Memory-Mapped File e o painel os
desenha. Nenhuma janela nativa é reparentada.**

O plano de dados do repositório já tem exatamente essa forma
([`shared-memory-layout.md`](../../contracts/shared-memory-layout.md)): header
de 64 bytes, protocolo **seqlock** (a sequência fica ímpar durante a rajada e
volta a par no publish, e o leitor tira snapshots estáveis sem lock nenhum),
resolução do endpoint físico por plataforma. O plano de frames é o **mesmo
protocolo em sentido contrário**: quem escreve é a engine, quem lê é o editor.

Reusar o protocolo, e não inventar um segundo, é a parte não óbvia da decisão:
um canal novo traria de volta todas as perguntas já respondidas (coerência,
snapshot sem lock, nomeação do endpoint) e as responderia de outro jeito.

### O que isso escolhe, e o que custa

| | Streaming por MMF (escolhido) | Reparentar a janela nativa |
|---|---|---|
| Plataformas | idêntico nas três | X11 e Win32 viáveis; macOS é o caso ruim (reparentar `NSView` entre processos) |
| Dependência nova | nenhuma — o frontend hoje não tem addon nativo | addon nativo, com build por plataforma **na véspera do empacotamento (P0.9)** |
| CI | o lado do editor é TS puro e roda com um produtor falso; o escritor é Core, sem MonoGame | nada disso é exercitável sem GPU e sem servidor gráfico |
| Input | precisa ser encaminhado ao host como evento sintético | vem de graça |
| Custo por frame | ~3,5 MB em 720p RGBA e um frame de latência | zero |

O input é o preço real, e é um preço que se paga uma vez, num contrato
explícito — enquanto o addon nativo seria pago em toda plataforma, em todo
release, e no pior momento possível do cronograma.

### Limites que a decisão fixa

1. **O host continua sendo composição, nunca domínio** (ADR-022 intacta). O
   publisher lê o render target e escreve bytes; ele não decide o que é
   desenhado.
2. **O que é publicável é Core, o que é MonoGame é Host.** A serialização do
   header, o seqlock e a política de "quando vale publicar" vivem em
   `Gridsmith.Engine.Core` e são testadas sem GPU (regras E4/E6). O Host só
   entrega os pixels.
3. **Perder frame é normal, ler frame rasgado não é.** O plano de frames é
   sinal contínuo, como a telemetria da ADR-023: o leitor que chegar no meio de
   uma rajada tenta de novo e, no limite, mostra o frame anterior. O que o
   protocolo proíbe é exibir metade de um frame e metade de outro.
4. **Sem painel visível, não se publica.** Publicar 60 vezes por segundo um
   frame que ninguém lê gastaria banda e bateria para nada; o editor liga e
   desliga o plano explicitamente.
5. **`preview.embedded` só continua `enable` porque o painel passa a existir.**
   Se a onda B parasse aqui sem painel, a capability voltaria a `disable` — a
   regra da ADR-022 não é sobre a onda, é sobre não prometer o que não há.

### A ressalva do Windows, invertida

O contrato do plano de dados já registra que, no Windows, a coerência entre
`WriteFile` e views mapeadas **não** é garantida pelo SO. Aqui os papéis se
invertem — a engine escreve por view mapeada e o editor lê por `read(2)` —, e a
ressalva se inverte com eles: é a **leitura** do Node que pode não ver a
escrita. O protocolo (header + seqlock) não muda; o que muda é onde o binding
nativo de mmap será necessário, se for. Fica registrado aqui para não ser
redescoberto como bug de plataforma.

## Consequências

**Ganhos.** O preview embutido deixa de depender de plataforma. O editor passa
a mostrar o que só a engine sabe desenhar — iluminação deferred, que o canvas
não aproxima — em vez de repetir o que o canvas já compõe. E o caminho fica
verificável: um produtor falso escreve frames conhecidos e o leitor do editor é
testado contra eles, sem GPU.

**Custos aceitos.** Uma cópia de pixels por frame publicado, e o input do painel
como contrato explícito em vez de herança do sistema de janelas. A cadência
inicial é modesta e ligada à visibilidade do painel; subir para 60 Hz é
otimização medida, não premissa.

**Fica em aberto.** O encaminhamento de input (fatia ii), o `run/pause/stop` —
que hoje **não tem o que controlar**, porque não existe simulação de jogo, só
cena estática mais câmera — e os overlays consumindo a telemetria da ADR-023.

## Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Reparentar a janela nativa (a suposição herdada) | Addon nativo por plataforma, macOS no pior caso, e nada exercitável no CI — bem na frente do empacotamento |
| Sobrepor a janela do host ao retângulo do painel, sem reparentar | Parece embutido até a primeira rolagem, troca de aba, minimização ou monitor com DPI diferente; é o reparent com todos os defeitos e nenhuma das garantias |
| Publicar frames pelo canal JSON-RPC existente | Base64 de 3,5 MB por frame no mesmo canal que carrega o plano de controle: o dispatch passaria a competir com o preview |
| Codificar em vídeo (H.264/VP8) antes de publicar | Compressão com perdas num preview de arte pixelada, mais um codec por plataforma, para economizar banda que é local |
