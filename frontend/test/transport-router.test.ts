/**
 * Política de roteamento gRPC-first com fallback GraphQL (ADR-017):
 * cada regra da política é uma asserção — fallback imediato em falha de
 * transporte, falha de domínio NUNCA muda o modo, recovery com backoff e
 * histerese anti-flap, telemetria com razões legíveis.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TransportRouter,
  classifyTransportError,
} from "../src/core/transportRouter.js";
import { createLogger, levelEnabled, parseLogLevel } from "../src/core/logging.js";

test("prioridade: nasce no gRPC; falha de transporte única faz fallback imediato", () => {
  const router = new TransportRouter();
  assert.equal(router.active, "grpc");

  const decision = router.onTransportFailure("grpc", 1_000, "socket ECONNREFUSED");
  assert.equal(decision, "fellBack");
  assert.equal(router.active, "graphql");
  assert.equal(router.snapshot.mode, "fallback");
  // primeira sonda agendada no primeiro degrau do backoff (2s)
  assert.equal(router.snapshot.nextProbeAtMs, 3_000);
  assert.match(router.history[0]!.reason, /ECONNREFUSED/);
});

test("limiar configurável: com threshold 2, a primeira falha segura o primário", () => {
  const router = new TransportRouter({ failureThreshold: 2 });
  assert.equal(router.onTransportFailure("grpc", 0, "x"), "stay");
  assert.equal(router.active, "grpc");
  assert.equal(router.onTransportFailure("grpc", 0, "x"), "fellBack");
  assert.equal(router.active, "graphql");
});

test("sucesso zera o contador de falhas (falhas não-consecutivas não acumulam)", () => {
  const router = new TransportRouter({ failureThreshold: 2 });
  router.onTransportFailure("grpc", 0, "x");
  router.onCallSuccess("grpc");
  assert.equal(router.onTransportFailure("grpc", 0, "x"), "stay"); // recomeçou do zero
});

test("falha no GraphQL nunca muda o modo (não há transporte abaixo)", () => {
  const router = new TransportRouter();
  router.onTransportFailure("grpc", 0, "down"); // agora em fallback
  assert.equal(router.onTransportFailure("graphql", 10, "also down"), "stay");
  assert.equal(router.active, "graphql");
});

test("recovery: backoff sobe a escada em sondas ruins e histerese exige 2 boas consecutivas", () => {
  const router = new TransportRouter(); // backoff 2s,4s,8s,16s,30s; promote 2
  router.onTransportFailure("grpc", 0, "down");
  assert.equal(router.shouldProbe(1_999), false);
  assert.equal(router.shouldProbe(2_000), true);

  // sonda ruim: próxima espera sobe o degrau
  assert.equal(router.onProbeResult(false, 2_000), "probing");
  assert.equal(router.snapshot.nextProbeAtMs, 2_000 + 4_000);

  // boa + ruim: histerese zera a contagem
  assert.equal(router.onProbeResult(true, 6_000), "probing");
  assert.equal(router.onProbeResult(false, 8_000), "probing");
  assert.equal(router.snapshot.consecutiveProbeSuccesses, 0);

  // duas boas consecutivas: repromove
  assert.equal(router.onProbeResult(true, 20_000), "probing");
  assert.equal(router.onProbeResult(true, 22_000), "promoted");
  assert.equal(router.active, "grpc");
  assert.equal(router.snapshot.nextProbeAtMs, undefined);
  assert.match(router.history.at(-1)!.reason, /2 consecutive probes/);
});

test("escada de backoff satura no último degrau", () => {
  const router = new TransportRouter({ recoveryBackoffMs: [10, 20] });
  router.onTransportFailure("grpc", 0, "down");
  router.onProbeResult(false, 10); // degrau 1 (índice min(1,1)=1 → 20)
  assert.equal(router.snapshot.nextProbeAtMs, 30);
  router.onProbeResult(false, 30); // satura em 20
  assert.equal(router.snapshot.nextProbeAtMs, 50);
});

test("classificação: UNAVAILABLE/DEADLINE e erros de socket são transporte; domínio não é", () => {
  assert.equal(classifyTransportError({ code: 14, message: "UNAVAILABLE" }).transport, true);
  assert.equal(classifyTransportError({ code: 4, message: "DEADLINE" }).transport, true);
  assert.equal(classifyTransportError({ code: "ECONNREFUSED" }).transport, true);
  assert.equal(classifyTransportError({ code: "ENOENT" }).transport, true);
  // INVALID_ARGUMENT (3) = domínio: o comando é inválido em QUALQUER transporte
  assert.equal(classifyTransportError({ code: 3, message: "bad kind" }).transport, false);
  assert.equal(classifyTransportError(new Error("validation failed")).transport, false);
});

test("opções inválidas são rejeitadas na construção", () => {
  assert.throws(() => new TransportRouter({ failureThreshold: 0 }), RangeError);
  assert.throws(() => new TransportRouter({ promoteAfterProbes: 0 }), RangeError);
  assert.throws(() => new TransportRouter({ recoveryBackoffMs: [] }), RangeError);
});

// ---------- verbosidade (núcleo do frontend) ----------

test("verbosidade: parse tolerante, ordem de níveis e sink capturável", () => {
  assert.equal(parseLogLevel("TRACE"), "trace");
  assert.equal(parseLogLevel("bogus", "error"), "error");
  assert.equal(levelEnabled("warn", "info"), false);
  assert.equal(levelEnabled("warn", "error"), true);

  const lines: string[] = [];
  const log = createLogger("editor", { level: "debug", sink: (l) => lines.push(l) });
  log.debug("transporte ativo", { active: "grpc" });
  log.trace("não emitido");
  log.child("transport").error("fallback", { reason: "socket ECONNREFUSED" });
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\[editor\] DEBUG transporte ativo — \{"active":"grpc"\}$/);
  assert.match(lines[1]!, /^\[editor:transport\] ERROR fallback/);
});
