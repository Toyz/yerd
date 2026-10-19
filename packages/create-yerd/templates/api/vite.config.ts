import { defineConfig } from "vite";
import yerd from "@toyz/yerd/vite";

// Vite runs the app in dev with reloads; `vite build` writes dist/server/server.js.
export default defineConfig({
  plugins: [yerd({ entry: "/src/main.ts" })],
});
