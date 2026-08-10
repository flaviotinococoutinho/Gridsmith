import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BlueprintStore,
  type BlueprintCommand,
  type EntityDefinition,
  type LevelSpec,
  type LightSpec,
} from "../src/domain/BlueprintStore.js";
import { RpcErrorCode } from "../src/protocol/jsonrpc.js";

// ---------------------------------------------------------------------------
// Fixtures mínimas
// ---------------------------------------------------------------------------

const light = (lightId: string, intensity = 1): LightSpec => ({
  lightId,
  type: "point",
  position: [10, 20],
  color: [1, 1, 1],
  intensity,
  radius: 100,
});

const level = (levelId: string, seed = 1): LevelSpec => ({
  levelId,
  width: 4,
  height: 4,
  tileSize: 16,
  seed,
  intGrid: new Array<number>(16).fill(0),
  rules: [{ patternSize: 1, pattern: [1], tileIds: [1] }],
});

const definition = (entityDefId: string, speedDefault = 10): EntityDefinition => ({
  entityDefId,
  archetypeId: "player",
  fields: [{ name: "speed", type: "float", default: speedDefault }],
});

function storeWith(...commands: readonly BlueprintCommand[]): BlueprintStore {
  const store = new BlueprintStore();
  for (const command of commands) store.apply(command);
  return store;
}

function errorCode(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: number }).code;
  }
}

// ---------------------------------------------------------------------------
// Atomicidade do lote
// ---------------------------------------------------------------------------

test("falha no terceiro comando NÃO aplica os dois primeiros", () => {
  const store = new BlueprintStore();

  assert.throws(() =>
    store.planBatch([
      { kind: "light/add", light: light("a") },
      { kind: "light/add", light: light("b") },
      { kind: "light/add", light: light("a") }, // id duplicado
    ]),
  );

  assert.deepEqual(store.listLights(), [], "nenhuma luz do lote sobreviveu");
  assert.equal(store.mutationVersion, 0, "a versão de mutação não avançou");
});

test("o lote só muda o store no commit, nunca no plano", () => {
  const store = new BlueprintStore();
  const plan = store.planBatch([{ kind: "light/add", light: light("a") }]);

  assert.deepEqual(store.listLights(), [], "planejar não muda nada");
  store.commitBatch(plan);
  assert.deepEqual(
    store.listLights().map((l) => l.lightId),
    ["a"],
  );
});

test("comitar um plano obsoleto é CONFLITO, não sobrescrita silenciosa", () => {
  const store = new BlueprintStore();
  const primeiro = store.planBatch([{ kind: "light/add", light: light("a") }]);
  const segundo = store.planBatch([{ kind: "light/add", light: light("b") }]);

  store.commitBatch(primeiro);

  // `segundo` foi planejado sobre a versão anterior: adotá-lo agora apagaria
  // a luz "a" sem que ninguém percebesse.
  assert.equal(errorCode(() => store.commitBatch(segundo)), RpcErrorCode.ProjectSessionConflict);
  assert.deepEqual(
    store.listLights().map((l) => l.lightId),
    ["a"],
  );
});

test("plano preparado por OUTRO store é recusado", () => {
  const a = new BlueprintStore();
  const b = new BlueprintStore();
  const plan = b.planBatch([{ kind: "light/add", light: light("x") }]);

  assert.equal(errorCode(() => a.commitBatch(plan)), RpcErrorCode.ProjectSessionConflict);
});

// ---------------------------------------------------------------------------
// Round-trip apply → inverso, por kind
// ---------------------------------------------------------------------------

/** Aplica, desfaz pelo inverso, e exige que o estado volte ao que era. */
function assertRoundTrip(
  nome: string,
  store: BlueprintStore,
  command: BlueprintCommand,
): void {
  const snapshot = (): unknown => ({
    camera: store.cameraSettings,
    lights: store.listLights(),
    entityDefs: store.listEntityDefs(),
    entities: store.listEntities(),
    levels: store.listLevels(),
    placements: store.listPlacements(),
  });

  const antes = JSON.parse(JSON.stringify(snapshot())) as unknown;
  const { inverse, barrier } = store.applyWithInverse(command);
  assert.equal(barrier, false, `${nome}: não deveria ser barreira`);
  assert.ok(inverse.length > 0, `${nome}: inverso vazio`);

  for (const undo of inverse) store.apply(undo);
  assert.deepEqual(
    JSON.parse(JSON.stringify(snapshot())),
    antes,
    `${nome}: desfazer não restaurou o estado`,
  );
}

test("round-trip do inverso restaura o estado, kind a kind", () => {
  assertRoundTrip("camera/configure", storeWith({ kind: "camera/configure", settings: { damping: 1 } }), {
    kind: "camera/configure",
    settings: { damping: 2, frequency: 3 },
  });

  assertRoundTrip("light/add", new BlueprintStore(), { kind: "light/add", light: light("a") });

  assertRoundTrip(
    "light/update",
    storeWith({ kind: "light/add", light: light("a", 1) }),
    { kind: "light/update", light: light("a", 5) },
  );

  assertRoundTrip("light/remove", storeWith({ kind: "light/add", light: light("a") }), {
    kind: "light/remove",
    lightId: "a",
  });

  assertRoundTrip("entitydef/define", new BlueprintStore(), {
    kind: "entitydef/define",
    definition: definition("hero"),
  });

  assertRoundTrip(
    "entitydef/update",
    storeWith({ kind: "entitydef/define", definition: definition("hero") }),
    { kind: "entitydef/update", definition: { ...definition("hero"), tags: ["novo"] } },
  );

  assertRoundTrip(
    "entitydef/remove",
    storeWith({ kind: "entitydef/define", definition: definition("hero") }),
    { kind: "entitydef/remove", entityDefId: "hero" },
  );

  const comHero = (): BlueprintStore =>
    storeWith(
      { kind: "entitydef/define", definition: definition("hero") },
      {
        kind: "entity/place",
        entity: { entityId: "h1", entityDefId: "hero", position: [0, 0], fields: {} },
      },
    );

  assertRoundTrip("entity/place", storeWith({ kind: "entitydef/define", definition: definition("hero") }), {
    kind: "entity/place",
    entity: { entityId: "h1", entityDefId: "hero", position: [1, 2], fields: {} },
  });

  assertRoundTrip("entity/move", comHero(), { kind: "entity/move", entityId: "h1", position: [9, 9] });

  assertRoundTrip("entity/properties", comHero(), {
    kind: "entity/properties",
    entityId: "h1",
    changes: [{ name: "speed", before: 10, after: 42 }],
  });

  assertRoundTrip("entity/remove", comHero(), { kind: "entity/remove", entityId: "h1" });

  assertRoundTrip("level/define", new BlueprintStore(), { kind: "level/define", level: level("l1") });

  assertRoundTrip("level/update", storeWith({ kind: "level/define", level: level("l1", 1) }), {
    kind: "level/update",
    level: level("l1", 7),
  });

  assertRoundTrip("world/place", storeWith({ kind: "level/define", level: level("l1") }), {
    kind: "world/place",
    placement: { levelId: "l1", x: 100, y: 100 },
  });

  assertRoundTrip(
    "world/unplace",
    storeWith(
      { kind: "level/define", level: level("l1") },
      { kind: "world/place", placement: { levelId: "l1", x: 0, y: 0 } },
    ),
    { kind: "world/unplace", levelId: "l1" },
  );
});

test("desfazer level/remove devolve TAMBÉM a posição no world map", () => {
  // Sem o segundo comando no inverso, desfazer a remoção traria o nível de
  // volta sem lugar nenhum — e o usuário teria de reposicioná-lo à mão.
  const store = storeWith(
    { kind: "level/define", level: level("l1") },
    { kind: "world/place", placement: { levelId: "l1", x: 64, y: 32 } },
  );

  const { inverse } = store.applyWithInverse({ kind: "level/remove", levelId: "l1" });
  assert.deepEqual(
    inverse.map((c) => c.kind),
    ["level/define", "world/place"],
  );

  for (const undo of inverse) store.apply(undo);
  assert.deepEqual(store.listPlacements(), [{ levelId: "l1", x: 64, y: 32 }]);
});

test("skeleton/define e mesh/bind são BARREIRA: sem inverso", () => {
  const store = new BlueprintStore();
  const skeleton = {
    skeletonId: "s1",
    bones: [{ id: 0, parentId: -1, inverseBindMatrix: [1, 0, 0, 1, 0, 0] }],
  };

  const esqueleto = store.applyWithInverse({ kind: "skeleton/define", skeleton });
  assert.equal(esqueleto.barrier, true);
  assert.deepEqual(esqueleto.inverse, []);

  const malha = store.applyWithInverse({
    kind: "mesh/bind",
    binding: {
      meshId: "m1",
      skeletonId: "s1",
      sharedMemoryMapName: "map",
      vertexCount: 3,
      strideInBytes: 8,
    },
  });
  assert.equal(malha.barrier, true);
  assert.deepEqual(malha.inverse, []);
});

// ---------------------------------------------------------------------------
// Rejeição de no-op
// ---------------------------------------------------------------------------

test("comando que não muda nada é RECUSADO", () => {
  // Um no-op aceito viraria entrada de histórico vazia: o usuário apertaria
  // Ctrl+Z e nada aconteceria na tela.
  const store = storeWith(
    { kind: "camera/configure", settings: { damping: 1 } },
    { kind: "light/add", light: light("a", 2) },
    { kind: "level/define", level: level("l1") },
    { kind: "world/place", placement: { levelId: "l1", x: 5, y: 5 } },
    { kind: "entitydef/define", definition: definition("hero") },
    {
      kind: "entity/place",
      entity: { entityId: "h1", entityDefId: "hero", position: [3, 4], fields: {} },
    },
  );

  for (const [nome, command] of [
    ["camera/configure", { kind: "camera/configure", settings: { damping: 1 } }],
    ["light/update", { kind: "light/update", light: light("a", 2) }],
    ["entity/move", { kind: "entity/move", entityId: "h1", position: [3, 4] }],
    ["world/place", { kind: "world/place", placement: { levelId: "l1", x: 5, y: 5 } }],
    ["level/update", { kind: "level/update", level: level("l1") }],
    ["entitydef/update", { kind: "entitydef/update", definition: definition("hero") }],
    [
      "entity/properties",
      {
        kind: "entity/properties",
        entityId: "h1",
        changes: [{ name: "speed", before: 10, after: 10 }],
      },
    ],
  ] as const) {
    assert.equal(
      errorCode(() => store.apply(command as BlueprintCommand)),
      RpcErrorCode.InvalidParams,
      `${nome}: no-op deveria ser recusado`,
    );
  }
});

// ---------------------------------------------------------------------------
// Validações dos kinds novos
// ---------------------------------------------------------------------------

test("entitydef/update recusa trocar o archetype com instâncias vivas", () => {
  const store = storeWith(
    { kind: "entitydef/define", definition: definition("hero") },
    {
      kind: "entity/place",
      entity: { entityId: "h1", entityDefId: "hero", position: [0, 0], fields: {} },
    },
  );

  assert.throws(
    () =>
      store.apply({
        kind: "entitydef/update",
        definition: { ...definition("hero"), archetypeId: "outro" },
      }),
    /archetype .* while 1 instance/,
  );
  // e sem instâncias a mesma troca passa
  const semInstancia = storeWith({ kind: "entitydef/define", definition: definition("hero") });
  semInstancia.apply({
    kind: "entitydef/update",
    definition: { ...definition("hero"), archetypeId: "outro" },
  });
  assert.equal(semInstancia.getEntityDef("hero")?.archetypeId, "outro");
});

test("entitydef/update recusa mudar implicitamente os campos já resolvidos", () => {
  const store = storeWith(
    { kind: "entitydef/define", definition: definition("hero", 10) },
    {
      kind: "entity/place",
      entity: { entityId: "h1", entityDefId: "hero", position: [0, 0], fields: {} },
    },
  );

  // a instância materializou speed=10; um campo novo obrigatório mudaria os
  // campos resolvidos dela sem que ninguém tivesse pedido
  assert.throws(
    () =>
      store.apply({
        kind: "entitydef/update",
        definition: {
          ...definition("hero", 10),
          fields: [
            { name: "speed", type: "float", default: 10 },
            { name: "vida", type: "int", default: 3 },
          ],
        },
      }),
    /resolved fields changed implicitly|would become invalid/,
  );
});

test("entitydef/remove recusa enquanto houver instâncias", () => {
  const store = storeWith(
    { kind: "entitydef/define", definition: definition("hero") },
    {
      kind: "entity/place",
      entity: { entityId: "h1", entityDefId: "hero", position: [0, 0], fields: {} },
    },
  );

  assert.throws(
    () => store.apply({ kind: "entitydef/remove", entityDefId: "hero" }),
    /still has 1 instance/,
  );

  store.apply({ kind: "entity/remove", entityId: "h1" });
  store.apply({ kind: "entitydef/remove", entityDefId: "hero" });
  assert.equal(store.getEntityDef("hero"), undefined);
});

test("entity/properties com `before` desatualizado é CONFLITO", () => {
  const store = storeWith(
    { kind: "entitydef/define", definition: definition("hero", 10) },
    {
      kind: "entity/place",
      entity: { entityId: "h1", entityDefId: "hero", position: [0, 0], fields: {} },
    },
  );

  // o cliente leu speed=99 (valor que nunca existiu): editar sobre leitura
  // velha não é parâmetro inválido, é conflito
  assert.equal(
    errorCode(() =>
      store.apply({
        kind: "entity/properties",
        entityId: "h1",
        changes: [{ name: "speed", before: 99, after: 1 }],
      }),
    ),
    RpcErrorCode.ProjectSessionConflict,
  );
});

test("entity/properties valida o valor novo contra o tipo do campo", () => {
  const store = storeWith(
    { kind: "entitydef/define", definition: definition("hero", 10) },
    {
      kind: "entity/place",
      entity: { entityId: "h1", entityDefId: "hero", position: [0, 0], fields: {} },
    },
  );

  assert.equal(
    errorCode(() =>
      store.apply({
        kind: "entity/properties",
        entityId: "h1",
        changes: [{ name: "speed", before: 10, after: "rápido" }],
      }),
    ),
    RpcErrorCode.InvalidParams,
  );
  assert.equal(
    errorCode(() =>
      store.apply({
        kind: "entity/properties",
        entityId: "h1",
        changes: [{ name: "naoDeclarado", before: undefined, after: 1 }],
      }),
    ),
    RpcErrorCode.InvalidParams,
  );
});

test("camera/configure com `replace` substitui em vez de mesclar", () => {
  const store = storeWith({
    kind: "camera/configure",
    settings: { damping: 1, frequency: 2, response: 3 },
  });

  store.apply({ kind: "camera/configure", settings: { damping: 9 } });
  assert.deepEqual(store.cameraSettings, { damping: 9, frequency: 2, response: 3 }, "merge parcial");

  store.apply({ kind: "camera/configure", settings: { damping: 9 }, replace: true });
  assert.deepEqual(store.cameraSettings, { damping: 9 }, "replace descarta o resto");
});

test("o fork é independente: mutar o rascunho não toca o original", () => {
  const store = storeWith({ kind: "light/add", light: light("a") });
  const draft = store.fork();

  draft.apply({ kind: "light/add", light: light("b") });

  assert.deepEqual(
    store.listLights().map((l) => l.lightId),
    ["a"],
  );
  assert.deepEqual(
    draft.listLights().map((l) => l.lightId),
    ["a", "b"],
  );
});

// ---------------------------------------------------------------------------
// Proveniência
// ---------------------------------------------------------------------------

test("a proveniência vem da BORDA; o payload não consegue forjá-la", async () => {
  const { CanonicalOrchestrator } = await import("../src/canonical/CanonicalOrchestrator.js");
  const { HookBus } = await import("../src/canonical/HookBus.js");
  const { reshapeCommand } = await import("../src/canonical/commandShape.js");

  // um cliente malicioso tenta se declarar humano no payload
  const forjado = reshapeCommand("light/add", {
    ...light("a"),
    metadata: { actor: "human" },
    transactionId: "gesto-1",
  });

  assert.equal(forjado.metadata, undefined, "o actor do payload é descartado no reshape");
  assert.equal(forjado.transactionId, "gesto-1", "o id de gesto, esse sim, é do cliente");

  const store = new BlueprintStore();
  const orchestrator = new CanonicalOrchestrator(store, new HookBus());
  await orchestrator.dispatch(forjado, { actor: "agent" });

  const registrado = orchestrator.history.list().at(-1);
  assert.equal(
    (registrado?.command as { metadata?: { actor?: string } }).metadata?.actor,
    "agent",
    "o histórico guarda o ator que a borda confiável decidiu",
  );
});
