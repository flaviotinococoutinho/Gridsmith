import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSchema, graphql } from "graphql";
import type { EditorSurface } from "../src/canonical/EditorSurface.js";
import {
  GraphQlGateway,
  graphQlErrorExtensions,
} from "../src/graphql/GraphQlGateway.js";
import { JsonRpcError, RpcErrorCode } from "../src/protocol/jsonrpc.js";
import { EventJournal } from "../src/transport/EventJournal.js";
import { generateTransportAuthToken } from "../src/transport/auth.js";
import { createLogger } from "../src/util/log.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "../..");
const schemaSource = fs.readFileSync(
  path.join(repository, "contracts/graphql/editor.schema.graphql"),
  "utf8",
);
const silent = createLogger("graphql-assets-contract", { level: "silent" });

const summary = {
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
  clipCount: 1,
  updatedAt: "1700000000000",
};

test("GraphQL assets: superfície fria é completa e não cria segundo cursor", () => {
  const schema = buildSchema(schemaSource);
  const query = schema.getQueryType()!.getFields();
  const mutation = schema.getMutationType()!.getFields();
  assert.ok(query["assetCatalog"]);
  assert.ok(query["assetDetails"]);
  assert.equal(query["applicationEventBatch"], undefined);
  for (const field of [
    "assetImport",
    "assetReimport",
    "assetRemove",
    "assetConfigureTools",
    "assetRevealSource",
    "assetRevealOutput",
    "assetCancel",
  ]) {
    assert.ok(mutation[field], `missing GraphQL asset mutation ${field}`);
  }
  const cursorEvent = schema.getType("CursorEventEnvelope");
  assert.ok(cursorEvent && "getFields" in cursorEvent);
  assert.equal(
    (cursorEvent as { getFields(): Record<string, { type: { toString(): string } }> })
      .getFields()["application"]?.type.toString(),
    "EditorApplicationEvent",
  );
});

test("GraphQL assets: catálogo e ACK assíncrono têm contrato explícito", async () => {
  const schema = buildSchema(schemaSource);
  let catalogArgs: unknown;
  let importArgs: unknown;
  const root = {
    assetCatalog: (args: unknown) => {
      catalogArgs = args;
      return {
        projectSessionId: "session-a",
        projectId: "project-a",
        assets: [summary],
        tags: ["characters", "hero"],
        directories: ["characters"],
      };
    },
    assetImport: (args: unknown) => {
      importArgs = args;
      return {
        operationId: "op-1",
        operation: "import",
        status: "accepted",
        projectSessionId: "session-a",
        projectId: "project-a",
        assetId: null,
        message: null,
      };
    },
  };
  const catalog = await graphql({
    schema,
    rootValue: root,
    source: `query AssetCatalog($filter: AssetCatalogFilterInput) {
      assetCatalog(filter: $filter) {
        projectSessionId projectId tags directories
        assets { assetId name thumbnailDataUrl updatedAt }
      }
    }`,
    variableValues: {
      filter: { search: "hero", tags: ["characters"], directory: "characters" },
    },
  });
  assert.equal(catalog.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(catalogArgs)), {
    filter: { search: "hero", tags: ["characters"], directory: "characters" },
  });
  assert.equal(
    ((catalog.data?.["assetCatalog"] as { assets: Array<{ assetId: string }> }).assets[0]?.assetId),
    "assets/characters/hero",
  );

  const imported = await graphql({
    schema,
    rootValue: root,
    source: `mutation AssetImport($input: AssetImportInput!) {
      assetImport(input: $input) {
        operationId operation status projectSessionId projectId
      }
    }`,
    variableValues: {
      input: { sourcePath: "/catalog/characters/hero.aseprite", operationId: "op-1" },
    },
  });
  assert.equal(imported.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(importArgs)), {
    input: { sourcePath: "/catalog/characters/hero.aseprite", operationId: "op-1" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(imported.data?.["assetImport"])), {
    operationId: "op-1",
    operation: "import",
    status: "accepted",
    projectSessionId: "session-a",
    projectId: "project-a",
  });
});

test("GraphQL assets: evento operacional tipado compartilha o cursor seguro", async () => {
  const schema = buildSchema(schemaSource);
  const root = {
    eventBatch: () => ({
      middlewareInstanceId: "middleware-a",
      projectSessionId: "session-a",
      projectId: "project-a",
      commandSequence: "7",
      firstAvailableSeq: "1",
      lastEventSeq: "11",
      resyncRequired: false,
      resyncReason: null,
      events: [{
        seq: "11",
        projectSessionId: "session-a",
        projectId: "project-a",
        commandSequence: "7",
        kind: "asset/operationProgress",
        payload: {},
        application: {
          seq: "11",
          projectSessionId: "session-a",
          projectId: "project-a",
          commandSequence: "7",
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
          payload: { assetId: "assets/characters/hero" },
          timestamp: "1700000000000",
        },
      }],
    }),
  };
  const result = await graphql({
    schema,
    rootValue: root,
    source: `query {
      eventBatch(middlewareInstanceId: "middleware-a", projectSessionId: "session-a", afterSeq: "10") {
        lastEventSeq
        events {
          seq kind
          application {
            domain kind operationId severity timestamp
            progress { phase current total percent message }
            payload
          }
        }
      }
    }`,
  });
  assert.equal(result.errors, undefined);
  const event = (result.data?.["eventBatch"] as {
    events: Array<{ application: { operationId: string; progress: { percent: number } } }>;
  }).events[0]!;
  assert.equal(event.application.operationId, "op-1");
  assert.equal(event.application.progress.percent, 75);
});

test("GraphQlGateway: fachada delega e normaliza catálogo/cancelamento reais", async () => {
  const sourceAsset = {
    assetId: "assets/characters/hero",
    kind: "sprite-document",
    name: "hero",
    directory: "characters",
    projectSessionId: "session-a",
    projectId: "project-a",
    revision: 2,
    contentHash: "deadbeef",
    tags: ["characters"],
    clipCount: 1,
    paths: {
      source: "/catalog/characters/hero.aseprite",
      originSource: "/origin/hero.aseprite",
      managedSource: "/catalog/characters/hero.aseprite",
      spritesheet: "/output/characters/hero.png",
      metadata: "/output/characters/hero.json",
      compiled: "/output/compiled/hero.xnb",
      outputDirectory: "/output/compiled",
    },
    sourcePath: "/origin/hero.aseprite",
    thumbnailPath: "/output/characters/hero.png",
    spritesheetPng: "/output/characters/hero.png",
    compiledXnb: "/output/compiled/hero.xnb",
    importedAt: 1700000000000,
    updatedAt: 1700000000000,
    thumbnailDataUrl: "data:image/png;base64,AA==",
  };
  let observedFilter: unknown;
  const surface = {
    assetCatalog: (filter: unknown) => {
      observedFilter = filter;
      return {
        projectSessionId: "session-a",
        projectId: "project-a",
        assets: [sourceAsset],
        tags: ["characters"],
        directories: ["characters"],
      };
    },
    cancelAssetOperation: () => ({
      operationId: "op-1",
      status: "cancellation-requested",
      cancelled: true,
    }),
  } as unknown as EditorSurface;
  const gateway = new GraphQlGateway({
    pipeName: `graphql-assets-contract-${process.pid}`,
    surface,
    journal: new EventJournal(),
    log: silent,
    authToken: generateTransportAuthToken(),
  });
  const rootValue = (gateway as unknown as { rootValue(): Record<string, unknown> }).rootValue();
  const catalog = await graphql({
    schema: buildSchema(schemaSource),
    rootValue,
    source: `query {
      assetCatalog(filter: {search: "hero", tags: ["characters"]}) {
        assets { assetId kind name sourcePath directory thumbnailDataUrl updatedAt }
      }
    }`,
  });
  assert.equal(catalog.errors, undefined);
  assert.deepEqual(observedFilter, { search: "hero", tags: ["characters"] });
  const mapped = ((catalog.data?.["assetCatalog"] as { assets: Array<Record<string, unknown>> })
    .assets[0])!;
  assert.equal(mapped["sourcePath"], "/origin/hero.aseprite");
  assert.equal(mapped["updatedAt"], "1700000000000");

  const cancelled = await graphql({
    schema: buildSchema(schemaSource),
    rootValue,
    source: `mutation { assetCancel(operationId: "op-1") { operationId status cancelled } }`,
  });
  assert.equal(cancelled.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(cancelled.data?.["assetCancel"])), {
    operationId: "op-1",
    status: "cancellation_requested",
    cancelled: true,
  });
});

test("contrato gRPC permanece sem RPC específico de assets", () => {
  const proto = fs.readFileSync(
    path.join(repository, "contracts/grpc/p7m_editor.proto"),
    "utf8",
  );
  assert.doesNotMatch(proto, /rpc\s+(?:Asset|ImportAsset|ReimportAsset|RemoveAsset)/u);
});

test("MCP de assets é somente leitura e não inicia ferramentas externas", () => {
  const facade = fs.readFileSync(
    path.join(repository, "middleware/src/mcp/McpFacade.ts"),
    "utf8",
  );
  assert.match(facade, /"asset_catalog"/u);
  assert.doesNotMatch(facade, /"asset_ingest"/u);
});

test("GraphQL assets: diagnóstico acionável preserva etapa, stderr e ações", () => {
  assert.deepEqual(graphQlErrorExtensions(new JsonRpcError(
    RpcErrorCode.InvalidParams,
    "MGCB falhou",
    {
      assetErrorCode: "ASSET_TOOL_FAILED",
      stage: "compiling",
      filePath: "/project/player.aseprite",
      stderr: "compile failed",
      suggestedActions: ["Configure MGCB", "Open source"],
    },
  )), {
    code: RpcErrorCode.InvalidParams,
    assetErrorCode: "ASSET_TOOL_FAILED",
    stage: "compiling",
    filePath: "/project/player.aseprite",
    stderr: "compile failed",
    suggestedActions: ["Configure MGCB", "Open source"],
  });
});
