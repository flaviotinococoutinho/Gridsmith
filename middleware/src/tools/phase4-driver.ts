#!/usr/bin/env node
/**
 * Driver de verificação ponta-a-ponta da Fase 4 (fundação do editor).
 *
 * Conecta-se ao gateway do editor de um middleware REAL (com a engine .NET
 * real do outro lado) e prova o caminho completo da ferramenta visual:
 *
 *  1. handshake de editor e resolução da experiência governada usando a
 *     identidade do runtime conectado (perfil monogame@3.8.2);
 *  2. dispatch canônico (blueprint/dispatch) com projeção confirmada na
 *     engine e broadcast de eventos recebido de volta;
 *  3. projeções de leitura (blueprint/query) coerentes com o AST;
 *  4. governança na prática: recurso de preview habilitado no perfil 3.8.2
 *     e desabilitado ao pedir a experiência do perfil 3.8.0.
 *
 * Uso: node dist/tools/phase4-driver.js --pipe <nome>
 */

import net from "node:net";
import { JsonRpcPeer } from "../ipc/JsonRpcPeer.js";
import { resolvePipePath } from "../ipc/PipeEndpoint.js";
import { PROTOCOL_VERSION } from "../protocol/jsonrpc.js";

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
  const pipeName = pipeIdx >= 0 ? process.argv[pipeIdx + 1]! : "p7m-engine";
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

    const removal = (await peer.request("blueprint/dispatch", {
      kind: "level/remove",
      payload: { levelId: "editor-level" },
    })) as { projection: { status: string } };
    assert(removal.projection.status === "projected", "level removal projected (tilemap/remove)");

    console.log("PHASE 4 DRIVER PASS: editor gateway, canonical dispatch, governed experience and level round-trip verified");
  } finally {
    peer.close();
  }
}

main().catch((err) => {
  console.error(`PHASE 4 DRIVER FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
