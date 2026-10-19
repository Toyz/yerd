/**
 * Where each server the e2e suite starts listens (see playwright.config.ts).
 * Specs that visit more than one server (mobile, no-JavaScript,
 * accessibility) use these; the others get theirs as baseURL.
 */
export const PORTS = {
  todoDev: 3200,
  todoProd: 3201,
  kitchenDev: 3202,
  kitchenProd: 3203,
  shopDev: 3204,
  shopProd: 3205,
  helloDev: 3206,
  helloProd: 3207,
  tailwindDev: 3208,
  tailwindProd: 3209,
  /** The runtime fixture (test/e2e/fixture). */
  fixture: 3210,
  /** A second fixture instance, which the recovery spec restarts and stops. */
  fixtureSpare: 3211,
  /** serve.ts's control server for the spare instance. */
  fixtureControl: 3212,
} as const;

export const url = (port: number, path = "/"): string => `http://localhost:${port}${path}`;

/** The production builds: what the cross-cutting specs check. */
export const TODO = url(PORTS.todoProd, "");
export const KITCHEN = url(PORTS.kitchenProd, "");
export const SHOP = url(PORTS.shopProd, "");
export const FIXTURE = url(PORTS.fixture, "");
