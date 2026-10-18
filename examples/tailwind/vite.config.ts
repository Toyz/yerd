import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import yerd from "../../src/vite/index.js";

const src = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss(), yerd({ entry: "/src/main.tsx" })],
  resolve: {
    alias: [
      { find: "@toyz/yerd/auth", replacement: src("auth/index.ts") },
      { find: "@toyz/yerd/jsx-runtime", replacement: src("jsx/jsx-runtime.ts") },
      { find: "@toyz/yerd/jsx-dev-runtime", replacement: src("jsx/jsx-dev-runtime.ts") },
      { find: /^@toyz\/yerd$/, replacement: src("index.ts") },
    ],
  },
  server: { port: Number(process.env.PORT ?? 3000), strictPort: true },
});
