// Copia os assets estáticos do renderer para dist (build simples, sem bundler).
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/renderer", { recursive: true });
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/style.css", "dist/renderer/style.css");
console.log("static assets copied to dist/renderer");
