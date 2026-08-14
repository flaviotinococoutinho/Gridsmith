#!/usr/bin/env node
/**
 * Driver de verificação ponta-a-ponta da Fase 4 (fundação do editor).
 *
 * Conecta-se ao gateway do editor de um middleware REAL (com a engine .NET
 * real do outro lado) e prova o caminho completo da ferramenta visual:
 *
 *  1. handshake de editor e resolução da experiência governada usando a
 *     identidade do runtime conectado (perfil monogame@3.8.2);
 *  2. criação e confirmação de uma ProjectSession explícita pelo gateway legado;
 *  3. dispatch canônico (blueprint/dispatch) com projeção confirmada na
 *     engine e broadcast de eventos recebido de volta;
 *  4. projeções de leitura (blueprint/query) coerentes com o AST;
 *  5. governança na prática: recurso de preview habilitado no perfil 3.8.2
 *     e desabilitado ao pedir a experiência do perfil 3.8.0.
 *
 * Uso: node dist/tools/phase4-driver.js --pipe <nome>
 */

import net from "node:net";
import { JsonRpcPeer } from "../ipc/JsonRpcPeer.js";
import { resolvePipePath } from "../ipc/PipeEndpoint.js";
import { PROTOCOL_VERSION } from "../protocol/jsonrpc.js";
import { loadTransportAuthToken } from "../transport/auth.js";

function step(label: string, message: string): void {
  console.log(`  [${label.padEnd(10)}] ${message}`);
}

function assert(condition: boolean, what: string): void {
  if (!condition) throw new Error(`assertion failed: ${what}`);
  step("assert", what);
}

interface Experience {
  profileVersion: string;
  liveManifestConsidered: boolean;
  decisions: Array<{ feature: string; enabled: boolean; reason: string }>;
}

async function main(): Promise<void> {
  const pipeIdx = process.argv.indexOf("--pipe");
  const pipeName = pipeIdx >= 0 ? process.argv[pipeIdx + 1]! : "gridsmith-engine";
  const authToken = loadTransportAuthToken();
  const editorPath = resolvePipePath(`${pipeName}-editor`);

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(editorPath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  const peer = new JsonRpcPeer(socket, { label: "phase4-driver", requestTimeoutMs: 15_000 });

  const received: string[] = [];
  peer.registerMethod("blueprint/event", (params) => {
    received.push((params as { kind: string }).kind);
  });

  try {
    const session = (await peer.request("editor/handshake", {
      clientName: "phase4-driver",
      protocolVersion: PROTOCOL_VERSION,
      authToken,
    })) as { sessionId: string };
    step("handshake", `editor session ${session.sessionId}`);

    // aguarda a engine conectar e ser descrita (identidade + manifesto vivo)
    let experience: Experience | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      experience = (await peer.request("experience/resolve", {})) as Experience;
      if (experience.liveManifestConsidered) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(experience!.liveManifestConsidered, "live engine manifest feeds the experience");
    assert(
      experience!.profileVersion === "3.8.2",
      `profile ${experience!.profileVersion} resolved from the connected runtime identity`,
    );

    const feature = (exp: Experience, name: string) => exp.decisions.find((d) => d.feature === name);
    assert(feature(experience!, "level.intgrid-editor")?.enabled === true, "intgrid editor enabled (live subsystem)");
    assert(feature(experience!, "preview.embedded")?.enabled === true, "embedded preview enabled on profile 3.8.2");

    // governança por versão: o MESMO runtime com perfil 3.8.0 desabilita o preview
    const older = (await peer.request("experience/resolve", { version: "3.8.0" })) as Experience;
    const oldPreview = feature(older, "preview.embedded")!;
    assert(oldPreview.enabled === false, `preview disabled on profile 3.8.0 ("${oldPreview.reason}")`);

    // O processo inicia deliberadamente sem projeto. Todo dispatch exige uma
    // ProjectSession explícita; confirmar o status também prova que o gateway
    // legado observa a mesma referência ativa usada pelos demais transports.
    const created = (await peer.request("project/create", {
      projectId: "phase4-project",
    })) as {
      status: { active: boolean; projectSessionId: string; projectId: string };
    };
    assert(created.status.active, "project session created before canonical dispatch");
    assert(created.status.projectId === "phase4-project", "created project identity is stable");
    const projectStatus = (await peer.request("project/status", {})) as {
      active: boolean;
      projectSessionId: string;
      projectId: string;
    };
    assert(
      projectStatus.active &&
        projectStatus.projectSessionId === created.status.projectSessionId &&
        projectStatus.projectId === created.status.projectId,
      "project/status confirms the active session",
    );

    // dispatch canônico com engine viva: projeção confirmada
    const dispatch = (await peer.request("blueprint/dispatch", {
      kind: "light/add",
      payload: {
        lightId: "editor-torch",
        type: "point",
        position: [10, 10],
        height: 20,
        color: [1, 0.9, 0.7],
        intensity: 1.5,
        radius: 96,
      },
    })) as { event: { kind: string }; projection: { status: string } };
    assert(dispatch.event.kind === "lightAdded", "canonical dispatch produced the event");
    assert(dispatch.projection.status === "projected", "event projected onto the live engine");

    // broadcast do próprio evento chega ao cliente
    for (let attempt = 0; attempt < 50 && received.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(received.includes("lightAdded"), "blueprint/event broadcast received by the editor");

    // projeção de leitura coerente
    const lights = (await peer.request("blueprint/query", { projection: "lights" })) as {
      lights: Array<{ lightId: string; intensity: number }>;
    };
    assert(lights.lights.some((l) => l.lightId === "editor-torch"), "query projection reflects the AST");

    // nível canônico: o editor envia IntGrid + regras; o adapter resolve o
    // auto-tiling na projeção e a engine consolida em batch estático
    const level = (await peer.request("blueprint/dispatch", {
      kind: "level/define",
      payload: {
        levelId: "editor-level",
        width: 4,
        height: 2,
        tileSize: 16,
        seed: 5,
        intGrid: [0, 0, 0, 0, 1, 1, 1, 1],
        rules: [
          {
            name: "grass-top",
            patternSize: 3,
            pattern: [null, 0, null, null, 1, null, null, null, null],
            tileIds: [100, 101],
          },
        ],
      },
    })) as { projection: { status: string; detail?: { nonEmptyTiles: number; staticBatches: number } } };
    assert(level.projection.status === "projected", "level projected with runtime-side auto-tiling");
    assert(level.projection.detail?.nonEmptyTiles === 4, "grass-top rule resolved the platform row");
    assert(level.projection.detail?.staticBatches === 1, "tiles consolidated into a single static batch");

    // edição incremental do nível (P0.4 ⇄ P0.2): level/update re-resolve e reprojeta
    const update = (await peer.request("blueprint/dispatch", {
      kind: "level/update",
      payload: {
        levelId: "editor-level",
        width: 4,
        height: 2,
        tileSize: 16,
        seed: 5,
        intGrid: [0, 0, 0, 0, 1, 1, 0, 1],
        rules: [
          {
            name: "grass-top",
            patternSize: 3,
            pattern: [null, 0, null, null, 1, null, null, null, null],
            tileIds: [100, 101],
          },
        ],
      },
    })) as { event: { kind: string }; projection: { status: string; detail?: { nonEmptyTiles: number } } };
    assert(update.event.kind === "levelUpdated", "level update produced the levelUpdated event");
    assert(update.projection.status === "projected", "level update re-projected onto the engine");
    assert(update.projection.detail?.nonEmptyTiles === 3, "edited platform re-resolved (one tile erased)");

    const removal = (await peer.request("blueprint/dispatch", {
      kind: "level/remove",
      payload: { levelId: "editor-level" },
    })) as { projection: { status: string } };
    assert(removal.projection.status === "projected", "level removal projected (tilemap/remove)");

    // spawn table (P0.6): definição com archetypeId materializa ator vivo na engine
    await peer.request("blueprint/dispatch", {
      kind: "entitydef/define",
      payload: { entityDefId: "player", archetypeId: "hero", fields: [] },
    });
    const spawn = (await peer.request("blueprint/dispatch", {
      kind: "entity/place",
      payload: { entityId: "player-1", entityDefId: "player", position: [48, 336], fields: {} },
    })) as { projection: { status: string; detail?: { status: string; liveActors: number } } };
    assert(spawn.projection.status === "projected", "entity with archetype spawned as a live actor");
    assert(spawn.projection.detail?.status === "spawned", "engine confirmed the spawn");
    assert(spawn.projection.detail?.liveActors === 1, "engine actor store tracks one live actor");

    // arrastar no editor: entity/move reposiciona o ator vivo sem respawn
    const move = (await peer.request("blueprint/dispatch", {
      kind: "entity/move",
      payload: { entityId: "player-1", position: [96, 320] },
    })) as { event: { kind: string }; projection: { status: string; detail?: { status: string } } };
    assert(move.event.kind === "entityMoved", "entity move produced the entityMoved event");
    assert(move.projection.status === "projected", "live actor repositioned in the engine");
    assert(move.projection.detail?.status === "moved", "engine confirmed the move (no respawn)");

    const despawn = (await peer.request("blueprint/dispatch", {
      kind: "entity/remove",
      payload: { entityId: "player-1" },
    })) as { projection: { status: string } };
    assert(despawn.projection.status === "projected", "entity removal despawned the actor");

    console.log("PHASE 4 DRIVER PASS: editor gateway, canonical dispatch, governed experience, level round-trip and actor spawn verified");
  } finally {
    peer.close();
  }
}

main().catch((err) => {
  console.error(`PHASE 4 DRIVER FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
