import assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalOpenIntentQueue } from "../src/core/externalOpenIntentQueue.js";
import { PendingEditCoordinator } from "../src/core/pendingEditCoordinator.js";

test("PendingEditCoordinator aguarda commit iniciado antes de Save", async () => {
  const coordinator = new PendingEditCoordinator();
  let release!: () => void;
  const operation = new Promise<void>((resolve) => { release = resolve; });
  coordinator.track("entity.position", operation);
  let flushed = false;
  const flush = coordinator.flush().then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);
  release();
  await flush;
  assert.equal(coordinator.size, 0);
});

test("PendingEditCoordinator bloqueia Save após rejeição até correção do mesmo campo", async () => {
  const coordinator = new PendingEditCoordinator();
  const failure = new Error("Valor inválido");
  await assert.rejects(coordinator.track("light.radius", Promise.reject(failure)), failure);
  await assert.rejects(coordinator.flush(), failure);

  await coordinator.track("light.radius", Promise.resolve());
  await coordinator.flush();
});

test("PendingEditCoordinator descarta falhas ao trocar de sessão", async () => {
  const coordinator = new PendingEditCoordinator();
  await assert.rejects(coordinator.track("camera.frequency", Promise.reject(new Error("falhou"))));
  coordinator.clear();
  await coordinator.flush();
});

test("external open: draft inválido preserva path; correção abre o mesmo arquivo uma vez", async () => {
  const coordinator = new PendingEditCoordinator();
  const key = "session-a/entity-a/position";
  await assert.rejects(coordinator.track(key, Promise.reject(new Error("Draft inválido"))));
  const opened: string[] = [];
  const attempts: string[] = [];
  const queue = new ExternalOpenIntentQueue(async (filePath) => {
    attempts.push(filePath);
    try {
      await coordinator.flush();
    } catch {
      return "blocked";
    }
    opened.push(filePath);
    return "consumed";
  });

  await queue.enqueue("/projects/example.p7m.json");
  assert.deepEqual(queue.pendingPaths, ["/projects/example.p7m.json"]);
  assert.deepEqual(opened, []);

  await coordinator.track(key, Promise.resolve());
  await queue.retry();
  assert.deepEqual(opened, ["/projects/example.p7m.json"]);
  assert.deepEqual(attempts, ["/projects/example.p7m.json", "/projects/example.p7m.json"]);
  assert.deepEqual(queue.pendingPaths, []);
});
