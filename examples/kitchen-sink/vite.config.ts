import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import yerd from "../../src/vite/index.js";

const src = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // `client`: hashed by `vite build` and linked through the manifest (<Stylesheet>, assetUrl()).
  plugins: [yerd({ entry: "/src/main.ts", client: ["src/styles.css", "src/hero.svg"] })],
  resolve: {
    // Run against the working tree. A real app gets @toyz/yerd from node_modules.
    alias: [
      { find: "@toyz/yerd/auth", replacement: src("auth/index.ts") },
      { find: "@toyz/yerd/jsx-runtime", replacement: src("jsx/jsx-runtime.ts") },
      { find: "@toyz/yerd/jsx-dev-runtime", replacement: src("jsx/jsx-dev-runtime.ts") },
      { find: /^@toyz\/yerd$/, replacement: src("index.ts") },
    ],
  },
  server: { port: Number(process.env.PORT ?? 3300), strictPort: true },
});
