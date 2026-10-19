import { expect, type Page, type Request, type Route } from "@playwright/test";

/** Set a marker on window; if it survives, the page was never fully reloaded. */
export async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
}

export async function stillSamePage(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
}

/**
 * Start listening for the runtime's next yx:applied (fired once a response's
 * Regions are in); await the returned function to wait for it.
 */
export async function nextApplied(page: Page): Promise<() => Promise<unknown>> {
  await page.evaluate(() => {
    (window as unknown as { __applied: Promise<void> }).__applied = new Promise<void>((resolve) =>
      document.addEventListener("yx:applied", () => resolve(), { once: true }),
    );
  });
  return () => page.evaluate(() => (window as unknown as { __applied: Promise<void> }).__applied);
}

/**
 * Replace the page's timers with a paused fake clock (call before goto):
 * debounces and polls then fire only when the test runs the clock forward
 * (page.clock.runFor), however fast or slow the machine is.
 */
export async function pauseClock(page: Page): Promise<void> {
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1);
}

/** The runtime's own status message (#yx-notice). */
export const notice = (page: Page) => page.locator("#yx-notice");

/** An action post (the runtime's fetch, with the `yx` header). */
export const isAction = (request: Request): boolean => request.method() === "POST" && request.headers()["yx"] === "1";

/**
 * The method an action post calls: read from its signed token's payload
 * (base64url JSON before the dot), whose `a` names the action.
 */
export function actionName(request: Request): string | undefined {
  const token = new URLSearchParams(request.postData() ?? "").get("_yx");
  if (!token) return undefined;
  try {
    return (JSON.parse(Buffer.from(token.slice(0, token.indexOf(".")), "base64url").toString()) as { a?: string }).a;
  } catch {
    return undefined;
  }
}

/** A boosted navigation's page fetch (not a prefetch). */
export const isBoost = (request: Request): boolean =>
  request.method() === "GET" && request.headers()["yx-boost"] === "1" && request.headers()["yx-prefetch"] === undefined;

/** A unique id for the state a test keeps on the server (?t=..., cue rooms). */
export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Hold requests matching `pattern` until release() is called, to see what
 * the page does while they're in flight. Held requests then go on to the
 * server as they are; one the page has given up on meanwhile is dropped.
 */
export async function holdRequests(page: Page, pattern: string | RegExp, which: (request: Request) => boolean = () => true) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held: Request[] = [];
  const handler = async (route: Route) => {
    if (!which(route.request())) return route.fallback();
    held.push(route.request());
    await gate;
    // The page may have aborted it while it was held (a newer run of the same action).
    await route.continue().catch(() => {});
  };
  await page.route(pattern, handler);
  return {
    held,
    release: async () => {
      release();
      await page.unroute(pattern, handler);
    },
  };
}
