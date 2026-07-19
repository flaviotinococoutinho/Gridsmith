import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ProjectStatus } from "../src/canonical/ProjectSessionManager.js";
import type {
  CurrentEngineSessionChangedEvent,
  EnginePipeServer,
} from "../src/ipc/EnginePipeServer.js";
import { bindEngineProjectSessionLifecycle } from "../src/runtime/EngineProjectSessionLifecycle.js";

const ACTIVE_STATUS: ProjectStatus = Object.freeze({
  active: true,
  projectSessionId: "project-session-current",
  projectId: "project-current",
  createdAt: 1,
  commandSequence: "0",
  runtimeState: "synchronized",
});

test("lifecycle da engine reidrata em cada troca efetiva e pode ser desligado", async () => {
  const server = new EventEmitter() as EnginePipeServer;
  const calls: string[] = [];
  const observed: string[] = [];
  const sessions = {
    async rehydrateCurrent(): Promise<ProjectStatus> {
      calls.push("rehydrate");
      return ACTIVE_STATUS;
    },
  };
  const unbind = bindEngineProjectSessionLifecycle(server, sessions, {
    onRehydrated: (_status, change) => observed.push(change.reason),
  });

  emitChange(server, { reason: "connected", runtimeSessionEpoch: 1 });
  emitChange(server, { reason: "superseded", runtimeSessionEpoch: 2 });
  emitChange(server, { reason: "disconnected", runtimeSessionEpoch: 3 });
  await settleLifecycleCallbacks();

  assert.deepEqual(calls, ["rehydrate", "rehydrate", "rehydrate"]);
  assert.deepEqual(observed, ["connected", "superseded", "disconnected"]);

  unbind();
  unbind();
  emitChange(server, { reason: "connected", runtimeSessionEpoch: 4 });
  await settleLifecycleCallbacks();
  assert.equal(calls.length, 3);
});

test("lifecycle da engine encaminha falha sem criar rejeição não observada", async () => {
  const server = new EventEmitter() as EnginePipeServer;
  const expected = new Error("reset failed");
  const failures: Array<{ error: Error; reason: string }> = [];
  const unbind = bindEngineProjectSessionLifecycle(
    server,
    {
      async rehydrateCurrent(): Promise<ProjectStatus> {
        throw expected;
      },
    },
    {
      onError: (error, change) => failures.push({ error, reason: change.reason }),
    },
  );

  emitChange(server, { reason: "connected", runtimeSessionEpoch: 1 });
  await settleLifecycleCallbacks();

  assert.deepEqual(failures, [{ error: expected, reason: "connected" }]);
  unbind();
});

function emitChange(
  server: EnginePipeServer,
  change: CurrentEngineSessionChangedEvent,
): void {
  server.emit("currentSessionChanged", Object.freeze(change));
}

async function settleLifecycleCallbacks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
