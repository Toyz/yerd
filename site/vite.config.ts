import { defineConfig } from "vite";

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
  build: { outDir: "dist", target: "es2022" },
  server: { port: 5180 },
});
