import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  BlueprintDocumentError,
  documentToCommands,
  migrateBlueprintDocument,
} from "../src/canonical/BlueprintSerializer.js";
import { createPlatformer2DDocument } from "../src/canonical/ProjectTemplates.js";

test("documento legado sem schemaVersion (v0) é migrado para a versão corrente", () => {
  const legacy: Record<string, unknown> = { ...createPlatformer2DDocument() };
  delete (legacy as { schemaVersion?: number }).schemaVersion;

  const migrated = migrateBlueprintDocument(legacy);
  assert.equal(migrated.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);

  // e continua reproduzível: gera os comandos sem lançar
  assert.equal(documentToCommands(legacy).length, 6);
});

test("schemaVersion 0 explícito também migra", () => {
  const doc = { ...createPlatformer2DDocument(), schemaVersion: 0 };
  assert.equal(migrateBlueprintDocument(doc).schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
});

test("documento v1 sem projectId recebe identidade legada determinística", () => {
  const legacyV1: Record<string, unknown> = {
    ...createPlatformer2DDocument(),
    schemaVersion: 1,
  };
  delete legacyV1["projectId"];

  const first = migrateBlueprintDocument(legacyV1);
  const second = migrateBlueprintDocument({ ...legacyV1 });

  assert.equal(first.schemaVersion, 2);
  assert.match(first.projectId, /^legacy-[0-9a-f]{24}$/);
  assert.equal(second.projectId, first.projectId);
});

test("versão futura é recusada com erro claro contendo a versão", () => {
  const doc = { ...createPlatformer2DDocument(), schemaVersion: 99 };
  assert.throws(
    () => migrateBlueprintDocument(doc),
    (err: unknown) =>
      err instanceof BlueprintDocumentError && /schemaVersion 99/.test((err as Error).message),
  );
});

test("entrada que não é objeto é recusada", () => {
  assert.throws(() => migrateBlueprintDocument(null), BlueprintDocumentError);
  assert.throws(() => migrateBlueprintDocument(42), BlueprintDocumentError);
});
