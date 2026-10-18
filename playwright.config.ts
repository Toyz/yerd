import { defineConfig } from "@playwright/test";

const devPort = 3200;
const prodPort = 3201;
const kitchenDevPort = 3202;
const kitchenProdPort = 3203;
const shopDevPort = 3204;
const shopProdPort = 3205;

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
  // Each example's suite, against the Vite dev server and against a production build.
  projects: [
    { name: "dev", testMatch: "todo.spec.ts", use: { baseURL: `http://localhost:${devPort}` } },
    { name: "prod", testMatch: "todo.spec.ts", use: { baseURL: `http://localhost:${prodPort}` } },
    { name: "kitchen-dev", testMatch: "kitchen.spec.ts", use: { baseURL: `http://localhost:${kitchenDevPort}` } },
    { name: "kitchen-prod", testMatch: "kitchen.spec.ts", use: { baseURL: `http://localhost:${kitchenProdPort}` } },
    { name: "shop-dev", testMatch: "shop.spec.ts", use: { baseURL: `http://localhost:${shopDevPort}` } },
    { name: "shop-prod", testMatch: "shop.spec.ts", use: { baseURL: `http://localhost:${shopProdPort}` } },
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
    {
      command: "npx vite --config examples/kitchen-sink/vite.config.ts",
      env: { PORT: String(kitchenDevPort) },
      url: `http://localhost:${kitchenDevPort}/about`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npx vite build --config examples/kitchen-sink/vite.config.ts && node examples/kitchen-sink/dist/server/server.js",
      env: { PORT: String(kitchenProdPort) },
      url: `http://localhost:${kitchenProdPort}/about`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npx vite --config examples/shop/vite.config.ts",
      env: { PORT: String(shopDevPort) },
      url: `http://localhost:${shopDevPort}/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npx vite build --config examples/shop/vite.config.ts && node examples/shop/dist/server/server.js",
      env: { PORT: String(shopProdPort) },
      url: `http://localhost:${shopProdPort}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
