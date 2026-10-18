import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * public/data/benchmarks.sample.json is made-up data for working on the
 * benchmarks page before the harness has run. Vite copies all of public/ into
 * the build, so drop it there: production only ever shows real results.
 */
function dropBenchSample(): Plugin {
  let outDir = "dist";
  return {
    name: "yerd-docs:drop-bench-sample",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      rmSync(resolve(outDir, "data", "benchmarks.sample.json"), { force: true });
    },
  };
}

// Built with @toyz/loom, the same way loom's own docs are: esbuild lowers the
// TC39 decorators and compiles JSX against loom's runtime.
export default defineConfig({
  // GitHub Pages serves the site under /yerd/.
  base: process.env.GITHUB_ACTIONS ? "/yerd/" : "/",
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "@toyz/loom",
    target: "es2022",
    keepNames: true,
  },
  plugins: [dropBenchSample()],
  build: { outDir: "dist", target: "es2022" },
  server: { port: 5180 },
});
