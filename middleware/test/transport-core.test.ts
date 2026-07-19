/**
 * Núcleos dos transports do app: logger com verbosidade, EventJournal e
 * resolução de endpoints — tudo puro/injetável (sem sockets aqui).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLogger,
  formatRecord,
  levelEnabled,
  parseLogLevel,
  type LogRecord,
} from "../src/util/log.js";
import { EventJournal, parseEventSequence } from "../src/transport/EventJournal.js";
import {
  TransportEndpointCollisionError,
  derivedPort,
  normalizeEndpointListenError,
  resolveTransportEndpoint,
  restrictUnixSocketPermissions,
  validatePipeName,
  type TransportEndpoint,
} from "../src/transport/endpoints.js";
import {
  EDITOR_AUTH_TOKEN_ENV,
  EDITOR_AUTH_TOKEN_FILE_ENV,
  TransportAuthConfigurationError,
  bearerAuthorization,
  bearerTokenMatches,
  generateTransportAuthToken,
  loadTransportAuthToken,
  timingSafeTokenEqual,
  validateTransportAuthToken,
} from "../src/transport/auth.js";

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
  const journal = new EventJournal(8, "middleware-a");
  const live: bigint[] = [];
  journal.on("event", (e: { seq: bigint }) => live.push(e.seq));

  journal.append("lightAdded", { kind: "lightAdded", light: { lightId: "sun" } });
  journal.append("levelDefined", { kind: "levelDefined" });
  const third = journal.append("entityPlaced", { kind: "entityPlaced" });

  assert.equal(third.seq, 3n);
  assert.equal(journal.lastSeq, 3n);
  assert.equal(journal.firstAvailableSeq, 1n);
  assert.deepEqual(journal.since("1").map((e) => e.seq), [2n, 3n]);
  assert.deepEqual(journal.since(3), []);
  assert.deepEqual(live, [1n, 2n, 3n]);
  assert.deepEqual(journal.position, {
    middlewareInstanceId: "middleware-a",
    firstAvailableSeq: 1n,
    lastEventSeq: 3n,
  });
});

test("journal: ring não entrega cauda parcial e retorna gap explícito", () => {
  const journal = new EventJournal(2, "middleware-a");
  journal.append("a", {});
  journal.append("b", {});
  journal.append("c", {}); // seq 1 caiu do ring

  assert.deepEqual(journal.since(0).map((e) => e.seq), [2n, 3n]); // API legada
  assert.equal(journal.firstAvailableSeq, 2n);
  assert.equal(journal.canResumeFrom(0), false); // gap: seq 1 perdido
  assert.equal(journal.canResumeFrom(1), true);
  assert.equal(journal.canResumeFrom(3), true); // em dia
  const gap = journal.readSince("middleware-a", "0");
  assert.equal(gap.resyncRequired, true);
  assert.equal(gap.resyncReason, "journal_gap");
  assert.deepEqual(gap.events, [], "uma cauda parcial nunca pode ser aplicada");
  assert.throws(() => new EventJournal(0), RangeError);
});

test("journal: restart, cursor futuro e cursor inválido exigem resync com razão estável", () => {
  const journal = new EventJournal(4, "middleware-new");
  journal.append("a", {});

  const restarted = journal.readSince("middleware-old", "100");
  assert.equal(restarted.resyncReason, "instance_changed");
  assert.deepEqual(restarted.events, []);

  const ahead = journal.readSince("middleware-new", "100");
  assert.equal(ahead.resyncReason, "cursor_ahead");
  assert.equal(journal.canResumeFrom(100), false);

  for (const invalid of ["", "-1", "01", "1.5", "18446744073709551616", Number.MAX_VALUE]) {
    const result = journal.readSince("middleware-new", invalid);
    assert.equal(result.resyncReason, "invalid_cursor", String(invalid));
    assert.deepEqual(result.events, []);
  }
  assert.equal(parseEventSequence("18446744073709551615"), 18_446_744_073_709_551_615n);
  assert.throws(() => new EventJournal(1, "  "), TypeError);
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
  // Regressão: o hash de faixa única fazia estes dois transports colidirem.
  assert.notEqual(derivedPort("p7m-151", "grpc"), derivedPort("p7m-151", "graphql"));
  assert.ok(derivedPort("p7m-x", "graphql") < 57344);
  assert.ok(derivedPort("p7m-x", "grpc") >= 57344);
});

test("endpoints: nome lógico bloqueia traversal e colisão de bind é tipada", () => {
  assert.equal(validatePipeName("p7m-editor_1.0"), "p7m-editor_1.0");
  for (const invalid of ["", ".hidden", "../escape", "a/b", "x".repeat(81)]) {
    assert.throws(() => validatePipeName(invalid), TypeError);
  }

  const endpoint = resolveTransportEndpoint("p7m-collision", "grpc", "win32");
  const normalized = normalizeEndpointListenError(
    endpoint,
    Object.assign(new Error("listen EADDRINUSE: address already in use"), { code: "EADDRINUSE" }),
  );
  assert.ok(normalized instanceof TransportEndpointCollisionError);
  assert.equal(normalized.endpoint, endpoint);
  assert.match(normalized.message, /127\.0\.0\.1/);
});

test("auth: gera token forte, carrega uma única fonte e compara sem expor segredo", () => {
  const token = generateTransportAuthToken();
  assert.ok(token.length >= 32);
  assert.equal(validateTransportAuthToken(token), token);
  assert.equal(loadTransportAuthToken({ [EDITOR_AUTH_TOKEN_ENV]: token }), token);
  assert.equal(timingSafeTokenEqual(token, token), true);
  assert.equal(timingSafeTokenEqual(token, `${token}x`), false);
  assert.equal(bearerTokenMatches(bearerAuthorization(token), token), true);
  assert.equal(bearerTokenMatches("Bearer wrong", token), false);

  assert.throws(() => validateTransportAuthToken("short"), TransportAuthConfigurationError);
  assert.throws(() => loadTransportAuthToken({}), /missing editor transport token/);
  assert.throws(
    () =>
      loadTransportAuthToken({
        [EDITOR_AUTH_TOKEN_ENV]: token,
        [EDITOR_AUTH_TOKEN_FILE_ENV]: "/unused",
      }),
    /mutually exclusive/,
  );
});

test("auth: arquivo de token POSIX precisa ser regular, privado e do usuário", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p7m-auth-test-"));
  const file = path.join(dir, "token");
  const token = generateTransportAuthToken();
  try {
    fs.writeFileSync(file, `${token}\n`, { mode: 0o644 });
    if (process.platform !== "win32") {
      assert.throws(
        () => loadTransportAuthToken({ [EDITOR_AUTH_TOKEN_FILE_ENV]: file }),
        /must not grant group or other permissions/,
      );
      fs.chmodSync(file, 0o600);
    }
    assert.equal(loadTransportAuthToken({ [EDITOR_AUTH_TOKEN_FILE_ENV]: file }), token);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

test("endpoints: UDS recebe permissão 0600 antes de anunciar prontidão", () => {
  const socketPath = "/runtime/p7m-mode.sock";
  const endpoint: TransportEndpoint = {
    family: "uds",
    address: socketPath,
    grpcTarget: `unix:${socketPath}`,
  };
  let mode = 0o777;
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  const fakeFs = {
    lstatSync: () => ({ isSocket: () => true, uid: owner, mode }),
    chmodSync: (_path: string, nextMode: number) => {
      mode = nextMode;
    },
  };
  restrictUnixSocketPermissions(endpoint, fakeFs);
  assert.equal(mode, 0o600);
});
