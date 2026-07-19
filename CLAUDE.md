# P7M — instruções do repositório

Ecossistema EaaS local de 3 processos: **frontend** (Electron/TS), **middleware**
(Node/TS), **engine** (.NET 8/MonoGame). Contratos em `contracts/` são fonte de
verdade. Constituição de engenharia: `docs/ARCHITECTURE-SPEC.md`; regras
executáveis e DoD: `docs/GOVERNANCE.md`; compatibilidade: `docs/COMPATIBILITY.md`.

## Comandos

```bash
# middleware (Node >= 22)
cd middleware && npm install && npm run build && npm test

# frontend (compile o middleware ANTES; engine compilada p/ supervisão local)
cd frontend && npm install && npm run build && npm test
npm run app                                   # Electron supervisiona tudo
npm run app -- --external-services --pipe p7m-engine

# engine (.NET 8 — use export PATH="$HOME/.dotnet:$PATH" se preciso)
cd engine && dotnet build && dotnet test

# e2e (raiz)
./scripts/verify-phase1.sh .. verify-phase4.sh
./scripts/verify-transports.sh                # gRPC quente + fallback GraphQL
npm run docs:verify                           # lint da documentação
```

## Transports do app (ADR-016/017/018 em docs/adr/)

- App ↔ middleware: **gRPC prioritário no caminho quente** (Dispatch/Query/
  StreamEvents/Health, proto `contracts/grpc/p7m_editor.proto`) com **fallback
  imediato para GraphQL** (superfície completa, SDL
  `contracts/graphql/editor.schema.graphql`) e recovery com histerese —
  política pura em `frontend/src/core/transportRouter.ts`.
- Middleware ↔ engine: **JSON-RPC 2.0** sobre pipes/UDS (inalterado) + shared
  memory (MMF) no plano de dados.
- Eventos: `EventJournal` (seq monotônico) — stream no gRPC, polling
  `eventsSince` no GraphQL; nunca perde eventos dentro da janela.
- **Verbosidade:** `P7M_VERBOSITY=silent|error|warn|info|debug|trace`.

## Regras inegociáveis (impostas por teste — não relaxe, mova a dependência)

- Toda mutação passa pelo `CanonicalOrchestrator` (P-1); as bordas (JSON-RPC,
  GraphQL, gRPC, MCP) são fachadas finas sobre a `EditorSurface` (R12).
- Libs de borda são exclusivas dos seus diretórios: SDK MCP/`zod` em `mcp/`
  (R1), `graphql` em `graphql/` (R10), `@grpc/*` em `grpc/` (R11); no frontend,
  SDKs de transporte só em `main/transport/` (F5), `core/` puro (F1).
- Comando canônico novo segue o DoD de `docs/GOVERNANCE.md` (validação +
  `COMMAND_KINDS` + enum GraphQL + projeção + reidratação + serialização).
- Contratos alterados atualizam `contracts/` E os dois lados do fio; teste de
  paridade quebra se a cópia em `dist/` divergir (rode `npm run build`).
- NÃO fixe contagens de teste em docs (o CI conta; `docs:verify` bloqueia).
- Diagramas SEMPRE em Mermaid (nunca arte ASCII).
- Commits em pt-BR descritivo; rode as suítes + `docs:verify` antes de push.
