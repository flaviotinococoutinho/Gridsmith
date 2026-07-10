import assert from "node:assert/strict";
import { test } from "node:test";
import { BlueprintStore, type LevelSpec } from "../src/domain/BlueprintStore.js";
import { JsonRpcError, RpcErrorCode } from "../src/protocol/jsonrpc.js";

/** Nível 4×2 com tileSize 16 → retângulo de 64×32 px no mundo. */
function makeLevel(levelId: string): LevelSpec {
  return {
    levelId,
    width: 4,
    height: 2,
    tileSize: 16,
    seed: 0,
    intGrid: new Array(8).fill(0),
    rules: [],
  };
}

function makeStore(...levelIds: string[]): BlueprintStore {
  const store = new BlueprintStore();
  for (const levelId of levelIds) {
    store.apply({ kind: "level/define", level: makeLevel(levelId) });
  }
  return store;
}

test("place exige nível definido e valida coordenadas", () => {
  const store = makeStore("a");
  store.apply({ kind: "world/place", placement: { levelId: "a", x: 0, y: 0 } });
  assert.equal(store.listPlacements().length, 1);

  assert.throws(
    () => store.apply({ kind: "world/place", placement: { levelId: "ghost", x: 0, y: 0 } }),
    /must be defined before placing/,
  );
  assert.throws(
    () => store.apply({ kind: "world/place", placement: { levelId: "a", x: Number.NaN, y: 0 } }),
    (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InvalidParams,
  );
});

test("sobreposição é rejeitada; re-posicionar o próprio nível é permitido (drag-n-drop)", () => {
  const store = makeStore("a", "b");
  store.apply({ kind: "world/place", placement: { levelId: "a", x: 0, y: 0 } }); // 0..64 × 0..32
  assert.throws(
    () => store.apply({ kind: "world/place", placement: { levelId: "b", x: 32, y: 16 } }),
    /would overlap "a"/,
  );

  // mover "a" para outro lugar substitui a colocação, sem conflito consigo mesmo
  store.apply({ kind: "world/place", placement: { levelId: "a", x: 100, y: 100 } });
  assert.deepEqual(store.listPlacements()[0], { levelId: "a", x: 100, y: 100 });

  // agora "b" cabe onde "a" estava
  store.apply({ kind: "world/place", placement: { levelId: "b", x: 32, y: 16 } });
});

test("vizinhança por borda compartilhada nas quatro direções", () => {
  const store = makeStore("center", "east", "west", "south", "diagonal");
  // center: 0..64 × 0..32
  store.apply({ kind: "world/place", placement: { levelId: "center", x: 0, y: 0 } });
  store.apply({ kind: "world/place", placement: { levelId: "east", x: 64, y: 0 } });    // toca a direita
  store.apply({ kind: "world/place", placement: { levelId: "west", x: -64, y: 16 } });  // toca a esquerda (parcial)
  store.apply({ kind: "world/place", placement: { levelId: "south", x: 0, y: 32 } });   // toca embaixo
  store.apply({ kind: "world/place", placement: { levelId: "diagonal", x: 64, y: 32 } }); // toca center SÓ no canto

  const neighbors = store.neighborsOf("center");
  assert.deepEqual(
    [...neighbors].sort((a, b) => a.levelId.localeCompare(b.levelId)),
    [
      { levelId: "east", direction: "right" },
      { levelId: "south", direction: "down" },
      { levelId: "west", direction: "left" },
    ],
  );

  // "diagonal" toca center apenas no canto (64,32) → não é vizinho de center,
  // mas toca a borda direita de south e a de baixo de east
  const diagonal = store.neighborsOf("diagonal");
  assert.ok(!diagonal.some((n) => n.levelId === "center"));
  assert.ok(diagonal.some((n) => n.levelId === "south" && n.direction === "left"));
  assert.ok(diagonal.some((n) => n.levelId === "east" && n.direction === "up"));

  // a relação é simétrica com direção invertida
  assert.ok(store.neighborsOf("east").some((n) => n.levelId === "center" && n.direction === "left"));
});

test("unplace remove do mapa e level/remove limpa a colocação junto", () => {
  const store = makeStore("a", "b");
  store.apply({ kind: "world/place", placement: { levelId: "a", x: 0, y: 0 } });
  store.apply({ kind: "world/place", placement: { levelId: "b", x: 64, y: 0 } });

  store.apply({ kind: "world/unplace", levelId: "b" });
  assert.equal(store.listPlacements().length, 1);
  assert.deepEqual(store.neighborsOf("a"), []);
  assert.throws(() => store.apply({ kind: "world/unplace", levelId: "b" }), /is not placed/);

  // remover o nível remove a colocação junto (invariante do AST)
  store.apply({ kind: "level/remove", levelId: "a" });
  assert.equal(store.listPlacements().length, 0);
});

test("nível não colocado não tem vizinhos", () => {
  const store = makeStore("a");
  assert.deepEqual(store.neighborsOf("a"), []);
  assert.deepEqual(store.neighborsOf("inexistente"), []);
});
