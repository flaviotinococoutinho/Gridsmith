import assert from "node:assert/strict";
import { test } from "node:test";
import { BlueprintStore, type EntityDefinition } from "../src/domain/BlueprintStore.js";
import { JsonRpcError, RpcErrorCode } from "../src/protocol/jsonrpc.js";

const MOB_DEF: EntityDefinition = {
  entityDefId: "mob",
  tags: ["actor", "enemy"],
  editor: { color: "#cc3333", icon: "skull" },
  fields: [
    { name: "hitPoints", type: "int", min: 0, max: 10, default: 3 },
    { name: "speed", type: "float", min: 0, default: 1.5 },
    { name: "aggressive", type: "bool", default: false },
    { name: "loot", type: "enum", options: ["none", "coin", "gem"], default: "none" },
    { name: "patrolTarget", type: "point" },
    { name: "tint", type: "color", default: "#ffffff" },
  ],
};

function makeStore(): BlueprintStore {
  const store = new BlueprintStore();
  store.apply({ kind: "entitydef/define", definition: MOB_DEF });
  return store;
}

test("definição registra o schema e instância materializa defaults", () => {
  const store = makeStore();
  assert.equal(store.getEntityDef("mob")?.fields.length, 6);

  store.apply({
    kind: "entity/place",
    entity: {
      entityId: "mob-1",
      entityDefId: "mob",
      position: [64, 128],
      fields: { patrolTarget: [96, 128] }, // demais campos vêm dos defaults
    },
  });

  const placed = store.getEntity("mob-1")!;
  assert.equal(placed.fields["hitPoints"], 3);
  assert.equal(placed.fields["loot"], "none");
  assert.deepEqual(placed.fields["patrolTarget"], [96, 128]);
});

test("campo obrigatório sem default e sem valor é rejeitado", () => {
  const store = makeStore();
  assert.throws(
    () =>
      store.apply({
        kind: "entity/place",
        entity: { entityId: "mob-2", entityDefId: "mob", position: [0, 0], fields: {} },
      }),
    (err: unknown) =>
      err instanceof JsonRpcError &&
      err.code === RpcErrorCode.InvalidParams &&
      /patrolTarget/.test(err.message),
  );
});

test("validação por tipo: faixa de int, enum, point, color e campo desconhecido", () => {
  const store = makeStore();
  const place = (fields: Record<string, unknown>) =>
    store.apply({
      kind: "entity/place",
      entity: {
        entityId: `mob-${Math.random()}`,
        entityDefId: "mob",
        position: [0, 0],
        fields: { patrolTarget: [0, 0], ...fields },
      },
    });

  assert.throws(() => place({ hitPoints: 99 }), /> max 10/);
  assert.throws(() => place({ hitPoints: 2.5 }), /expected integer/);
  assert.throws(() => place({ speed: -1 }), /< min 0/);
  assert.throws(() => place({ loot: "sword" }), /expected one of/);
  assert.throws(() => place({ patrolTarget: [1] }), /expected \[x, y\]/);
  assert.throws(() => place({ tint: "red" }), /expected "#rrggbb"/);
  assert.throws(() => place({ mana: 5 }), /is not declared/);

  // valores válidos passam
  place({ hitPoints: 10, loot: "gem", tint: "#00ff88", aggressive: true });
});

test("definição inválida é rejeitada: enum sem options, campo duplicado, default fora do schema", () => {
  const store = new BlueprintStore();
  assert.throws(
    () =>
      store.apply({
        kind: "entitydef/define",
        definition: {
          entityDefId: "bad-enum",
          fields: [{ name: "kind", type: "enum" }],
        },
      }),
    /require non-empty "options"/,
  );
  assert.throws(
    () =>
      store.apply({
        kind: "entitydef/define",
        definition: {
          entityDefId: "dup-field",
          fields: [
            { name: "x", type: "int" },
            { name: "x", type: "float" },
          ],
        },
      }),
    /Duplicate field/,
  );
  assert.throws(
    () =>
      store.apply({
        kind: "entitydef/define",
        definition: {
          entityDefId: "bad-default",
          fields: [{ name: "hp", type: "int", min: 0, max: 5, default: 100 }],
        },
      }),
    /> max 5/,
  );
});

test("ids duplicados e remoções", () => {
  const store = makeStore();
  assert.throws(
    () => store.apply({ kind: "entitydef/define", definition: MOB_DEF }),
    (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.DuplicateId,
  );

  store.apply({
    kind: "entity/place",
    entity: {
      entityId: "mob-x",
      entityDefId: "mob",
      position: [0, 0],
      fields: { patrolTarget: [0, 0] },
    },
  });
  assert.throws(
    () =>
      store.apply({
        kind: "entity/place",
        entity: {
          entityId: "mob-x",
          entityDefId: "mob",
          position: [1, 1],
          fields: { patrolTarget: [0, 0] },
        },
      }),
    (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.DuplicateId,
  );

  store.apply({ kind: "entity/remove", entityId: "mob-x" });
  assert.equal(store.getEntity("mob-x"), undefined);
  assert.throws(() => store.apply({ kind: "entity/remove", entityId: "mob-x" }), /does not exist/);
});

test("instância referenciando definição inexistente é rejeitada", () => {
  const store = new BlueprintStore();
  assert.throws(
    () =>
      store.apply({
        kind: "entity/place",
        entity: { entityId: "ghost", entityDefId: "unknown", position: [0, 0], fields: {} },
      }),
    /is not defined/,
  );
});
