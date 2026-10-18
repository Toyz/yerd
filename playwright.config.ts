import { defineConfig } from "@playwright/test";

const devPort = 3200;
const prodPort = 3201;

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: {
    // The system Chrome: no browser download needed.
    channel: "chrome",
    headless: true,
  },
  // The same suite, against the Vite dev server and against a production build.
  projects: [
    { name: "dev", use: { baseURL: `http://localhost:${devPort}` } },
    { name: "prod", use: { baseURL: `http://localhost:${prodPort}` } },
  ],
  webServer: [
    {
      command: "npx vite --config examples/todo/vite.config.ts",
      env: { TODO_FILE: ":memory:", PORT: String(devPort) },
      url: `http://localhost:${devPort}/about`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npx vite build --config examples/todo/vite.config.ts && node examples/todo/dist/server/server.js",
      env: { TODO_FILE: ":memory:", PORT: String(prodPort) },
      url: `http://localhost:${prodPort}/about`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
