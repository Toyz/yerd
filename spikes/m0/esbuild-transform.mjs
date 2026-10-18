// M0 spike: lower the decorator spike with esbuild (via Vite 8's transformWithEsbuild), run on Node.
import { transformWithEsbuild } from "vite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const [file, outDir] = process.argv.slice(2);
const r = await transformWithEsbuild(readFileSync(file, "utf8"), file, {
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "@toyz/yerd",
  format: "esm",
});
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/decorators.js`, r.code);
console.log("decorators left:", /^\s*@\w/m.test(r.code), "accessor left:", /\baccessor\s+\w/.test(r.code));
