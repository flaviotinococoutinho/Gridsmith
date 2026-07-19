import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectClosePreflightRequest } from "../src/core/projectApi.js";
import { ProjectClosePreflight } from "../src/main/projectClosePreflight.js";

test("preflight de Close só libera após resposta ready correlacionada", async () => {
  let sent: ProjectClosePreflightRequest | undefined;
  const preflight = new ProjectClosePreflight({
    createId: () => "request-1",
    now: () => 1_000,
    timeoutMs: 500,
    send: (request) => { sent = request; },
  });
  const closing = preflight.request("window-close");
  assert.deepEqual(sent, {
    requestId: "request-1",
    reason: "window-close",
    deadlineUnixMs: 1_500,
  });
  assert.equal(preflight.size, 1);
  assert.equal(preflight.accept({ requestId: "other", status: "ready" }), false);
  assert.equal(preflight.accept({ requestId: "request-1", status: "ready" }), true);
  await closing;
  assert.equal(preflight.size, 0);
});

test("preflight de Close propaga rejeição do flush e recusa shape extra", async () => {
  const requests: ProjectClosePreflightRequest[] = [];
  let sequence = 0;
  const preflight = new ProjectClosePreflight({
    createId: () => `request-${++sequence}`,
    timeoutMs: 500,
    send: (request) => requests.push(request),
  });

  const rejected = preflight.request("project-close");
  preflight.accept({
    requestId: requests[0]!.requestId,
    status: "rejected",
    reason: "O campo intensidade é inválido.",
  });
  await assert.rejects(rejected, /campo intensidade/);

  const malformed = preflight.request("window-close");
  preflight.accept({
    requestId: requests[1]!.requestId,
    status: "ready",
    injected: true,
  });
  await assert.rejects(malformed, /Resposta inválida/);
});

test("preflight de Close cancela em timeout e queda do renderer", async () => {
  let sequence = 0;
  const preflight = new ProjectClosePreflight({
    createId: () => `request-${++sequence}`,
    timeoutMs: 100,
    send: () => undefined,
  });
  await assert.rejects(preflight.request("window-close"), /dentro do prazo/);

  const rendererGone = preflight.request("project-close");
  preflight.cancelAll("Renderer caiu durante o preflight.");
  await assert.rejects(rendererGone, /Renderer caiu/);
  assert.equal(preflight.size, 0);
});
