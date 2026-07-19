#!/usr/bin/env node
/**
 * Benchmark reproduzível dos três transports que já existem no produto.
 *
 * Cada fork sobe um processo REAL do middleware, sem engine e sem MCP, e usa
 * as implementações de produção do frontend (GrpcTransport e
 * GraphQlTransport) mais o JsonRpcPeer legado. Nenhum servidor ou transporte
 * sintético participa da medição.
 *
 * O artefato JSON deliberadamente guarda tamanhos de payload da aplicação,
 * não uma estimativa de bytes no fio. HTTP/2, HTTP/1.1 e o framing JSON-RPC
 * têm overheads diferentes e só uma captura de rede/IPC poderia medi-los sem
 * inventar precisão.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcPeer } from "@p7m/middleware/dist/ipc/JsonRpcPeer.js";
import { resolvePipePath } from "@p7m/middleware/dist/ipc/PipeEndpoint.js";
import { PROTOCOL_VERSION } from "@p7m/middleware/dist/protocol/jsonrpc.js";
import {
  EDITOR_AUTH_TOKEN_ENV,
  EDITOR_AUTH_TOKEN_FILE_ENV,
  validateTransportAuthToken,
} from "@p7m/middleware/dist/transport/auth.js";
import { createLogger } from "../core/logging.js";
import { GraphQlTransport } from "../main/transport/GraphQlTransport.js";
import { GrpcTransport } from "../main/transport/GrpcTransport.js";

const SCHEMA_VERSION = "p7m.transport-benchmark/v1";
const TRANSPORTS = ["grpc", "graphql", "legacy-jsonrpc"] as const;
const PAYLOAD_CLASSES = ["small", "medium"] as const;
const silentLog = createLogger("transport-benchmark", { level: "silent" });

type TransportName = (typeof TRANSPORTS)[number];
type PayloadClass = (typeof PAYLOAD_CLASSES)[number];
type OperationName = "dispatch" | "query-small" | "query-document" | "event-flow";

interface BenchmarkConfig {
  readonly warmups: number;
  readonly samples: number;
  readonly forks: number;
  readonly concurrency: number;
  readonly eventCount: number;
  readonly graphqlPollIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly flowTimeoutMs: number;
}

interface LevelPayload {
  readonly levelId: string;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly seed: number;
  readonly intGrid: readonly number[];
  readonly rules: readonly unknown[];
}

interface ErrorSample {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

interface TimedCalls {
  readonly attemptedSamples: number;
  readonly latenciesMs: number[];
  readonly responseBytes: number[];
  readonly errors: ErrorSample[];
  readonly wallMs: number;
}

interface RunMeasurement extends TimedCalls {
  readonly fork: number;
  readonly transport: TransportName;
  readonly payloadClass: PayloadClass;
  readonly operation: OperationName;
  readonly applicationPayloadBytes: number;
  readonly resyncs: number;
  readonly resyncObservable: boolean;
  readonly targetEvents?: number;
  readonly receivedEvents?: number;
  readonly completionMs?: number;
  /** Pode ser negativo: alguns transports entregam o evento antes do reply. */
  readonly completionRelativeToLastDispatchMs?: number;
}

interface BenchmarkClient {
  readonly name: TransportName;
  dispatch(payload: LevelPayload): Promise<unknown>;
  query(projection: "camera" | "document"): Promise<unknown>;
  observeLevelUpdates(): Promise<EventObserver>;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

function readConfig(): BenchmarkConfig {
  return Object.freeze({
    warmups: readPositiveInt("P7M_BENCH_WARMUPS", 20),
    samples: readPositiveInt("P7M_BENCH_SAMPLES", 100),
    forks: readPositiveInt("P7M_BENCH_FORKS", 3),
    concurrency: readPositiveInt("P7M_BENCH_CONCURRENCY", 1),
    eventCount: readPositiveInt("P7M_BENCH_EVENT_COUNT", 1_000),
    graphqlPollIntervalMs: readPositiveInt("P7M_BENCH_GRAPHQL_POLL_MS", 10),
    requestTimeoutMs: readPositiveInt("P7M_BENCH_REQUEST_TIMEOUT_MS", 10_000),
    flowTimeoutMs: readPositiveInt("P7M_BENCH_FLOW_TIMEOUT_MS", 30_000),
  });
}

function benchmarkRoot(): string {
  const configured = process.env["P7M_BENCH_ROOT"];
  if (configured) return path.resolve(configured);
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dirname, "../../..");
}

function parseOutputPath(root: string): string {
  const index = process.argv.indexOf("--output");
  if (index >= 0) {
    const supplied = process.argv[index + 1];
    if (!supplied) throw new Error("--output requires a path");
    return path.resolve(supplied);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(root, "benchmarks", "results", `transport-benchmark-${stamp}.json`);
}

function createPayload(size: PayloadClass): LevelPayload {
  const side = size === "small" ? 4 : 32;
  const intGrid = Array.from({ length: side * side }, (_, index) =>
    index % 11 === 0 ? 2 : index % 3 === 0 ? 1 : 0,
  );
  return Object.freeze({
    levelId: "transport-benchmark-level",
    width: side,
    height: side,
    tileSize: 16,
    seed: 1729,
    intGrid: Object.freeze(intGrid),
    rules: Object.freeze([]),
  });
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorSample(error: unknown): ErrorSample {
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown } | undefined;
  const name = typeof candidate?.name === "string" ? candidate.name : "Error";
  const message =
    typeof candidate?.message === "string" ? candidate.message.slice(0, 500) : String(error).slice(0, 500);
  const code = candidate?.code;
  return {
    name,
    message,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function nsToMs(value: bigint): number {
  return Number(value) / 1_000_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timedCalls(
  count: number,
  concurrency: number,
  operation: (sampleIndex: number) => Promise<unknown>,
): Promise<TimedCalls> {
  const latenciesMs: number[] = [];
  const responseBytes: number[] = [];
  const errors: ErrorSample[] = [];
  let next = 0;
  const wallStart = nowNs();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      const started = nowNs();
      try {
        const response = await operation(index);
        latenciesMs.push(nsToMs(nowNs() - started));
        responseBytes.push(jsonBytes(response));
      } catch (error) {
        errors.push(errorSample(error));
      }
    }
  };

  const workerCount = Math.min(count, concurrency);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    attemptedSamples: count,
    latenciesMs,
    responseBytes,
    errors,
    wallMs: nsToMs(nowNs() - wallStart),
  };
}

async function warmUp(
  count: number,
  concurrency: number,
  operation: (sampleIndex: number) => Promise<unknown>,
): Promise<void> {
  const result = await timedCalls(count, concurrency, operation);
  if (result.errors.length > 0) {
    throw new Error(`warmup failed: ${result.errors[0]!.message}`);
  }
}

/** Receptor comum; cada adapter alimenta esta classe pelo mecanismo real. */
class EventObserver {
  private accepted = 0;
  private lastAcceptedAt: bigint | undefined;
  private readonly observedErrors: ErrorSample[] = [];
  private observedResyncs = 0;
  private closeImplementation: (() => void | Promise<void>) | undefined;

  constructor(readonly resyncObservable: boolean) {}

  accept(kind: string): void {
    if (kind !== "levelUpdated") return;
    this.accepted++;
    this.lastAcceptedAt = nowNs();
  }

  fail(error: unknown): void {
    this.observedErrors.push(errorSample(error));
  }

  resync(reason: string): void {
    this.observedResyncs++;
    this.fail(new Error(`event observer requested resync: ${reason || "unspecified"}`));
  }

  attachClose(close: () => void | Promise<void>): void {
    this.closeImplementation = close;
  }

  async waitFor(target: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.accepted < target && this.observedErrors.length === 0 && Date.now() < deadline) {
      await delay(1);
    }
    if (this.accepted < target && this.observedErrors.length === 0) {
      this.fail(new Error(`event completion timeout: received ${this.accepted}/${target}`));
    }
  }

  async close(): Promise<void> {
    await this.closeImplementation?.();
  }

  get count(): number {
    return this.accepted;
  }

  get lastEventAt(): bigint | undefined {
    return this.lastAcceptedAt;
  }

  get errors(): readonly ErrorSample[] {
    return this.observedErrors;
  }

  get resyncs(): number {
    return this.observedResyncs;
  }
}

class GrpcBenchmarkClient implements BenchmarkClient {
  readonly name = "grpc" as const;

  constructor(private readonly transport: GrpcTransport) {}

  dispatch(payload: LevelPayload): Promise<unknown> {
    return this.transport.dispatch("level/update", payload, randomUUID());
  }

  query(projection: "camera" | "document"): Promise<unknown> {
    return this.transport.query(projection);
  }

  async observeLevelUpdates(): Promise<EventObserver> {
    const health = await this.transport.health();
    const observer = new EventObserver(true);
    const cancel = this.transport.streamEvents(
      {
        middlewareInstanceId: health.middlewareInstanceId,
        lastEventSeq: health.lastEventSeq,
      },
      (status) => {
        if (status.resyncRequired) observer.resync(status.resyncReason ?? "unspecified");
      },
      (event) => observer.accept(event.kind),
      (error) => observer.fail(error),
    );
    observer.attachClose(cancel);
    return observer;
  }
}

const GRAPHQL_DISPATCH = `mutation BenchmarkDispatch($payload: JSON!, $requestId: String!) {
  dispatch(kind: level_update, payload: $payload, requestId: $requestId) {
    event projection { status reason detail }
  }
}`;
const GRAPHQL_PROJECTION = `query BenchmarkProjection($name: String!) { projection(name: $name) }`;
const GRAPHQL_HEALTH = `query BenchmarkHealth {
  health { middlewareInstanceId firstAvailableSeq lastEventSeq }
}`;
const GRAPHQL_EVENTS = `query BenchmarkEvents($instance: String!, $after: String!) {
  eventBatch(middlewareInstanceId: $instance, afterSeq: $after) {
    middlewareInstanceId firstAvailableSeq lastEventSeq resyncRequired resyncReason
    events { seq kind payload }
  }
}`;

interface GraphQlEventBatch {
  readonly middlewareInstanceId: string;
  readonly firstAvailableSeq: string;
  readonly lastEventSeq: string;
  readonly resyncRequired: boolean;
  readonly resyncReason: string | null;
  readonly events: ReadonlyArray<{ readonly seq: string; readonly kind: string }>;
}

class GraphQlBenchmarkClient implements BenchmarkClient {
  readonly name = "graphql" as const;

  constructor(
    private readonly transport: GraphQlTransport,
    private readonly pollIntervalMs: number,
  ) {}

  async dispatch(payload: LevelPayload): Promise<unknown> {
    const result = await this.transport.execute<{ dispatch: unknown }>(
      GRAPHQL_DISPATCH,
      { payload, requestId: randomUUID() },
      "BenchmarkDispatch",
    );
    return result.dispatch;
  }

  async query(projection: "camera" | "document"): Promise<unknown> {
    const result = await this.transport.execute<{ projection: unknown }>(
      GRAPHQL_PROJECTION,
      { name: projection },
      "BenchmarkProjection",
    );
    return result.projection;
  }

  async observeLevelUpdates(): Promise<EventObserver> {
    const health = await this.transport.execute<{
      health: { middlewareInstanceId: string; lastEventSeq: string };
    }>(GRAPHQL_HEALTH, undefined, "BenchmarkHealth");
    const observer = new EventObserver(true);
    let active = true;
    let cursor = health.health.lastEventSeq;
    const instance = health.health.middlewareInstanceId;

    const pump = (async (): Promise<void> => {
      while (active) {
        try {
          const result = await this.transport.execute<{ eventBatch: GraphQlEventBatch }>(
            GRAPHQL_EVENTS,
            { instance, after: cursor },
            "BenchmarkEvents",
          );
          const batch = result.eventBatch;
          if (batch.resyncRequired) {
            observer.resync(batch.resyncReason ?? "unspecified");
            active = false;
            return;
          }
          for (const event of batch.events) observer.accept(event.kind);
          cursor = batch.lastEventSeq;
          await delay(this.pollIntervalMs);
        } catch (error) {
          observer.fail(error);
          active = false;
        }
      }
    })();

    observer.attachClose(async () => {
      active = false;
      await pump;
    });
    return observer;
  }
}

class LegacyBenchmarkClient implements BenchmarkClient {
  readonly name = "legacy-jsonrpc" as const;

  constructor(
    readonly peer: JsonRpcPeer,
    private readonly connectEventPeer: () => Promise<JsonRpcPeer>,
  ) {}

  dispatch(payload: LevelPayload): Promise<unknown> {
    return this.peer.request("blueprint/dispatch", { kind: "level/update", payload });
  }

  query(projection: "camera" | "document"): Promise<unknown> {
    return this.peer.request("blueprint/query", { projection });
  }

  async observeLevelUpdates(): Promise<EventObserver> {
    // Uma sessão dedicada evita que notifications acumuladas por benchmarks
    // anteriores sejam confundidas com eventos deste fluxo.
    const eventPeer = await this.connectEventPeer();
    const observer = new EventObserver(false);
    eventPeer.registerMethod("blueprint/event", (params) => {
      const event = params as { kind?: unknown };
      if (typeof event?.kind === "string") observer.accept(event.kind);
    });
    observer.attachClose(() => {
      eventPeer.close();
    });
    return observer;
  }
}

async function connectLegacy(
  pipeName: string,
  authToken: string,
  timeoutMs: number,
): Promise<JsonRpcPeer> {
  const socket = net.connect(resolvePipePath(`${pipeName}-editor`));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("legacy JSON-RPC connect timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const peer = new JsonRpcPeer(socket, {
    label: "transport-benchmark-legacy",
    requestTimeoutMs: timeoutMs,
  });
  await peer.request("editor/handshake", {
    clientName: "p7m-transport-benchmark",
    protocolVersion: PROTOCOL_VERSION,
    authToken,
  });
  return peer;
}

interface MiddlewareProcess {
  readonly child: ChildProcess;
  readonly readLogs: () => string;
}

function startMiddleware(root: string, pipeName: string, authToken: string): MiddlewareProcess {
  const entry = path.join(root, "middleware", "dist", "index.js");
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    [EDITOR_AUTH_TOKEN_ENV]: authToken,
    P7M_VERBOSITY: "silent",
  };
  delete childEnvironment[EDITOR_AUTH_TOKEN_FILE_ENV];
  const child = spawn(process.execPath, [entry, "--pipe", pipeName, "--no-mcp"], {
    cwd: root,
    env: childEnvironment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  child.on("error", (error) => {
    logs = (logs + `${error.name}: ${error.message}\n`).slice(-64 * 1024);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    logs = (logs + chunk).slice(-64 * 1024);
  });
  return { child, readLogs: () => logs };
}

async function stopMiddleware(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function waitForGateways(
  grpc: GrpcTransport,
  graphql: GraphQlTransport,
  middleware: MiddlewareProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (middleware.child.exitCode !== null || middleware.child.signalCode !== null) {
      throw new Error(
        `middleware exited during readiness (code=${middleware.child.exitCode}, signal=${middleware.child.signalCode})\n${middleware.readLogs()}`,
      );
    }
    try {
      await Promise.all([
        grpc.health(),
        graphql.execute("{ health { ok } }"),
      ]);
      return;
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw new Error(
    `transport gateways did not become ready: ${errorSample(lastError).message}\n${middleware.readLogs()}`,
  );
}

async function preparePayload(
  legacy: LegacyBenchmarkClient,
  payload: LevelPayload,
  previousPayload: LevelPayload | undefined,
): Promise<void> {
  if (previousPayload) {
    await legacy.peer.request("blueprint/dispatch", {
      kind: "level/remove",
      payload: { levelId: previousPayload.levelId },
    });
  }
  await legacy.peer.request("blueprint/dispatch", {
    kind: "level/define",
    payload,
  });
}

async function measureStandardOperation(
  fork: number,
  client: BenchmarkClient,
  payloadClass: PayloadClass,
  operation: Exclude<OperationName, "event-flow">,
  applicationPayloadBytes: number,
  config: BenchmarkConfig,
  call: (sampleIndex: number) => Promise<unknown>,
): Promise<RunMeasurement> {
  await warmUp(config.warmups, config.concurrency, call);
  const measured = await timedCalls(config.samples, config.concurrency, call);
  return {
    ...measured,
    fork,
    transport: client.name,
    payloadClass,
    operation,
    applicationPayloadBytes,
    resyncs: 0,
    resyncObservable: false,
  };
}

async function measureEventFlow(
  fork: number,
  client: BenchmarkClient,
  payloadClass: PayloadClass,
  payload: LevelPayload,
  config: BenchmarkConfig,
): Promise<RunMeasurement> {
  const observer = await client.observeLevelUpdates();
  const started = nowNs();
  let dispatchDone = started;
  try {
    const measured = await timedCalls(
      config.eventCount,
      config.concurrency,
      () => client.dispatch(payload),
    );
    dispatchDone = nowNs();
    await observer.waitFor(measured.latenciesMs.length, config.flowTimeoutMs);
    const lastEventAt = observer.lastEventAt ?? nowNs();
    const errors = [...measured.errors, ...observer.errors];
    if (observer.count !== measured.latenciesMs.length) {
      errors.push(
        errorSample(
          new Error(
            `event accounting mismatch: ${observer.count} received for ${measured.latenciesMs.length} successful dispatches`,
          ),
        ),
      );
    }
    return {
      ...measured,
      errors,
      fork,
      transport: client.name,
      payloadClass,
      operation: "event-flow",
      applicationPayloadBytes: jsonBytes(payload),
      resyncs: observer.resyncs,
      resyncObservable: observer.resyncObservable,
      targetEvents: config.eventCount,
      receivedEvents: observer.count,
      completionMs: nsToMs(lastEventAt - started),
      completionRelativeToLastDispatchMs: nsToMs(lastEventAt - dispatchDone),
    };
  } finally {
    await observer.close();
  }
}

function rotate<T>(values: readonly T[], by: number): T[] {
  const offset = by % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

async function runFork(
  root: string,
  fork: number,
  config: BenchmarkConfig,
  authToken: string,
): Promise<RunMeasurement[]> {
  const pipeName = `p7m-bench-${process.pid}-${fork}-${Date.now().toString(36)}`;
  const middleware = startMiddleware(root, pipeName, authToken);
  const grpcTransport = new GrpcTransport(pipeName, silentLog, config.requestTimeoutMs, authToken);
  const graphQlTransport = new GraphQlTransport(pipeName, silentLog, config.requestTimeoutMs, authToken);
  let legacyPeer: JsonRpcPeer | undefined;

  try {
    await waitForGateways(grpcTransport, graphQlTransport, middleware, config.requestTimeoutMs);
    legacyPeer = await connectLegacy(pipeName, authToken, config.requestTimeoutMs);
    const clients: Readonly<Record<TransportName, BenchmarkClient>> = {
      grpc: new GrpcBenchmarkClient(grpcTransport),
      graphql: new GraphQlBenchmarkClient(graphQlTransport, config.graphqlPollIntervalMs),
      "legacy-jsonrpc": new LegacyBenchmarkClient(
        legacyPeer,
        () => connectLegacy(pipeName, authToken, config.requestTimeoutMs),
      ),
    };
    const legacy = clients["legacy-jsonrpc"] as LegacyBenchmarkClient;
    const measurements: RunMeasurement[] = [];
    let previousPayload: LevelPayload | undefined;

    for (const payloadClass of rotate(PAYLOAD_CLASSES, fork)) {
      const payload = createPayload(payloadClass);
      await preparePayload(legacy, payload, previousPayload);
      previousPayload = payload;
      for (const transportName of rotate(TRANSPORTS, fork)) {
        const client = clients[transportName];
        const payloadBytes = jsonBytes(payload);
        measurements.push(
          await measureStandardOperation(
            fork,
            client,
            payloadClass,
            "dispatch",
            payloadBytes,
            config,
            () => client.dispatch(payload),
          ),
        );
        measurements.push(
          await measureStandardOperation(
            fork,
            client,
            payloadClass,
            "query-small",
            Buffer.byteLength("camera", "utf8"),
            config,
            () => client.query("camera"),
          ),
        );
        measurements.push(
          await measureStandardOperation(
            fork,
            client,
            payloadClass,
            "query-document",
            Buffer.byteLength("document", "utf8"),
            config,
            () => client.query("document"),
          ),
        );
        measurements.push(
          await measureEventFlow(fork, client, payloadClass, payload, config),
        );
      }
    }
    return measurements;
  } finally {
    legacyPeer?.close();
    grpcTransport.close();
    await stopMiddleware(middleware.child);
  }
}

function nearestRank(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return Number(sorted[index]!.toFixed(6));
}

function numericSummary(values: readonly number[]): Record<string, number | null> {
  if (values.length === 0) {
    return { min: null, p50: null, p95: null, p99: null, max: null };
  }
  return {
    min: Number(Math.min(...values).toFixed(6)),
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
    max: Number(Math.max(...values).toFixed(6)),
  };
}

function aggregateMeasurements(runs: readonly RunMeasurement[]): unknown[] {
  const groups = new Map<string, RunMeasurement[]>();
  for (const run of runs) {
    const key = `${run.transport}|${run.payloadClass}|${run.operation}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const first = group[0]!;
      const latencies = group.flatMap((entry) => entry.latenciesMs);
      const responses = group.flatMap((entry) => entry.responseBytes);
      const errors = group.flatMap((entry) => entry.errors);
      const successes = latencies.length;
      const attemptedSamples = group.reduce((sum, entry) => sum + entry.attemptedSamples, 0);
      const totalWallMs = group.reduce((sum, entry) => sum + entry.wallMs, 0);
      const completions = group.flatMap((entry) =>
        entry.completionMs === undefined ? [] : [entry.completionMs],
      );
      const completionRelative = group.flatMap((entry) =>
        entry.completionRelativeToLastDispatchMs === undefined
          ? []
          : [entry.completionRelativeToLastDispatchMs],
      );
      const targetEvents = group.reduce((sum, entry) => sum + (entry.targetEvents ?? 0), 0);
      const receivedEvents = group.reduce((sum, entry) => sum + (entry.receivedEvents ?? 0), 0);
      const completionSeconds = completions.reduce((sum, value) => sum + value, 0) / 1_000;
      return {
        transport: first.transport,
        payloadClass: first.payloadClass,
        operation: first.operation,
        applicationPayloadBytes: first.applicationPayloadBytes,
        attemptedSamples,
        successfulSamples: successes,
        failedSamples: attemptedSamples - successes,
        latencyMs: numericSummary(latencies),
        responseBytes: numericSummary(responses),
        throughputOpsPerSecond:
          totalWallMs > 0 ? Number((successes / (totalWallMs / 1_000)).toFixed(3)) : null,
        errors,
        resyncs: group.reduce((sum, entry) => sum + entry.resyncs, 0),
        resyncObservable: group.every((entry) => entry.resyncObservable),
        ...(first.operation === "event-flow"
          ? {
              targetEvents,
              receivedEvents,
              eventCompletionMs: numericSummary(completions),
              eventCompletionRelativeToLastDispatchMs: numericSummary(completionRelative),
              eventThroughputPerSecond:
                completionSeconds > 0
                  ? Number((receivedEvents / completionSeconds).toFixed(3))
                  : null,
            }
          : {}),
        forks: group.map((entry) => ({
          fork: entry.fork,
          attemptedSamples: entry.attemptedSamples,
          successfulSamples: entry.latenciesMs.length,
          failedSamples: entry.attemptedSamples - entry.latenciesMs.length,
          wallMs: Number(entry.wallMs.toFixed(6)),
          ...(entry.completionMs === undefined
            ? {}
            : {
                targetEvents: entry.targetEvents,
                receivedEvents: entry.receivedEvents,
                completionMs: Number(entry.completionMs.toFixed(6)),
                completionRelativeToLastDispatchMs: Number(
                  (entry.completionRelativeToLastDispatchMs ?? 0).toFixed(6),
                ),
              }),
        })),
      };
    })
    .sort((left, right) => {
      const leftKey = `${left.transport}|${left.payloadClass}|${left.operation}`;
      const rightKey = `${right.transport}|${right.payloadClass}|${right.operation}`;
      return leftKey.localeCompare(rightKey);
    });
}

function gitValue(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function environmentMetadata(root: string): Record<string, unknown> {
  const cpus = os.cpus();
  const status = gitValue(root, ["status", "--porcelain"]);
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    osType: os.type(),
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model.trim() ?? "unknown",
    cpuLogicalCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    gitCommit: gitValue(root, ["rev-parse", "HEAD"]) ?? null,
    gitDirty: status === undefined ? null : status.length > 0,
  };
}

async function main(): Promise<void> {
  const root = benchmarkRoot();
  const config = readConfig();
  const outputPath = parseOutputPath(root);
  const rawToken = process.env[EDITOR_AUTH_TOKEN_ENV];
  if (rawToken === undefined) {
    throw new Error(`${EDITOR_AUTH_TOKEN_ENV} must be set; use scripts/benchmark-transports.sh`);
  }
  const authToken = validateTransportAuthToken(rawToken);
  const allRuns: RunMeasurement[] = [];

  for (let fork = 0; fork < config.forks; fork++) {
    process.stderr.write(
      `[transport-benchmark] fork ${fork + 1}/${config.forks} (samples=${config.samples}, events=${config.eventCount})\n`,
    );
    allRuns.push(...(await runFork(root, fork, config, authToken)));
  }

  const payloads = Object.fromEntries(
    PAYLOAD_CLASSES.map((payloadClass) => {
      const payload = createPayload(payloadClass);
      const canonicalJson = JSON.stringify(payload);
      return [
        payloadClass,
        {
          commandKind: "level/update",
          canonicalJson,
          utf8Bytes: Buffer.byteLength(canonicalJson, "utf8"),
          sha256: sha256(canonicalJson),
        },
      ];
    }),
  );
  const measurements = aggregateMeasurements(allRuns);
  const failedSamples = allRuns.reduce(
    (sum, run) => sum + run.attemptedSamples - run.latenciesMs.length,
    0,
  );
  const errorCount = allRuns.reduce((sum, run) => sum + run.errors.length, 0);
  const resyncs = allRuns.reduce((sum, run) => sum + run.resyncs, 0);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    valid: failedSamples === 0 && errorCount === 0 && resyncs === 0,
    methodology: {
      processIsolation: "fresh real middleware process per fork",
      engine: "not started; isolates editor transport and canonical middleware path",
      implementations: {
        grpc: "frontend/src/main/transport/GrpcTransport.ts",
        graphql: "frontend/src/main/transport/GraphQlTransport.ts",
        legacy: "middleware/src/ipc/JsonRpcPeer.ts over the real EditorGateway",
      },
      percentileMethod: "nearest-rank over successful call latencies from all forks",
      payloadByteDefinition: "UTF-8 bytes of canonical JSON application payload; excludes protocol framing",
      graphqlEventPolling: `fixed ${config.graphqlPollIntervalMs} ms interval`,
      orderPolicy: "payload and transport order rotate deterministically by fork",
    },
    environment: environmentMetadata(root),
    config,
    payloads,
    measurements,
    totals: {
      failedSamples,
      errorCount,
      resyncs,
      measurementCount: measurements.length,
    },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${outputPath}\n`);
  if (!report.valid) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `[transport-benchmark] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
