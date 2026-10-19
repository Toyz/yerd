import { defineConfig } from "vitest/config";
import { yerdDecorators } from "@toyz/yerd/vite";

export default defineConfig({
  // Lowers TC39 decorators, which Vite can't yet. Tests don't need the dev server.
  plugins: [yerdDecorators()],
  test: { include: ["test/**/*.test.{ts,tsx}"] },
});
