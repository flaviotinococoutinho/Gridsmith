// Copia os contratos de transporte (SDL GraphQL + proto gRPC) de contracts/
// (fonte de verdade no repo) para dist/contracts/ — os gateways os carregam
// em runtime e o frontend os consome via node_modules/@p7m/middleware/dist.
// Um teste de paridade garante que a cópia nunca diverge da fonte.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "../..");
const dist = path.join(here, "../dist/contracts");

const files = [
  ["contracts/graphql/editor.schema.graphql", "graphql/editor.schema.graphql"],
  ["contracts/grpc/p7m_editor.proto", "grpc/p7m_editor.proto"],
];

for (const [from, to] of files) {
  const target = path.join(dist, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, from), target);
}
console.log(`transport contracts copied to dist/contracts (${files.length} files)`);
