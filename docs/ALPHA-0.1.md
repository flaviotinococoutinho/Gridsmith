# Milestone: Alpha 0.1 — First Playable Workflow

> **Decisão de rumo (2026-07): expansão horizontal CONGELADA.** Nenhum
> subsistema novo entra até este corte vertical funcionar sem terminal:
> `Projeto → Asset → Entidade → Nível → Preview → Live edit → Save/reopen`.

## Definição do produto

**P7M Alpha 0.1** — Um editor visual desktop para criar um pequeno jogo 2D em
MonoGame usando níveis IntGrid, assets Aseprite, entidades tipadas, iluminação
e câmera, com preview embutido e projeto versionável.

## Jornada de aceite (o teste que define "pronto")

Um usuário novo, sem conhecer a arquitetura interna, consegue:

1. instalar e abrir;
2. escolher "Novo projeto de plataforma 2D";
3. importar `player.aseprite`;
4. criar a entidade Player;
5. pintar chão e paredes;
6. posicionar o Player;
7. configurar a câmera;
8. adicionar uma luz;
9. executar o preview;
10. modificar algo com o jogo pausado;
11. salvar;
12. fechar;
13. reabrir sem perdas.

### Metas objetivas

| Meta | Alvo |
|---|---|
| Tempo até o primeiro preview | < 10 minutos |
| Etapas que exigem terminal | 0 |
| Etapas que exigem editar JSON | 0 |
| Save/reopen sem perdas | 100% |
| Operações visuais no undo/redo | todas |
| Falha externa sem causa+ação corretiva na UI | 0 |
| Projeto de exemplo incluído na instalação | 1 |
| Editor continua editável com a engine caída | sim |
| Reiniciar a engine preserva o projeto | sim |

## Backlog P0 (issues da milestone)

Status: ⬜ aberto · 🔶 em andamento · ✅ fechado. Issues registradas:
[#1](https://github.com/flaviotinococoutinho/p7m-design/issues/1) P0.1 ·
[#2](https://github.com/flaviotinococoutinho/p7m-design/issues/2) P0.2 ·
[#3](https://github.com/flaviotinococoutinho/p7m-design/issues/3) P0.3 ·
[#4](https://github.com/flaviotinococoutinho/p7m-design/issues/4) P0.4 ·
[#5](https://github.com/flaviotinococoutinho/p7m-design/issues/5) P0.5 ·
[#6](https://github.com/flaviotinococoutinho/p7m-design/issues/6) P0.6 ·
[#7](https://github.com/flaviotinococoutinho/p7m-design/issues/7) P0.7 ·
[#8](https://github.com/flaviotinococoutinho/p7m-design/issues/8) P0.8 ·
[#9](https://github.com/flaviotinococoutinho/p7m-design/issues/9) P0.9

### P0.1 — Supervisor de processos 🔶
O Electron é o supervisor do ecossistema: um único executável.
- [x] Máquina de estados de supervisão (spawn/descoberta, health, retry com backoff, encerramento coordenado, modo sem engine) — `frontend/src/main/ProcessSupervisor.ts`, testada com launcher injetável
- [ ] Wire real no `main.ts` (spawn de middleware/engine empacotados)
- [ ] Tela de estados compreensíveis ("Iniciando serviços…", "Conectando ao MonoGame…", "Pronto")
- [ ] Captura de stdout/stderr por serviço + diagnóstico de dependências
- [ ] Detecção de versão incompatível de protocolo com mensagem orientada à solução

### P0.2 — Ciclo de vida do projeto 🔶
O editor começa pelo projeto, não pela conexão a um pipe.
- [x] Máquina de estados do documento (sem projeto → aberto → modificado → salvando → fechado), dirty tracking por eventos, política de autosave, lista de recentes — `frontend/src/core/projectLifecycle.ts`, testada
- [x] `EditorClient.saveDocument()/loadDocument()` expostos (gap apontado no diagnóstico) + preload com `saveProject/openProject`
- [ ] Diálogos nativos (New/Open/Save As/Recent) e escrita em disco no processo main
- [ ] Autosave + recovery pós-crash (journal de comandos)
- [ ] Migração de `schemaVersion` e template "Plataforma 2D"

### P0.3 — Workbench do editor ⬜
Layout com navegação real (menu/toolbar, rail de navegação, canvas, inspector,
painel inferior Problems|Output|Pipeline|History), painéis como elementos
interativos com nomes humanos e i18n pt-BR — fim dos IDs internos na UI.

### P0.4 — Vertical slice do editor de níveis ⬜
Canvas de IntGrid (pan/zoom/grid/cursor), paleta de significados com nome+cor+
atalho, pencil/eraser/rect/flood, preview de auto-tiling em tempo real,
posicionamento de entidade/câmera/luz, undo/redo, salvar, executar preview.

### P0.5 — Preview embutido ⬜
Run/pause/stop/restart, live edit de câmera e iluminação, overlays (colisão/
luzes/câmera), seleção cruzada editor↔runtime, erros de projeção visíveis.
(Promovido de OPP-02: é requisito, não oportunidade.)

### P0.6 — Spawn mínimo de entidades ⬜
Spawn table canônica (definição → archetype com transform/sprite/animação/
colisão opcional), placement incremental projetado, referência estável
editor↔runtime, diagnóstico de entidade não projetada.
(Promovido de OPP-11.)

### P0.7 — Undo/redo global ⬜
Histórico no nível do comando canônico com inversos explícitos, agrupamento
por gesto, coalescing de drag, histórico legível ("Moveu Player de (10,4)
para (12,4)"), proveniência humano/agente. (Promovido de OPP-05.)

### P0.8 — Diagnósticos como funcionalidade ⬜
Problems panel consolidando erros/warnings/compatibilidade/pipeline com as
7 perguntas respondidas (o quê, objeto, por quê, impacto, correção, navegação,
fix automático) — materializa a explicabilidade que já existe na camada
canônica (reasons de skipped/deferred, AssetToolError, matriz do governor).

### P0.9 — Empacotamento ⬜
Electron Builder/Forge: executável por plataforma, bundling coordenado de
middleware+runtime, detecção de Aseprite/MGCB, smoke test do artefato
instalado, release alpha.

## P1 (depois do P0 — profundidade)

Asset browser com thumbnails e reimport · world map visual · inspector
schema-driven + modelo de seleção transversal · editor de rigs · timeline ·
graph editor de estados · live edit genérico (contrato `TunableDescriptor`) ·
templates · atalhos + command palette · layouts persistidos · acessibilidade
(teclado, ARIA, daltonismo no IntGrid, i18n).

## P2 (expansão — deliberadamente adiado)

Segundo runtime (OPP-07) · geração por IA (OPP-13) · colaboração (OPP-17) ·
plugins (OPP-18) · registro de perfis (OPP-19) · shader editor completo ·
mapas infinitos. **Razão:** validam a arquitetura, não o produto; a tese
multi-runtime já está representada nos contratos.

## Pirâmide de testes exigida pela milestone

1. **Unidade** — manter os núcleos puros (já coberto).
2. **Componentes** — inspector, toolbar, paleta, canvas (a introduzir com a UI).
3. **Integração da aplicação** — renderer↔preload↔main↔gateway, save/load,
   supervisão de processos (parcialmente coberto com fakes injetáveis).
4. **E2E visual** — Playwright + Electron dirigindo a jornada de aceite.
5. **Usabilidade** — 3–5 usuários, tempo-até-primeira-cena, taxa de conclusão.
