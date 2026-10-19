import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { PORTS, url } from "./test/e2e/ports.js";

const CI = !!process.env.CI;

// The system Chrome: no browser download needed (the GitHub runners ship it).
const chrome = { channel: "chrome" };

/**
 * The projects, all in Chrome: `npm run e2e`. Each example's suite
 * against its Vite dev server and its production build, and the runtime fixture.
 */
const chromium: NonNullable<PlaywrightTestConfig["projects"]> = [
  { name: "dev", testMatch: "todo.spec.ts", use: { ...chrome, baseURL: url(PORTS.todoDev, "") } },
  { name: "prod", testMatch: "todo.spec.ts", use: { ...chrome, baseURL: url(PORTS.todoProd, "") } },
  { name: "kitchen-dev", testMatch: "kitchen.spec.ts", use: { ...chrome, baseURL: url(PORTS.kitchenDev, "") } },
  { name: "kitchen-prod", testMatch: "kitchen.spec.ts", use: { ...chrome, baseURL: url(PORTS.kitchenProd, "") } },
  { name: "shop-dev", testMatch: "shop.spec.ts", use: { ...chrome, baseURL: url(PORTS.shopDev, "") } },
  { name: "shop-prod", testMatch: "shop.spec.ts", use: { ...chrome, baseURL: url(PORTS.shopProd, "") } },
  { name: "runtime", testMatch: /runtime\/.*\.spec\.ts$/, use: { ...chrome, baseURL: url(PORTS.fixture, "") } },
];

/** Each example in dev (Vite) and as a production build, plus the runtime fixture. */
const servers: NonNullable<PlaywrightTestConfig["webServer"]> = [
  ...(
    [
      ["todo", PORTS.todoDev, PORTS.todoProd, "/about", { TODO_FILE: ":memory:" }],
      ["kitchen-sink", PORTS.kitchenDev, PORTS.kitchenProd, "/about", {}],
      ["shop", PORTS.shopDev, PORTS.shopProd, "/", {}],
    ] as const
  ).flatMap(([example, dev, prod, ready, env]) => [
    {
      command: `npx vite --config examples/${example}/vite.config.ts`,
      env: { ...env, PORT: String(dev) },
      url: url(dev, ready),
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite build --config examples/${example}/vite.config.ts && node examples/${example}/dist/server/server.js`,
      env: { ...env, PORT: String(prod) },
      url: url(prod, ready),
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ]),
  {
    // The runtime fixture: built, then served as two instances plus a control port (see serve.ts).
    command: "npx vite build --config test/e2e/fixture/vite.config.ts && node test/e2e/fixture/serve.ts",
    env: { FIXTURE_PORT: String(PORTS.fixture), FIXTURE_SPARE_PORT: String(PORTS.fixtureSpare), FIXTURE_CONTROL_PORT: String(PORTS.fixtureControl) },
    url: url(PORTS.fixtureControl, "/ready"),
    reuseExistingServer: false,
    timeout: 120_000,
  },
];

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  // One test at a time: the examples keep state in their servers (stock, carts,
  // live feeds) that tests in parallel would see each other change. CI shards
  // the suite across machines instead.
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: CI ? [["github"], ["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    headless: true,
    trace: "on-first-retry",
  },
  projects: chromium,
  webServer: servers,
});
