import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PendingEditCoordinator } from "../src/core/pendingEditCoordinator.js";
import { SelectionService } from "../src/core/selectionService.js";
import {
  requireAppliedInspectorCommit,
  schemaInspectorCommitKey,
  schemaInspectorFocusKey,
} from "../src/renderer/schemaInspectorView.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(ROOT, "src/renderer/schemaInspectorView.ts"),
  "utf8",
);

test("SchemaInspector: chave semântica de foco não colide por delimitadores", () => {
  assert.equal(
    schemaInspectorFocusKey("entity.instance", "position", "component-0"),
    '["entity.instance","position","component-0"]',
  );
  assert.notEqual(
    schemaInspectorFocusKey("a:b", "c", "value"),
    schemaInspectorFocusKey("a", "b:c", "value"),
  );
});

test("SchemaInspector: rerender captura e restaura controle e seleção semânticos", () => {
  assert.match(source, /const focus = captureSemanticFocus\(options\.host\)/);
  assert.match(source, /restoreSemanticFocus\(options\.host, focus\)/);
  assert.match(source, /data-inspector-focus-key/);
  assert.match(source, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /target\.setSelectionRange\(/);
});

test("SchemaInspector: edit e reset expõem commits em voo ao boundary de Save/Close", () => {
  assert.match(
    source,
    /readonly trackCommit\?: <T>\(key: string, promise: Promise<T>\) => Promise<T>/,
  );
  assert.match(source, /requireAppliedInspectorCommit\(options\.registry\.reset\(/);
  assert.match(source, /requireAppliedInspectorCommit\(options\.registry\.edit\(/);
  assert.equal(
    source.match(/trackInspectorCommit\(options, trackedCommitKey, commit\)/g)?.length,
    2,
  );
  assert.match(
    source,
    /return options\.trackCommit\?\.\(key, promise\) \?\? promise/,
  );
});

test("SchemaInspector: validação recusada bloqueia Save/Close até correção do mesmo campo", async () => {
  const coordinator = new PendingEditCoordinator();
  const key = "session-a/entity-a/position";
  const invalid = Promise.resolve({
    applied: false,
    issues: [{ code: "range", message: "Posição inválida.", severity: "error" as const }],
    applyMode: "immediate" as const,
    restartRequired: false,
  });

  await assert.rejects(
    coordinator.track(key, requireAppliedInspectorCommit(invalid)),
    /Posição inválida/,
  );
  await assert.rejects(coordinator.flush(), /Posição inválida/);

  await coordinator.track(key, requireAppliedInspectorCommit(Promise.resolve({
    applied: true,
    issues: [],
    applyMode: "immediate",
    restartRequired: false,
  })));
  await coordinator.flush();
});

test("SchemaInspector: chave de commit separa sessão e identidade da seleção", () => {
  const contextFor = (sessionId: string, entityId: string, levelId?: string) => {
    const selection = new SelectionService(sessionId);
    selection.select({
      kind: "entity-instance",
      projectSessionId: sessionId,
      projectId: `project-${sessionId}`,
      entityId,
      ...(levelId ? { levelId } : {}),
    });
    return { selection, capabilities: () => ({ enabled: true, reason: "teste" }), mode: "edit" as const };
  };

  const a = schemaInspectorCommitKey("entity.instance", "position", contextFor("a", "entity-a"));
  const b = schemaInspectorCommitKey("entity.instance", "position", contextFor("a", "entity-b"));
  const nextSession = schemaInspectorCommitKey("entity.instance", "position", contextFor("b", "entity-a"));
  assert.notEqual(a, b);
  assert.notEqual(a, nextSession);
  assert.equal(
    a,
    schemaInspectorCommitKey("entity.instance", "position", contextFor("a", "entity-a", "level-1")),
    "a árvore e o canvas devem corrigir a mesma falha pendente da entidade",
  );
});

test("SchemaInspector: chave de células ignora index/anchor e ordem incidentais", () => {
  const contextFor = (reverse: boolean, includeDerived: boolean) => {
    const selection = new SelectionService("session-a");
    const cells = reverse ? [{ x: 2, y: 1 }, { x: 1, y: 1 }] : [{ x: 1, y: 1 }, { x: 2, y: 1 }];
    selection.select({
      kind: "cell",
      projectSessionId: "session-a",
      projectId: "project-a",
      levelId: "level-1",
      cells: cells.map((cell, index) => includeDerived ? { ...cell, index: 10 + index } : cell),
      ...(includeDerived ? { anchor: { x: 2, y: 1, index: 12 } } : {}),
    });
    return { selection, capabilities: () => ({ enabled: true }), mode: "edit" as const };
  };
  assert.equal(
    schemaInspectorCommitKey("level.cell", "value", contextFor(false, false)),
    schemaInspectorCommitKey("level.cell", "value", contextFor(true, true)),
  );
});

test("SchemaInspector: label simples nunca envolve editor composto", () => {
  assert.match(
    source,
    /if \(editor\.controls\.length === 1 && editor\.root === editor\.controls\[0\]\)[\s\S]*?label\.append\(labelText, editor\.root\);[\s\S]*?else \{[\s\S]*?role", "group"/,
  );
  assert.match(source, /editor\.root\.setAttribute\("aria-labelledby", labelText\.id\)/);
});

test("SchemaInspector: color e vector rotulam cada input real", () => {
  assert.match(source, /controls: \[input, text\]/);
  assert.match(source, /controlLabels: \["Seletor visual", "Valor textual"\]/);
  assert.match(source, /controls: inputs/);
  assert.match(source, /schema\?\.componentLabels\?\.\[index\] \?\? `Componente \$\{index \+ 1\}`/);
  assert.match(source, /control\.setAttribute\("aria-label", `\$\{field\.schema\.label\}: \$\{partLabel\}`\)/);
});

test("SchemaInspector: describedby, invalid e disabled pertencem aos controles reais", () => {
  assert.match(
    source,
    /for \(const control of editor\.controls\) \{[\s\S]*?control\.setAttribute\("aria-describedby", describedBy\);[\s\S]*?control\.setAttribute\("aria-invalid", String\(invalid\)\);[\s\S]*?control\.disabled = !enabled/,
  );
  assert.doesNotMatch(source, /editor\.root\.setAttribute\("aria-describedby"/);
  assert.doesNotMatch(source, /editor\.root\.setAttribute\("aria-invalid"/);
});
