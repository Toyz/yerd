import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import yerd from "../../../src/vite/index.js";

const src = (path: string) => fileURLToPath(new URL(`../../../src/${path}`, import.meta.url));

/**
 * The runtime fixture: a small yerd app that exists only for the e2e suite,
 * one page per client runtime feature. Built with `vite build` and served by
 * serve.ts (two instances, one of which the tests can restart).
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [yerd({ entry: "/src/main.ts", client: ["src/fixture.css"] })],
  resolve: {
    // The working tree's yerd, like the examples.
    alias: [
      { find: "@toyz/yerd/client", replacement: src("client/index.ts") },
      { find: "@toyz/yerd/jsx-runtime", replacement: src("jsx/jsx-runtime.ts") },
      { find: "@toyz/yerd/jsx-dev-runtime", replacement: src("jsx/jsx-dev-runtime.ts") },
      { find: /^@toyz\/yerd$/, replacement: src("index.ts") },
    ],
  },
  // Never written by the tests themselves, but keep the build quiet.
  logLevel: "warn",
  server: { port: Number(process.env.PORT ?? 3210), strictPort: true },
});
