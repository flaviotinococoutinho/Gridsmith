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

  assert.equal(first.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.match(first.projectId, /^legacy-[0-9a-f]{24}$/);
  assert.equal(second.projectId, first.projectId);
});

test("documento v2 ganha unidade espacial explícita sem converter posições", () => {
  const current = createPlatformer2DDocument();
  const legacyV2: Record<string, unknown> = {
    ...current,
    schemaVersion: 2,
    entities: [{ ...current.entities[0]!, position: [48, 112] }],
    lights: [{ ...current.lights[0]!, position: [128, 72] }],
  };
  delete legacyV2["metadata"];

  const migrated = migrateBlueprintDocument(legacyV2);

  assert.equal(migrated.metadata.spatial.positionUnit, "world-pixel");
  assert.equal(migrated.metadata.spatial.cellOrigin, "top-left");
  assert.deepEqual(migrated.entities[0]?.position, [48, 112]);
  assert.deepEqual(migrated.lights[0]?.position, [128, 72]);
  assert.deepEqual(migrated.metadata.referenceResolution, { width: 1280, height: 720 });
});

test("template v2 histórico converte somente as coordenadas de célula conhecidas", () => {
  const current = createPlatformer2DDocument();
  const historicalV2: Record<string, unknown> = {
    ...current,
    schemaVersion: 2,
    // createFromTemplate histórico substituía o ID fixo do factory antes de
    // o documento ser salvo e o replay materializava defaults nos fields.
    projectId: "3e2458b5-59ab-4b3a-b31e-2b326b90590e",
    entities: [{
      ...current.entities[0]!,
      position: [2, 7],
      fields: { speed: 90, jumpVelocity: 320 },
    }],
    lights: [{ ...current.lights[0]!, position: [8, 4.5] }],
  };
  delete historicalV2["metadata"];

  const migrated = migrateBlueprintDocument(historicalV2);

  assert.deepEqual(migrated.entities[0]?.position, [40, 120]);
  assert.deepEqual(migrated.lights[0]?.position, [136, 72]);
  assert.equal(migrated.metadata.name, "Plataforma 2D");
  assert.deepEqual(migrated.metadata.referenceResolution, { width: 1280, height: 720 });
});

test("migração espacial não usa heurística em documento apenas parecido com o template", () => {
  const current = createPlatformer2DDocument();
  const editedV2: Record<string, unknown> = {
    ...current,
    schemaVersion: 2,
    projectId: "uuid-edited-project",
    camera: { ...current.camera, frequency: 3 },
    entities: [{ ...current.entities[0]!, position: [2, 7] }],
    lights: [{ ...current.lights[0]!, position: [8, 4.5] }],
  };
  delete editedV2["metadata"];

  const migrated = migrateBlueprintDocument(editedV2);

  assert.deepEqual(migrated.entities[0]?.position, [2, 7]);
  assert.deepEqual(migrated.lights[0]?.position, [8, 4.5]);
  assert.equal(migrated.metadata.name, "Projeto importado");
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
