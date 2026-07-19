#!/usr/bin/env node
/**
 * Verificação automática da documentação (P7M).
 *
 * Reduz o drift entre docs e repositório validando, sem julgamento humano:
 *  - links Markdown internos e arquivos relativos citados existem;
 *  - documentos e scripts obrigatórios existem (inclui verify-phase1..4,
 *    verify-transports.sh, docs/COMPATIBILITY.md, ADRs e os contratos
 *    GraphQL/gRPC do app);
 *  - referências a schemas `contracts/schemas/*.json` existem;
 *  - NÃO há referências transitórias a branches/sessões de geração;
 *  - todo comando `npm run <x>` documentado existe em algum package.json;
 *  - NÃO há contagens de teste fixadas manualmente (devem vir do CI).
 *
 * Uso: `npm run docs:verify` (ou `node scripts/verify-docs.mjs`) na raiz.
 * Sai com código 1 se houver qualquer violação.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const IGNORE = new Set(["node_modules", ".git", "obj", "bin", "dist", ".p7m-build"]);

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

const REQUIRED = [
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/ARCHITECTURE-SPEC.md",
  "docs/GOVERNANCE.md",
  "docs/REQUIREMENTS.md",
  "docs/ALPHA-0.1.md",
  "docs/COMPATIBILITY.md",
  "docs/CANONICAL-MODEL.md",
  "docs/OPPORTUNITIES.md",
  "docs/PRODUCT.md",
  "docs/RESEARCH-EDITOR-LANDSCAPE.md",
  "docs/adr/README.md",
  "contracts/README.md",
  "contracts/shared-memory-layout.md",
  "contracts/schemas/error-codes.md",
  "contracts/graphql/editor.schema.graphql",
  "contracts/grpc/p7m_editor.proto",
  "scripts/verify-phase1.sh",
  "scripts/verify-phase2.sh",
  "scripts/verify-phase3.sh",
  "scripts/verify-phase4.sh",
  "scripts/verify-transports.sh",
];

function packageScripts() {
  const set = new Set();
  for (const p of ["package.json", "middleware/package.json", "frontend/package.json"]) {
    const fp = path.join(root, p);
    if (!fs.existsSync(fp)) continue;
    try {
      const scripts = JSON.parse(fs.readFileSync(fp, "utf8")).scripts ?? {};
      for (const k of Object.keys(scripts)) set.add(k);
    } catch {
      /* ignore malformed package.json here */
    }
  }
  return set;
}

/** Remove blocos cercados (```...```) para não confundir o scanner de links. */
function stripFencedCode(text) {
  return text.replace(/```[\s\S]*?```/g, "");
}

const errors = [];
const scripts = packageScripts();

for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(root, rel))) {
    errors.push(`arquivo obrigatório ausente: ${rel}`);
  }
}

const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
const npmRunRe = /npm run ([a-z0-9:_-]+)/gi;
const testCountRe = /\b\d{1,4}[ \t]*(?:testes|tests)\b/gi;
const transitionalRe = /(claude\/[a-z0-9][a-z0-9-]*|session_[0-9A-Za-z]{6,}|eaas-2d-ecosystem-[a-z0-9]+)/g;
const schemaRefRe = /contracts\/schemas\/([a-z0-9._-]+\.json)/gi;
const verifyPhaseRe = /verify-phase([1-9][0-9]?)\.sh/g;

for (const file of walk(root)) {
  const rel = path.relative(root, file);
  const raw = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const noCode = stripFencedCode(raw);

  // 1. links Markdown internos (fora de blocos de código)
  for (const m of noCode.matchAll(linkRe)) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|tel:|#)/i.test(target)) continue;
    target = target.split("#")[0];
    if (!target) continue;
    if (!fs.existsSync(path.resolve(dir, target))) {
      errors.push(`${rel}: link/arquivo inexistente -> ${m[1]}`);
    }
  }

  // 2. referências a schemas contracts/schemas/*.json (texto inteiro)
  for (const m of raw.matchAll(schemaRefRe)) {
    if (!fs.existsSync(path.join(root, "contracts", "schemas", m[1]))) {
      errors.push(`${rel}: schema inexistente referenciado -> contracts/schemas/${m[1]}`);
    }
  }

  // 3. scripts verify-phaseN.sh citados existem
  for (const m of raw.matchAll(verifyPhaseRe)) {
    const sp = `scripts/verify-phase${m[1]}.sh`;
    if (!fs.existsSync(path.join(root, sp))) {
      errors.push(`${rel}: script citado inexistente -> ${sp}`);
    }
  }

  // 4. comandos npm run documentados existem em algum package.json
  for (const m of raw.matchAll(npmRunRe)) {
    if (!scripts.has(m[1])) {
      errors.push(`${rel}: comando 'npm run ${m[1]}' não existe em nenhum package.json`);
    }
  }

  // 5. referências transitórias a branches/sessões de geração
  for (const m of raw.matchAll(transitionalRe)) {
    errors.push(`${rel}: referência transitória (branch/sessão) -> ${m[1]}`);
  }

  // 6. contagens de teste fixadas manualmente (devem vir do CI)
  for (const m of raw.matchAll(testCountRe)) {
    errors.push(`${rel}: contagem de testes fixada manualmente -> "${m[0].trim()}" (derive do CI)`);
  }
}

if (errors.length === 0) {
  console.log("docs:verify OK — nenhuma violação encontrada.");
  process.exit(0);
}
console.error(`docs:verify FALHOU — ${errors.length} violação(ões):`);
for (const e of errors.sort()) console.error(`  - ${e}`);
process.exit(1);
