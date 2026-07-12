// Copia os assets estáticos do renderer para dist (build simples, sem bundler).
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/renderer/vendor", { recursive: true });
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/style.css", "dist/renderer/style.css");
// AutoTiler tem ZERO dependências (regra R5 do middleware): pode ser vendorizado
// como módulo único para o renderer/worker — preview usa o MESMO resolvedor
// que a projeção no runtime.
cpSync(
  "node_modules/@p7m/middleware/dist/leveldesign/AutoTiler.js",
  "dist/renderer/vendor/AutoTiler.js",
);
console.log("static assets copied to dist/renderer (incl. vendored AutoTiler)");
