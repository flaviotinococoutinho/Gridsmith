import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/core/logging.js";
import {
  EditorClient,
  type GraphQlExecutor,
} from "../src/main/EditorClient.js";

interface RecordedCall {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}

class FakeGraphQl implements GraphQlExecutor {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly respond: (call: RecordedCall) => unknown) {}

  async execute<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const call: RecordedCall = { query, ...(variables ? { variables } : {}) };
    this.calls.push(call);
    return this.respond(call) as T;
  }
}

const silent = createLogger("asset-client-test", { level: "silent" });

function clientWith(graphql: GraphQlExecutor): EditorClient {
  return new EditorClient(`asset-client-${process.pid}`, {
    authToken: "asset-test-token",
    graphqlTransport: graphql,
    log: silent,
  });
}

test("EditorClient: catálogo tipado usa somente o baseline GraphQL", async () => {
  const graphql = new FakeGraphQl(({ query }) => {
    assert.match(query, /query AssetCatalog/);
    return {
      assetCatalog: {
        projectSessionId: "session-a",
        projectId: "project-a",
        tags: ["characters", "hero"],
        directories: ["characters"],
        assets: [{
          assetId: "assets/characters/hero",
          kind: "sprite-document",
          name: "hero",
          revision: 2,
          sourcePath: "/catalog/characters/hero.aseprite",
          directory: "characters",
          tags: ["characters", "hero"],
          thumbnailPath: "/output/characters/hero.png",
          thumbnailDataUrl: "data:image/png;base64,AA==",
          spritesheetPng: "/output/characters/hero.png",
          compiledXnb: "/output/compiled/hero.xnb",
          clipCount: 3,
          updatedAt: "1700000000000",
        }],
      },
    };
  });
  const client = clientWith(graphql);
  try {
    const result = await client.assetCatalog({
      search: "hero",
      tags: ["characters"],
      directory: "characters",
    });
    assert.equal(result.assets[0]?.assetId, "assets/characters/hero");
    assert.equal(result.assets[0]?.thumbnailDataUrl, "data:image/png;base64,AA==");
    assert.deepEqual(graphql.calls[0]?.variables, {
      filter: { search: "hero", tags: ["characters"], directory: "characters" },
    });
    assert.equal(client.technicalDiagnostics.activeTransport, "gRPC");
  } finally {
    client.close();
  }
});

test("EditorClient: import/reimport são ACKs GraphQL assíncronos e canceláveis", async () => {
  const graphql = new FakeGraphQl(({ query, variables }) => {
    if (query.includes("mutation AssetImport")) {
      assert.deepEqual(variables, {
        input: { sourcePath: "/catalog/hero.aseprite", operationId: "op-import" },
      });
      return { assetImport: {
        operationId: "op-import",
        operation: "import",
        status: "accepted",
        projectSessionId: "session-a",
        projectId: "project-a",
        assetId: null,
        message: null,
      } };
    }
    if (query.includes("mutation AssetReimport")) {
      return { assetReimport: {
        operationId: "op-reimport",
        operation: "reimport",
        status: "running",
        projectSessionId: "session-a",
        projectId: "project-a",
        assetId: "assets/hero",
        message: null,
      } };
    }
    if (query.includes("mutation AssetCancel")) {
      return {
        assetCancel: {
          operationId: "op-reimport",
          status: "cancellation_requested",
          cancelled: true,
        },
      };
    }
    if (query.includes("mutation AssetRevealSource")) {
      assert.deepEqual(variables, { reference: { operationId: "op-import" } });
      return {
        assetRevealSource: {
          operationId: "op-reveal",
          assetId: null,
          sourceOperationId: "op-import",
          target: "source",
          path: "/origin/hero.aseprite",
          revealed: true,
        },
      };
    }
    throw new Error(`unexpected GraphQL operation: ${query}`);
  });
  const client = clientWith(graphql);
  try {
    const imported = await client.importAsset({
      sourcePath: "/catalog/hero.aseprite",
      operationId: "op-import",
    });
    assert.equal(imported.status, "accepted");
    assert.equal(imported.operation, "import");

    const reimported = await client.reimportAsset("assets/hero", "op-reimport");
    assert.equal(reimported.assetId, "assets/hero");
    assert.equal(reimported.operation, "reimport");

    assert.deepEqual(await client.cancelAssetOperation("op-reimport"), {
      operationId: "op-reimport",
      status: "cancellation-requested",
      cancelled: true,
    });
    assert.deepEqual(await client.revealSource({ operationId: "op-import" }), {
      operationId: "op-reveal",
      sourceOperationId: "op-import",
      target: "source",
      path: "/origin/hero.aseprite",
      revealed: true,
    });
  } finally {
    client.close();
  }
});

test("EditorClient: preview de asset recusa file:// na fronteira", async () => {
  const graphql = new FakeGraphQl(() => ({
    assetCatalog: {
      projectSessionId: "session-a",
      projectId: "project-a",
      tags: [],
      directories: [],
      assets: [{
        assetId: "assets/hero",
        kind: "sprite-document",
        name: "hero",
        revision: 1,
        sourcePath: "/catalog/hero.aseprite",
        directory: "",
        tags: [],
        thumbnailPath: "/output/hero.png",
        thumbnailDataUrl: "file:///output/hero.png",
        spritesheetPng: "/output/hero.png",
        compiledXnb: "/output/hero.xnb",
        clipCount: 0,
        updatedAt: "1700000000000",
      }],
    },
  }));
  const client = clientWith(graphql);
  try {
    await assert.rejects(client.assetCatalog(), /invalid asset thumbnail data URL/);
  } finally {
    client.close();
  }
});

test("EditorClient: evento domain=asset avança cursor sem alcançar Blueprint/dirty", () => {
  const client = clientWith(new FakeGraphQl(() => ({})));
  const receivedBlueprint: string[] = [];
  const receivedApplication: string[] = [];
  client.onBlueprintEvent((event) => receivedBlueprint.push(event.kind));
  client.onApplicationEvent((event) => receivedApplication.push(event.kind));

  const harness = client as unknown as {
    cursor: {
      middlewareInstanceId: string;
      projectSessionId: string;
      projectId: string;
      commandSequence: string;
      firstAvailableSeq: string;
      lastEventSeq: string;
    };
    deliver(event: {
      seq: string;
      kind: string;
      projectSessionId: string;
      projectId: string;
      commandSequence: string;
      payload: unknown;
    }): boolean;
  };
  harness.cursor = {
    middlewareInstanceId: "middleware-a",
    projectSessionId: "session-a",
    projectId: "project-a",
    commandSequence: "7",
    firstAvailableSeq: "1",
    lastEventSeq: "10",
  };

  assert.equal(harness.deliver({
    seq: "11",
    kind: "asset/operationProgress",
    projectSessionId: "session-a",
    projectId: "project-a",
    commandSequence: "7",
    payload: {
      domain: "asset",
      kind: "asset/operationProgress",
      operationId: "op-1",
      progress: {
        phase: "compiling",
        current: 3,
        total: 4,
        percent: 75,
        message: "Compilando",
      },
      severity: "info",
      payload: { assetId: "assets/hero" },
      timestamp: 1700000000000,
    },
  }), true);
  assert.deepEqual(receivedApplication, ["asset/operationProgress"]);
  assert.deepEqual(receivedBlueprint, []);
  assert.equal(harness.cursor.lastEventSeq, "11");
  assert.equal(harness.cursor.commandSequence, "7");
  client.close();
});
