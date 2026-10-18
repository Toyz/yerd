// M0 spike: Vite 8 dev server (middleware mode), Oxc disabled for app TS, a
// pre-transform plugin that lowers TC39 decorators with esbuild, and the SSR
// module runner executing the decorator spike.
import { createServer } from "vite";
import { transform } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** The shape yerd's Vite plugin will take for TS transforms. */
function decoratorTransform() {
  return {
    name: "yerd:decorators",
    enforce: "pre",
    async transform(code, id) {
      if (!/\.[cm]?tsx?$/.test(id.split("?")[0]) || id.includes("/node_modules/")) return null;
      const r = await transform(code, {
        loader: id.endsWith("x") ? "tsx" : "ts",
        target: "es2022",
        format: "esm",
        jsx: "automatic",
        jsxImportSource: "@toyz/yerd",
        sourcemap: true,
        sourcefile: id,
      });
      return { code: r.code, map: r.map };
    },
  };
}

const server = await createServer({
  root,
  configFile: false,
  logLevel: "warn",
  appType: "custom",
  server: { middlewareMode: true, hmr: false },
  oxc: false,
  plugins: [decoratorTransform()],
});

try {
  const runner = server.environments.ssr.runner;
  const t0 = performance.now();
  await runner.import("/spikes/m0/decorators.tsx");
  console.log(`runner.import ok in ${(performance.now() - t0).toFixed(0)}ms`);
} catch (e) {
  console.log("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await server.close();
}
