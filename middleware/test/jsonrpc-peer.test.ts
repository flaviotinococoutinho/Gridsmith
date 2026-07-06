import assert from "node:assert/strict";
import { test } from "node:test";
import { duplexPair } from "node:stream";
import { JsonRpcPeer } from "../src/ipc/JsonRpcPeer.js";
import { JsonRpcError, RpcErrorCode } from "../src/protocol/jsonrpc.js";

function makePeers(): { a: JsonRpcPeer; b: JsonRpcPeer } {
  const [sideA, sideB] = duplexPair();
  return {
    a: new JsonRpcPeer(sideA, { label: "A", requestTimeoutMs: 2000 }),
    b: new JsonRpcPeer(sideB, { label: "B", requestTimeoutMs: 2000 }),
  };
}

test("request/response na direção A→B", async () => {
  const { a, b } = makePeers();
  b.registerMethod("math/add", (params) => {
    const { x, y } = params as { x: number; y: number };
    return { sum: x + y };
  });
  const result = await a.request<{ sum: number }>("math/add", { x: 2, y: 3 });
  assert.deepEqual(result, { sum: 5 });
});

test("o canal é simétrico: B também origina requests para A", async () => {
  const { a, b } = makePeers();
  a.registerMethod("echo", (params) => params);
  b.registerMethod("echo", (params) => params);
  const [fromA, fromB] = await Promise.all([
    a.request("echo", { origin: "A" }),
    b.request("echo", { origin: "B" }),
  ]);
  assert.deepEqual(fromA, { origin: "A" });
  assert.deepEqual(fromB, { origin: "B" });
});

test("requests concorrentes são correlacionados pelo id", async () => {
  const { a, b } = makePeers();
  b.registerMethod("slow/identity", async (params) => {
    const { n } = params as { n: number };
    // inverte a ordem de conclusão para exercitar a correlação
    await new Promise((r) => setTimeout(r, (10 - n) * 5));
    return n;
  });
  const results = await Promise.all([0, 1, 2, 3, 4].map((n) => a.request<number>("slow/identity", { n })));
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

test("método desconhecido responde -32601", async () => {
  const { a } = makePeers();
  await assert.rejects(
    a.request("nao/existe"),
    (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.MethodNotFound,
  );
});

test("JsonRpcError lançado pelo handler propaga código e mensagem", async () => {
  const { a, b } = makePeers();
  b.registerMethod("fail/typed", () => {
    throw new JsonRpcError(RpcErrorCode.UnknownSkeleton, "skeleton missing", { skeletonId: "hero" });
  });
  await assert.rejects(a.request("fail/typed"), (err: unknown) => {
    assert.ok(err instanceof JsonRpcError);
    assert.equal(err.code, RpcErrorCode.UnknownSkeleton);
    assert.equal(err.message, "skeleton missing");
    assert.deepEqual(err.data, { skeletonId: "hero" });
    return true;
  });
});

test("exceção genérica do handler vira -32603 sem derrubar o peer", async () => {
  const { a, b } = makePeers();
  b.registerMethod("fail/generic", () => {
    throw new Error("boom");
  });
  b.registerMethod("ok", () => "still alive");
  await assert.rejects(
    a.request("fail/generic"),
    (err: unknown) => err instanceof JsonRpcError && err.code === RpcErrorCode.InternalError,
  );
  assert.equal(await a.request("ok"), "still alive");
});

test("notification é entregue sem resposta", async () => {
  const { a, b } = makePeers();
  const received = new Promise<unknown>((resolve) => {
    b.registerMethod("engine/log", (params) => resolve(params));
  });
  a.notify("engine/log", { level: "info", message: "olá" });
  assert.deepEqual(await received, { level: "info", message: "olá" });
});

test("fechar o transporte rejeita requests pendentes", async () => {
  const { a, b } = makePeers();
  b.registerMethod("never/answers", () => new Promise(() => {}));
  const pending = a.request("never/answers");
  setTimeout(() => a.close(), 20);
  await assert.rejects(pending);
});

test("payload JSON inválido gera resposta -32700 e não mata a conexão", async () => {
  const { a, b } = makePeers();
  b.registerMethod("ok", () => 42);
  // Injeta um frame com corpo não-JSON diretamente no stream de A.
  const { encodeFrame } = await import("../src/protocol/framing.js");
  const uncorrelated = new Promise<Error>((resolve) => a.once("protocolError", resolve));
  (a as unknown as { stream: { write(b: Buffer): void } })["stream"].write(encodeFrame("{{{nope"));
  const err = await uncorrelated; // resposta de parse error chega sem id correlacionável
  assert.match(err.message, /uncorrelated/);
  assert.equal(await a.request("ok"), 42);
});
