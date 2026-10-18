// Minify the client runtime for the published package. Run by `npm run build`
// after tsc: it takes runtimeSource() from the build (the runtime function's
// source in an IIFE, which also checks it wasn't compiled below ES2017),
// minifies it with esbuild (a dev dependency; nothing at runtime needs it),
// and replaces dist/src/client/runtime-min.js, which runtimeSource() then
// prefers. Only that module changes, so JSDoc in the .d.ts files stays.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";

/** The runtime script, minified, and checked to still be one self-contained script. */
export async function minifyRuntime(source: string): Promise<string> {
  const { code } = await transform(source, { minify: true, target: "es2022", legalComments: "none", charset: "utf8" });
  if (/\b__(async|awaiter|generator)\b/.test(code)) throw new Error("the minified runtime calls a compiler helper; it must be self-contained");
  // Compiles (without running) or throws: it's a script, not a module.
  new Function(code);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = new URL("../dist/src/client/", import.meta.url);
  const { runtimeSource } = (await import(new URL("runtime.js", dist).href)) as { runtimeSource(): string };
  const source = runtimeSource();
  const code = await minifyRuntime(source);
  const out = new URL("runtime-min.js", dist);
  if (!readFileSync(out, "utf8").includes("export const minified")) throw new Error(`${fileURLToPath(out)} isn't the runtime-min module`);
  writeFileSync(out, `export const minified = ${JSON.stringify(code)};\n`);
  // tsc's map is for the placeholder, not this.
  rmSync(new URL("runtime-min.js.map", dist), { force: true });
  console.log(`client runtime: ${source.length} -> ${code.length} bytes`);
}
