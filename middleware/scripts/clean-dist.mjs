import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const middlewareRoot = path.resolve(directory, "..");
const dist = path.join(middlewareRoot, "dist");

// O alvo e constante e validado dentro da raiz do pacote. Isso evita que um
// modulo removido continue sendo distribuido por um build incremental.
if (path.dirname(dist) !== middlewareRoot || path.basename(dist) !== "dist") {
  throw new Error(`refusing to clean unexpected build directory: ${dist}`);
}
fs.rmSync(dist, { recursive: true, force: true });
