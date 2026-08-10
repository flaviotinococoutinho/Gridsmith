import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  BLUEPRINT_DOCUMENT_VERSION,
  BlueprintDocumentError,
  DEFAULT_PROJECT_METADATA,
  documentToCommands,
  exportBlueprint,
  migrateBlueprintDocument,
  replayDocument,
  type BlueprintDocument,
} from "../src/canonical/BlueprintSerializer.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { recognizeLegacyV2Document } from "../src/canonical/legacyBlueprintShapes.js";
import { createPlatformer2DDocument } from "../src/canonical/ProjectTemplates.js";
import { BlueprintStore } from "../src/domain/BlueprintStore.js";

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

  // a identidade legada nasce na 1 → 2 e sobrevive ao resto da cadeia
  assert.equal(first.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
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

// ---------------------------------------------------------------------------
// Migração 2 → 3: os quatro ramos, um teste nomeado por ramo.
//
// O corpus em `test/fixtures/documents/` foi gerado com a build que ainda
// emitia v2, por replay + export — a forma REALMENTE gravada em disco, com os
// defaults de campo materializados. São bytes congelados: nunca regenere um
// arquivo do corpus, só acrescente novos a cada bump. Regenerá-lo apagaria a
// única prova de que documentos antigos ainda abrem.
// ---------------------------------------------------------------------------

const FIXTURES = path.join(import.meta.dirname, "fixtures", "documents");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

const positionsOf = (doc: BlueprintDocument): unknown[] => [
  ...doc.entities.map((e) => e.position),
  ...doc.lights.map((l) => l.position),
];

test("ramo (a): template de plataforma PRÉ-correção tem as posições convertidas para pixels", () => {
  const migrated = migrateBlueprintDocument(fixture("v2-platformer-base"));

  assert.equal(migrated.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.equal(migrated.metadata.name, "Plataforma 2D");
  // [2, 7] em células → centro da célula em pixels
  assert.deepEqual(migrated.entities[0]?.position, [40, 120]);
  // meia célula [8, 4.5]: ver a escolha registrada em `legacyAxisToWorld`
  assert.deepEqual(migrated.lights[0]?.position, [136, 80]);
});

test("ramo (a): o documento migrado é IDÊNTICO ao que o template emite hoje", () => {
  // Esta é a razão de a conversão da luz valer [136, 80] e não [136, 72]:
  // abrir um projeto antigo e criar um projeto novo têm de dar o mesmo jogo.
  const migrated = migrateBlueprintDocument(fixture("v2-platformer-base"));
  const novo = createPlatformer2DDocument();

  assert.deepEqual(positionsOf(migrated), positionsOf(novo));
  assert.equal(migrated.metadata.name, novo.metadata.name);
});

test("ramo (b): template de plataforma PÓS-correção não tem nenhuma posição alterada", () => {
  const original = fixture("v2-platformer-main");
  const migrated = migrateBlueprintDocument(structuredClone(original));

  assert.equal(migrated.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.equal(migrated.metadata.name, "Plataforma 2D");
  assert.deepEqual(
    positionsOf(migrated),
    positionsOf(original as unknown as BlueprintDocument),
  );
});

test("ramo (c): template top-down é reconhecido e não tem posição alterada", () => {
  const original = fixture("v2-topdown-main");
  const migrated = migrateBlueprintDocument(structuredClone(original));

  assert.equal(migrated.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.equal(migrated.metadata.name, "Aventura top-down");
  assert.deepEqual(
    positionsOf(migrated),
    positionsOf(original as unknown as BlueprintDocument),
  );
});

test("ramo (d): documento editado à mão NUNCA tem coordenada convertida", () => {
  // O player está em [3, 7] de propósito: números pequenos que PARECEM célula.
  // Qualquer heurística por magnitude destruiria este projeto.
  const original = fixture("v2-editado-a-mao");
  const migrated = migrateBlueprintDocument(structuredClone(original));

  assert.equal(migrated.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.equal(migrated.metadata.name, "Projeto importado");
  assert.deepEqual(
    positionsOf(migrated),
    positionsOf(original as unknown as BlueprintDocument),
  );
  assert.deepEqual(migrated.entities[0]?.position, [3, 7]);
});

test("todo documento do corpus migra, reproduz e reexporta de forma idempotente", async () => {
  const nomes = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
  assert.ok(nomes.length >= 4, "o corpus precisa cobrir os quatro ramos");

  for (const nome of nomes) {
    const documento = JSON.parse(readFileSync(path.join(FIXTURES, nome), "utf8")) as unknown;

    const migrado = migrateBlueprintDocument(documento);
    assert.equal(migrado.schemaVersion, BLUEPRINT_DOCUMENT_VERSION, nome);

    // reproduz pelo caminho canônico sem lançar
    const store = new BlueprintStore();
    await replayDocument(migrado, store, new CanonicalOrchestrator(store, new HookBus()));

    // e reexportar → migrar de novo não muda mais nada
    const reexportado = exportBlueprint(store, migrado.projectId, migrado.metadata);
    const remigrado = migrateBlueprintDocument(structuredClone(reexportado) as unknown);
    assert.deepEqual(remigrado, reexportado, `${nome}: migração não é idempotente`);
  }
});

test("os shapes congelados ainda reconhecem as fixtures do corpus", () => {
  // Se este teste falhar, um shape em `legacyBlueprintShapes.ts` divergiu do
  // documento real que ele descreve — e a conversão de coordenadas do ramo (a)
  // deixaria de disparar EM SILÊNCIO, corrompendo projetos legados.
  assert.deepEqual(recognizeLegacyV2Document(fixture("v2-platformer-base")), {
    projectName: "Plataforma 2D",
    positionsInCells: true,
  });
  assert.deepEqual(recognizeLegacyV2Document(fixture("v2-platformer-main")), {
    projectName: "Plataforma 2D",
    positionsInCells: false,
  });
  assert.deepEqual(recognizeLegacyV2Document(fixture("v2-topdown-main")), {
    projectName: "Aventura top-down",
    positionsInCells: false,
  });
  assert.equal(recognizeLegacyV2Document(fixture("v2-editado-a-mao")), undefined);
});

test("os fingerprints da forma CRUA do factory também estão vivos", () => {
  // Cada origem rende dois documentos: o factory devolve a entidade com
  // `fields: {}` e o replay materializa os defaults antes de gravar. O corpus
  // em disco só tem a forma materializada — é a que o fluxo "Novo projeto"
  // produz —, então sem este teste as três entradas da forma crua seriam
  // código morto que ninguém notaria parar de casar.
  const semFields = (nome: string): Record<string, unknown> => {
    const doc = fixture(nome);
    const entities = (doc["entities"] as Record<string, unknown>[]).map((e) => ({
      ...e,
      fields: {},
    }));
    return { ...doc, entities };
  };

  assert.deepEqual(recognizeLegacyV2Document(semFields("v2-platformer-base")), {
    projectName: "Plataforma 2D",
    positionsInCells: true,
  });
  assert.deepEqual(recognizeLegacyV2Document(semFields("v2-platformer-main")), {
    projectName: "Plataforma 2D",
    positionsInCells: false,
  });
  assert.deepEqual(recognizeLegacyV2Document(semFields("v2-topdown-main")), {
    projectName: "Aventura top-down",
    positionsInCells: false,
  });
});

test("documento v3 sem metadata é recusado", () => {
  const semMetadata: Record<string, unknown> = { ...createPlatformer2DDocument() };
  delete semMetadata["metadata"];
  // schemaVersion já é a corrente, então nenhuma migração carimba metadata:
  // a validação estrutural precisa pegar.
  assert.throws(() => migrateBlueprintDocument(semMetadata), BlueprintDocumentError);
});

test("documento que já traz metadata válida atravessa a 2 → 3 intacto", () => {
  const doc = {
    ...(fixture("v2-platformer-base") as unknown as BlueprintDocument),
    metadata: { ...DEFAULT_PROJECT_METADATA, name: "Nome escolhido pelo usuário" },
  };

  const migrated = migrateBlueprintDocument(doc);

  assert.equal(migrated.metadata.name, "Nome escolhido pelo usuário");
  // e, por trazer metadata, NÃO é tratado como template legado: sem conversão
  assert.deepEqual(migrated.entities[0]?.position, [2, 7]);
});

// ---------------------------------------------------------------------------
// Migração 3 → 4: a paleta deixa de ser constante de build do editor
// ---------------------------------------------------------------------------

test("v3 → v4 dá a paleta default a todo nível que não tinha", () => {
  const migrated = migrateBlueprintDocument(fixture("v3-platformer"));

  assert.equal(migrated.schemaVersion, BLUEPRINT_DOCUMENT_VERSION);
  assert.deepEqual(
    migrated.levels[0]?.palette,
    [
      { value: 1, name: "Chão", color: "#7a5230" },
      { value: 2, name: "Parede", color: "#5a6a7a" },
      { value: 3, name: "Perigo", color: "#b8433a" },
    ],
    "o vocabulário que o editor trazia hardcoded passa a viver no documento",
  );
  assert.deepEqual(migrated.entities[0]?.position, [40, 120], "nada mais foi tocado");
});

test("v3 → v4 nomeia também os significados pintados fora da paleta do editor", () => {
  // Um agente (ou uma edição manual) pode ter pintado 7. Sem entrada, esse
  // significado ficaria invisível na UI depois da migração.
  const doc = fixture("v3-platformer");
  const levels = doc["levels"] as Record<string, unknown>[];
  const grid = [...(levels[0]!["intGrid"] as number[])];
  grid[5] = 7;
  levels[0] = { ...levels[0], intGrid: grid };

  const migrated = migrateBlueprintDocument(doc);
  const sete = migrated.levels[0]?.palette?.find((entry) => entry.value === 7);

  assert.ok(sete, "o valor 7 ganhou entrada");
  assert.match(sete.color, /^#[0-9a-f]{6}$/);
  assert.equal(
    migrateBlueprintDocument(fixture("v3-platformer")).levels[0]?.palette?.length,
    3,
    "e um nível sem valores extras continua com as três entradas default",
  );
});

test("a paleta NÃO entra na impressão digital da 2 → 3", () => {
  // Armadilha que a receita marca como SILENCIOSA: a partir da v4, fixtures e
  // factories que simulam v2 podem carregar `palette`. Sem o strip, o
  // fingerprint do template pré-correção deixaria de casar e a conversão de
  // coordenadas simplesmente não dispararia — sem erro nenhum.
  const comPaleta = fixture("v2-platformer-base");
  const levels = comPaleta["levels"] as Record<string, unknown>[];
  levels[0] = { ...levels[0], palette: [{ value: 1, name: "Chão", color: "#7a5230" }] };

  const migrated = migrateBlueprintDocument(comPaleta);

  assert.equal(migrated.metadata.name, "Plataforma 2D", "a origem continua reconhecida");
  assert.deepEqual(migrated.entities[0]?.position, [40, 120], "a conversão disparou");
});
