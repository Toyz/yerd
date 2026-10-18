// Minify the client runtime for the published package. Run by `npm run build`
// after tsc: it takes the runtime's functions (the core and each chunk) from
// the build, as source (runtimePieces(), which also checks they weren't
// compiled below ES2017), minifies each with esbuild (a dev dependency;
// nothing at runtime needs it), and replaces dist/src/client/runtime-min.js,
// which runtimeSource() and chunkSource() then prefer. Only that module
// changes, so JSDoc in the .d.ts files stays.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { transform } from "esbuild";

type Pieces = { core: string; chunks: Record<string, string> };

/** A runtime script, minified, and checked to still be one self-contained script. */
export async function minifyRuntime(source: string): Promise<string> {
  const { code } = await transform(source, { minify: true, target: "es2022", legalComments: "none", charset: "utf8" });
  if (/\b__(async|awaiter|generator)\b/.test(code)) throw new Error("the minified runtime calls a compiler helper; it must be self-contained");
  // Compiles (without running) or throws: it's a script, not a module.
  new Function(code);
  return code;
}

/** A runtime function's source, minified: still one function expression, as self-contained as before. */
export async function minifyFunction(source: string): Promise<string> {
  // As a variable's value, so esbuild keeps it an expression (and its name, at the top level, is never mangled).
  const code = (await minifyRuntime(`var yerdPiece = ${source};`)).trim();
  const prefix = "var yerdPiece=";
  if (!code.startsWith(prefix) || !code.endsWith(";")) throw new Error(`esbuild minified a runtime function to something unexpected: ${code.slice(0, 40)}`);
  const fn = code.slice(prefix.length, -1);
  new Function(`return (${fn});`);
  return fn;
}

/** Every piece of the runtime, minified. */
export async function minifyPieces(pieces: Pieces): Promise<Pieces> {
  const chunks: Record<string, string> = {};
  for (const [name, source] of Object.entries(pieces.chunks)) chunks[name] = await minifyFunction(source);
  return { core: await minifyFunction(pieces.core), chunks };
}

/** "12.3 KB raw, 4.5 KB gzip, 4.0 KB brotli". */
function sizes(text: string): string {
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  const raw = Buffer.from(text);
  return `${kb(raw.length)} raw, ${kb(gzipSync(raw, { level: 9 }).length)} gzip, ${kb(brotliCompressSync(raw).length)} brotli`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dist = new URL("../dist/src/client/", import.meta.url);
  const { runtimePieces } = (await import(new URL("runtime.js", dist).href)) as { runtimePieces(): Pieces };
  const pieces = runtimePieces();
  const minified = await minifyPieces(pieces);
  const out = new URL("runtime-min.js", dist);
  if (!readFileSync(out, "utf8").includes("export const minified")) throw new Error(`${fileURLToPath(out)} isn't the runtime-min module`);
  writeFileSync(out, `export const minified = ${JSON.stringify(minified)};\n`);
  // tsc's map is for the placeholder, not this.
  rmSync(new URL("runtime-min.js.map", dist), { force: true });
  console.log(`client runtime core: ${pieces.core.length} -> ${sizes(minified.core)}`);
  for (const [name, code] of Object.entries(minified.chunks)) console.log(`client runtime ${name} chunk: ${pieces.chunks[name]!.length} -> ${sizes(code)}`);
}
