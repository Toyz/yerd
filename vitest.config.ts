import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { yerdDecorators } from "./src/vite/index.js";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  // Tests run DOM code in the "client" environment; keep it at ES2022 so the
  // client runtime's source (shipped via fn.toString()) stays self-contained.
  plugins: [yerdDecorators({ clientTarget: "es2022" })],
  resolve: {
    // Point at src so tests exercise the working tree, not the last build.
    // Subpaths before the bare name: aliases match in order.
    alias: [
      { find: "@toyz/yerd/auth", replacement: src("auth/index.ts") },
      { find: "@toyz/yerd/jsx-runtime", replacement: src("jsx/jsx-runtime.ts") },
      { find: "@toyz/yerd/jsx-dev-runtime", replacement: src("jsx/jsx-dev-runtime.ts") },
      { find: /^@toyz\/yerd$/, replacement: src("index.ts") },
    ],
  },
  test: {
    include: ["test/unit/**/*.test.{ts,tsx}"],
  },
});
