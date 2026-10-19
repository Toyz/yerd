import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
import { PORTS, url } from "./test/e2e/ports.js";

const CI = !!process.env.CI;

// Chromium is the system Chrome (no browser download needed locally; the
// GitHub runners ship it). Firefox and WebKit are Playwright's own builds:
// `npx playwright install firefox webkit`.
const chrome = { channel: "chrome" };

/**
 * The default projects, all in Chrome: `npm run e2e`. Each example's suite
 * against its Vite dev server and its production build, the runtime fixture,
 * the no-JavaScript passes and the accessibility checks.
 */
const chromium: NonNullable<PlaywrightTestConfig["projects"]> = [
  { name: "dev", testMatch: "todo.spec.ts", use: { ...chrome, baseURL: url(PORTS.todoDev, "") } },
  { name: "prod", testMatch: "todo.spec.ts", use: { ...chrome, baseURL: url(PORTS.todoProd, "") } },
  { name: "kitchen-dev", testMatch: "kitchen.spec.ts", use: { ...chrome, baseURL: url(PORTS.kitchenDev, "") } },
  { name: "kitchen-prod", testMatch: "kitchen.spec.ts", use: { ...chrome, baseURL: url(PORTS.kitchenProd, "") } },
  { name: "shop-dev", testMatch: "shop.spec.ts", use: { ...chrome, baseURL: url(PORTS.shopDev, "") } },
  { name: "shop-prod", testMatch: "shop.spec.ts", use: { ...chrome, baseURL: url(PORTS.shopProd, "") } },
  { name: "hello-dev", testMatch: "hello.spec.ts", use: { ...chrome, baseURL: url(PORTS.helloDev, "") } },
  { name: "hello-prod", testMatch: "hello.spec.ts", use: { ...chrome, baseURL: url(PORTS.helloProd, "") } },
  { name: "tailwind-dev", testMatch: "tailwind.spec.ts", use: { ...chrome, baseURL: url(PORTS.tailwindDev, "") } },
  { name: "tailwind-prod", testMatch: "tailwind.spec.ts", use: { ...chrome, baseURL: url(PORTS.tailwindProd, "") } },
  { name: "runtime", testMatch: /runtime\/.*\.spec\.ts$/, use: { ...chrome, baseURL: url(PORTS.fixture, "") } },
  { name: "nojs", testMatch: "nojs.spec.ts", use: { ...chrome, javaScriptEnabled: false } },
  { name: "a11y", testMatch: "a11y.spec.ts", use: { ...chrome } },
];

/** Firefox and WebKit for one example's critical journeys (tests tagged @journey). */
const journeys = (browser: "firefox" | "webkit", device: string) =>
  (
    [
      ["todo", PORTS.todoProd],
      ["shop", PORTS.shopProd],
      ["kitchen", PORTS.kitchenProd],
    ] as const
  ).map(([example, port]) => ({
    name: `${browser}-${example}`,
    testMatch: `${example}.spec.ts`,
    grep: /@journey/,
    use: { ...devices[device], baseURL: url(port, "") },
  }));

/**
 * The rest of the matrix, on top of the default projects: `npm run e2e:all`
 * (and CI, sharded). The runtime fixture and the examples' critical journeys
 * in Firefox and WebKit, and phones (Chrome on a Pixel 7, WebKit as an iPhone 14).
 */
export const crossBrowser: NonNullable<PlaywrightTestConfig["projects"]> = [
  { name: "runtime-firefox", testMatch: /runtime\/.*\.spec\.ts$/, use: { ...devices["Desktop Firefox"], baseURL: url(PORTS.fixture, "") } },
  { name: "runtime-webkit", testMatch: /runtime\/.*\.spec\.ts$/, use: { ...devices["Desktop Safari"], baseURL: url(PORTS.fixture, "") } },
  ...journeys("firefox", "Desktop Firefox"),
  ...journeys("webkit", "Desktop Safari"),
  { name: "mobile-pixel7", testMatch: "mobile.spec.ts", use: { ...devices["Pixel 7"], channel: "chrome" } },
  { name: "mobile-iphone14", testMatch: "mobile.spec.ts", use: { ...devices["iPhone 14"] } },
];

/** Each example in dev (Vite) and as a production build, plus the runtime fixture. */
const servers: NonNullable<PlaywrightTestConfig["webServer"]> = [
  ...(
    [
      ["todo", PORTS.todoDev, PORTS.todoProd, "/about", { TODO_FILE: ":memory:" }],
      ["kitchen-sink", PORTS.kitchenDev, PORTS.kitchenProd, "/about", {}],
      ["shop", PORTS.shopDev, PORTS.shopProd, "/", {}],
      ["hello", PORTS.helloDev, PORTS.helloProd, "/", {}],
      ["tailwind", PORTS.tailwindDev, PORTS.tailwindProd, "/", {}],
    ] as const
  ).flatMap(([example, dev, prod, ready, env]) => [
    {
      // --port: hello's config pins 3000; the others read PORT.
      command: `npx vite --config examples/${example}/vite.config.ts --port ${dev}`,
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
