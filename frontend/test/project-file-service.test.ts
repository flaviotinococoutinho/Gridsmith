import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPlatformer2DDocument } from "@p7m/middleware/dist/canonical/ProjectTemplates.js";
import { NodeProjectFileSystem } from "../src/main/project/NodeProjectFileSystem.js";
import { ProjectFileService } from "../src/main/project/ProjectFileService.js";
import { MemoryProjectFileSystem } from "./project-test-fakes.js";

test("escrita segura faz write → flush → close → rename e preserva backup", async () => {
  const fs = new MemoryProjectFileSystem();
  let id = 0;
  const service = new ProjectFileService(fs, () => `id-${++id}`);
  fs.seed("/p/game.p7m.json", "old document");

  await service.writeProject("/p/game.p7m.json", projectDocument("new"));

  assert.equal(fs.content("/p/game.p7m.json.bak"), "old document");
  assert.match(fs.content("/p/game.p7m.json") ?? "", /"projectId": "new"/);
  const temp = "/p/.game.p7m.json.id-1.tmp";
  const write = fs.operations.indexOf(`write:${temp}`);
  const flush = fs.operations.indexOf(`flush:${temp}`);
  const close = fs.operations.indexOf(`close:${temp}`);
  const rename = fs.operations.indexOf(`replace:${temp}->/p/game.p7m.json`);
  assert.ok(write < flush && flush < close && close < rename);
});

test("falha antes do rename final preserva documento válido e limpa temporário", async () => {
  const fs = new MemoryProjectFileSystem();
  let id = 0;
  const service = new ProjectFileService(fs, () => `id-${++id}`);
  fs.seed("/p/game.p7m.json", "valid bytes");
  fs.failReplaceDestination = "/p/game.p7m.json";

  await assert.rejects(service.writeProject("/p/game.p7m.json", projectDocument("broken")), /fault/);

  assert.equal(fs.content("/p/game.p7m.json"), "valid bytes");
  assert.equal(fs.content("/p/.game.p7m.json.id-1.tmp"), undefined);
  assert.equal(fs.content("/p/game.p7m.json.bak"), "valid bytes");
});

test("criação exclusiva nunca sobrescreve destino que apareceu durante New", async () => {
  const fs = new MemoryProjectFileSystem();
  const service = new ProjectFileService(fs, () => "new-id");
  fs.seed("/p/race.p7m.json", "created by another flow");

  await assert.rejects(
    service.createProject("/p/race.p7m.json", projectDocument("ours")),
    /destination exists/,
  );

  assert.equal(fs.content("/p/race.p7m.json"), "created by another flow");
  assert.equal(fs.content("/p/.race.p7m.json.new-id.tmp"), undefined);
});

test("documento inválido nunca alcança temporário nem substitui bytes válidos", async () => {
  const fs = new MemoryProjectFileSystem();
  const service = new ProjectFileService(fs, () => "invalid-id");
  fs.seed("/p/valid.p7m.json", "last valid bytes");

  await assert.rejects(service.writeProject("/p/valid.p7m.json", undefined), /Blueprint completo/);
  await assert.rejects(service.writeProject("/p/valid.p7m.json", null), /Blueprint completo/);

  assert.equal(fs.content("/p/valid.p7m.json"), "last valid bytes");
  assert.equal(fs.operations.some((operation) => operation.startsWith("write:")), false);
});

test("adapter Node restaura swap deixado por crash antes de ler o projeto", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "p7m-swap-recovery-"));
  const destination = path.join(directory, "game.p7m.json");
  const swap = `${destination}.replace-swap`;
  try {
    await fs.writeFile(swap, "last valid bytes", "utf8");
    const adapter = new NodeProjectFileSystem();

    assert.equal(await adapter.readText(destination), "last valid bytes");
    assert.equal(await adapter.exists(destination), true);
    assert.equal(await adapter.exists(swap), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("adapter Node publica New sem sobrescrever um destino real concorrente", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "p7m-new-no-clobber-"));
  const destination = path.join(directory, "game.p7m.json");
  let id = 0;
  const service = new ProjectFileService(new NodeProjectFileSystem(), () => `id-${++id}`);
  try {
    await service.createProject(destination, projectDocument("first"));
    await assert.rejects(
      service.createProject(destination, projectDocument("second")),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
    );

    assert.equal(JSON.parse(await fs.readFile(destination, "utf8")).projectId, "first");
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    assert.equal(
      (await fs.readdir(directory)).some((entry) => entry.endsWith(".tmp")),
      false,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("adapter Node substitui documento real e preserva backup válido", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "p7m-save-backup-"));
  const destination = path.join(directory, "game.p7m.json");
  let id = 0;
  const service = new ProjectFileService(new NodeProjectFileSystem(), () => `id-${++id}`);
  try {
    await service.createProject(destination, projectDocument("before"));
    await service.writeProject(destination, projectDocument("after"));

    assert.equal(JSON.parse(await fs.readFile(destination, "utf8")).projectId, "after");
    assert.equal(
      JSON.parse(await fs.readFile(`${destination}.bak`, "utf8")).projectId,
      "before",
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("recovery só é oferecido quando o autosave real é estritamente mais recente", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "p7m-recovery-time-"));
  const destination = path.join(directory, "game.p7m.json");
  const autosave = `${destination}.autosave`;
  let id = 0;
  const service = new ProjectFileService(new NodeProjectFileSystem(), () => `id-${++id}`);
  try {
    await service.createProject(destination, projectDocument("saved"));
    await service.writeAutosave(destination, projectDocument("draft"));

    await fs.utimes(destination, new Date(2_000), new Date(2_000));
    await fs.utimes(autosave, new Date(1_000), new Date(1_000));
    assert.equal(await service.detectRecovery(destination), undefined);

    await fs.utimes(autosave, new Date(2_000), new Date(2_000));
    assert.equal(await service.detectRecovery(destination), undefined);

    await fs.utimes(autosave, new Date(3_000), new Date(3_000));
    const candidate = await service.detectRecovery(destination);
    assert.equal(candidate?.autosaveModifiedAtMs, 3_000);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function projectDocument(projectId: string) {
  return createPlatformer2DDocument({ projectId, name: projectId });
}
