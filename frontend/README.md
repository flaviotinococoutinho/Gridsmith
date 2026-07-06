# P7M Frontend (Electron) — Fase 4

Ambiente visual WYSIWYG do ecossistema P7M EaaS. **Esta camada é implementada na
Fase 4 do roteiro**; este diretório reserva a estrutura e registra as decisões já
tomadas nas fases anteriores que a restringem.

## Arquitetura planejada

- **CQRS interno para o estado do editor:** cada ação do usuário gera um Comando
  imutável enviado ao middleware; a UI (React) renderiza projeções somente-leitura do
  Blueprint centralizado — o mesmo `BlueprintStore` que já existe no middleware.
- **Abstração de canvas fora da main thread:** editores de curvas de Bézier cúbicas,
  grafos de máquinas de estado e manipulação de ossos renderizados via WebGL/Canvas 2D
  em Worker Threads (`OffscreenCanvas`).
- **FABRIK interativo:** o solver de cinemática inversa roda no worker de edição de
  rig; apenas os keyframes resultantes viram Comandos.
- **Painel taxonômico de assets:** catálogo por tags/sub-tags monitorado por serviço
  assíncrono, com pipeline de geração via IA (fatiamento de sprite sheets + compilação
  `MGCB` para `.xnb`) orquestrado pelo middleware.

## Contratos já fixados pelas Fases 1–3

- Toda comunicação com o middleware usa os métodos JSON-RPC de
  [`../contracts/schemas/`](../contracts/schemas/) — o Electron **não** fala
  diretamente com a engine.
- Dados de malha em massa (vértices, UVs, `BoneWeights`) são escritos no
  memory-mapped file (Fase 2) e apenas **anunciados** via `mesh/bind_shared_memory`.
