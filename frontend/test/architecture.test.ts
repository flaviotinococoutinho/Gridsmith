/**
 * TESTES ARQUITETURAIS do editor (fitness functions) — docs/GOVERNANCE.md.
 *
 * O Electron é uma shell fina: os núcleos de domínio devem permanecer puros
 * (portáveis para Worker Threads) e o renderer nunca vê Node/rede.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

interface Module {
  readonly file: string;
  /** [especificador, éTypeOnly] */
  readonly imports: readonly [string, boolean][];
}

function listModules(): Module[] {
  const files = fs
    .readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.split(path.sep).join("/"));

  return files.map((file) => {
    const source = fs.readFileSync(path.join(SRC, file), "utf8");
    const imports: [string, boolean][] = [];
    const pattern = /import\s+(type\s+)?[^"']*?from\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      imports.push([match[2]!, match[1] !== undefined]);
    }
    return { file, imports };
  });
}

const modules = listModules();

test("F1: núcleos de domínio (core/) são puros — sem Electron, Node ou middleware", () => {
  const offenders: string[] = [];
  for (const module_ of modules.filter((m) => m.file.startsWith("core/"))) {
    for (const [specifier] of module_.imports) {
      const external =
        specifier === "electron" ||
        specifier.startsWith("node:") ||
        specifier.startsWith("@p7m/") ||
        (!specifier.startsWith(".") && !specifier.startsWith("node:"));
      if (external) offenders.push(`${module_.file} → ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], "core/ must be portable to Worker Threads");
});

test("F2: o renderer nunca importa Electron nem Node — só core/ e tipos do preload", () => {
  const offenders: string[] = [];
  for (const module_ of modules.filter((m) => m.file.startsWith("renderer/"))) {
    for (const [specifier, isTypeOnly] of module_.imports) {
      if (specifier === "electron" || specifier.startsWith("node:")) {
        offenders.push(`${module_.file} → ${specifier}`);
      }
      // imports de main/ só como type (contrato da API window.p7m)
      if (specifier.includes("/main/") && !isTypeOnly) {
        offenders.push(`${module_.file} → ${specifier} (runtime import from main)`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("F3: Electron só existe no processo main/ (contextIsolation por construção)", () => {
  const offenders: string[] = [];
  for (const module_ of modules.filter((m) => !m.file.startsWith("main/"))) {
    for (const [specifier] of module_.imports) {
      if (specifier === "electron") offenders.push(`${module_.file} → electron`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("F4: o frontend nunca reimplementa protocolo — JSON-RPC/framing vêm do middleware", () => {
  // nenhum arquivo do frontend pode declarar framing próprio (uint32 header)
  for (const module_ of modules) {
    const source = fs.readFileSync(path.join(SRC, module_.file), "utf8");
    assert.ok(
      !/writeUInt32LE|readUInt32LE/.test(source),
      `${module_.file} must not hand-roll wire framing (use @p7m/middleware peers)`,
    );
  }
});
