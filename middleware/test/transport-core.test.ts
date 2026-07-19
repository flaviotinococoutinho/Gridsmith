/**
 * Núcleos dos transports do app: logger com verbosidade, EventJournal e
 * resolução de endpoints — tudo puro/injetável (sem sockets aqui).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLogger,
  formatRecord,
  levelEnabled,
  parseLogLevel,
  type LogRecord,
} from "../src/util/log.js";
import { EventJournal } from "../src/transport/EventJournal.js";
import { derivedPort, resolveTransportEndpoint } from "../src/transport/endpoints.js";

// ---------- logger / verbosidade ----------

test("verbosidade: níveis são ordenados e silent suprime tudo", () => {
  assert.equal(levelEnabled("info", "error"), true);
  assert.equal(levelEnabled("info", "debug"), false);
  assert.equal(levelEnabled("trace", "trace"), true);
  assert.equal(levelEnabled("silent", "error"), false);
  assert.equal(parseLogLevel("DEBUG"), "debug");
  assert.equal(parseLogLevel("nope", "warn"), "warn");
  assert.equal(parseLogLevel(undefined), "info");
});

test("logger emite somente até o nível ativo, com escopo herdado e detail JSON", () => {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  const log = createLogger("p7m", { level: "info", sink: (l, r) => (lines.push(l), records.push(r)) });

  log.info("gateway up", { endpoint: "unix:/tmp/x.sock" });
  log.debug("invisível neste nível");
  log.child("grpc").warn("fallback");

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\[p7m\] INFO gateway up — \{"endpoint":"unix:\/tmp\/x\.sock"\}$/);
  assert.match(lines[1]!, /^\[p7m:grpc\] WARN fallback$/);
  assert.equal(records[0]?.level, "info");
});

test("formatRecord sobrevive a detail não serializável", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const line = formatRecord({ level: "error", scope: "s", message: "m", detail: cyclic });
  assert.match(line, /^\[s\] ERROR m — \[object Object\]$/);
});

// ---------- EventJournal ----------

test("journal: seq monotônico, since incremental e emissão ao vivo", () => {
  const journal = new EventJournal(8);
  const live: number[] = [];
  journal.on("event", (e: { seq: number }) => live.push(e.seq));

  journal.append("lightAdded", { kind: "lightAdded", light: { lightId: "sun" } });
  journal.append("levelDefined", { kind: "levelDefined" });
  const third = journal.append("entityPlaced", { kind: "entityPlaced" });

  assert.equal(third.seq, 3);
  assert.equal(journal.lastSeq, 3);
  assert.deepEqual(journal.since(1).map((e) => e.seq), [2, 3]);
  assert.deepEqual(journal.since(3), []);
  assert.deepEqual(live, [1, 2, 3]);
});

test("journal: ring descarta o mais antigo e canResumeFrom detecta gap", () => {
  const journal = new EventJournal(2);
  journal.append("a", {});
  journal.append("b", {});
  journal.append("c", {}); // seq 1 caiu do ring

  assert.deepEqual(journal.since(0).map((e) => e.seq), [2, 3]);
  assert.equal(journal.canResumeFrom(0), false); // gap: seq 1 perdido
  assert.equal(journal.canResumeFrom(1), true);
  assert.equal(journal.canResumeFrom(3), true); // em dia
  assert.throws(() => new EventJournal(0), RangeError);
});

// ---------- endpoints ----------

test("endpoints: UDS no POSIX com sufixo por transporte; TCP determinístico no Windows", () => {
  const graphql = resolveTransportEndpoint("p7m-x", "graphql", "linux");
  const grpc = resolveTransportEndpoint("p7m-x", "grpc", "linux");
  assert.equal(graphql.family, "uds");
  assert.match(graphql.address, /p7m-x-graphql\.sock$/);
  assert.match(grpc.grpcTarget, /^unix:.*p7m-x-grpc\.sock$/);
  assert.notEqual(graphql.address, grpc.address);

  const win = resolveTransportEndpoint("p7m-x", "grpc", "win32");
  assert.equal(win.family, "tcp");
  assert.equal(win.address, "127.0.0.1");
  assert.equal(win.port, derivedPort("p7m-x", "grpc"));
  assert.ok(win.port! >= 49152 && win.port! < 65536);
  // determinístico: mesma entrada, mesma porta; transports não colidem
  assert.equal(derivedPort("p7m-x", "grpc"), derivedPort("p7m-x", "grpc"));
  assert.notEqual(derivedPort("p7m-x", "grpc"), derivedPort("p7m-x", "graphql"));
});
