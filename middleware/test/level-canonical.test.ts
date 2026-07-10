import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { EnginePipeServer } from "../src/ipc/EnginePipeServer.js";
import { BlueprintStore, type LevelSpec } from "../src/domain/BlueprintStore.js";
import { CapabilityRegistry } from "../src/domain/CapabilityRegistry.js";
import { CanonicalOrchestrator } from "../src/canonical/CanonicalOrchestrator.js";
import { HookBus } from "../src/canonical/HookBus.js";
import { MonoGameAdapter } from "../src/runtime/MonoGameAdapter.js";
import { resolveAutoTiles } from "../src/leveldesign/AutoTiler.js";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { JsonRpcError, PROTOCOL_VERSION, RpcErrorCode } from "../src/protocol/jsonrpc.js";

let pipeCounter = 0;

const LEVEL: LevelSpec = {
  levelId: "dungeon-1",
  width: 4,
  height: 2,
  tileSize: 16,
  seed: 77,
  intGrid: [0, 0, 0, 0, 1, 1, 1, 1],
  rules: [
    {
      name: "grass-top",
      patternSize: 3,
      pattern: [null, 0, null, null, 1, null, null, null, null],
      tileIds: [100, 101],
    },
    { name: "dirt", patternSize: 1, pattern: [1], tileIds: [200] },
  ],
};

test("level/define valida grid e regras na borda do AST", () => {
  const store = new BlueprintStore();
  store.apply({ kind: "level/define", level: LEVEL });
  assert.equal(store.getLevel("dungeon-1")?.width, 4);

  assert.throws(
    () => store.apply({ kind: "level/define", level: LEVEL }),
    (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.DuplicateId,
  );
  assert.throws(
    () => store.apply({ kind: "level/define", level: { ...LEVEL, levelId: "bad", intGrid: [1] } }),
    /expects 8 values/,
  );
  assert.throws(
    () =>
      store.apply({
        kind: "level/define",
        level: { ...LEVEL, levelId: "bad-rule", rules: [{ patternSize: 3, pattern: [1], tileIds: [1] }] },
      }),
    /pattern must have 9 cells/,
  );
  assert.throws(
    () => store.apply({ kind: "level/remove", levelId: "ghost" }),
    /does not exist/,
  );
});

test("projeção resolve o auto-tiling na fronteira do runtime, determinística por seed", async () => {
  const server = new EnginePipeServer({
    pipeName: `p7m-lvl-${process.pid}-${pipeCounter++}`,
    requestTimeoutMs: 2000,
  });
  const store = new BlueprintStore();
  const adapter = new MonoGameAdapter(server, new CapabilityRegistry(server));
  const orchestrator = new CanonicalOrchestrator(store, new HookBus(), adapter);
  await server.listen();

  try {
    const tilemapCalls: Array<Record<string, unknown>> = [];
    const removals: string[] = [];
    const socket = net.connect(server.pipePath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const engine = new JsonRpcPeer(socket, { label: "fake-engine", requestTimeoutMs: 2000 });
    engine.registerMethod("tilemap/define", (params) => {
      tilemapCalls.push(params as Record<string, unknown>);
      return { tilemapId: (params as { tilemapId: string }).tilemapId, status: "defined", staticBatches: 1 };
    });
    engine.registerMethod("tilemap/remove", (params) => {
      removals.push((params as { tilemapId: string }).tilemapId);
      return { removed: true };
    });
    await engine.request("engine/handshake", {
      clientName: "P7m.Engine.Runtime",
      clientVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    });

    const result = await orchestrator.dispatch({ kind: "level/define", level: LEVEL });
    assert.equal(result.projection?.status, "projected");

    // a engine recebeu tiles JÁ RESOLVIDOS — idênticos à resolução local
    const expected = resolveAutoTiles(
      { width: LEVEL.width, height: LEVEL.height, values: LEVEL.intGrid },
      LEVEL.rules,
      LEVEL.seed,
    );
    const sent = tilemapCalls[0]!;
    assert.equal(sent["tilemapId"], "dungeon-1");
    assert.deepEqual(sent["tiles"], [...expected.tiles]);
    assert.deepEqual(sent["intGrid"], [...LEVEL.intGrid]);
    // linha de cima da plataforma vira grama (variante determinística)
    const tiles = sent["tiles"] as number[];
    assert.ok(tiles.slice(4).every((t) => t === 100 || t === 101));

    // remoção projeta tilemap/remove
    await orchestrator.dispatch({ kind: "level/remove", levelId: "dungeon-1" });
    assert.deepEqual(removals, ["dungeon-1"]);
    assert.equal(store.getLevel("dungeon-1"), undefined);

    engine.close();
  } finally {
    await server.close();
  }
});
