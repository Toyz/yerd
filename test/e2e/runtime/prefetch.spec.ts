import { expect, test, type Page, type Request } from "@playwright/test";
import { isAction, markPage, stillSamePage } from "./helpers.js";

const toTarget = (via: string) => (request: Request) => {
  const url = new URL(request.url());
  return url.pathname === "/prefetch/target" && url.searchParams.get("via") === via;
};
const isPrefetch = (request: Request) => request.headers()["yx-prefetch"] === "1";

/** Every request for the target page, from now on. */
function watchTarget(page: Page, via: string) {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (toTarget(via)(request)) seen.push(request);
  });
  return {
    prefetches: () => seen.filter(isPrefetch).length,
    navigations: () => seen.filter((request) => !isPrefetch(request)).length,
  };
}

test("intent: hovering a link prefetches it, and the click is answered from the cache", async ({ page }) => {
  await page.goto("/prefetch");
  const target = watchTarget(page, "intent");
  const link = page.getByRole("link", { name: "Prefetched on intent" });
  const prefetched = page.waitForResponse((response) => toTarget("intent")(response.request()) && isPrefetch(response.request()));
  await link.hover();
  await prefetched;
  await markPage(page);

  await link.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Target via intent");
  await expect(page).toHaveURL(/via=intent$/);
  expect(target.navigations()).toBe(0);
  expect(target.prefetches()).toBe(1);
  await stillSamePage(page);
});

test("visible: a link is prefetched once it scrolls into view, not before", async ({ page }) => {
  const target = watchTarget(page, "visible");
  const loadPrefetched = page.waitForResponse((response) => toTarget("load")(response.request()));
  await page.goto("/prefetch");
  // The load prefetch shows the page's prefetching is under way; the visible link is far below.
  await loadPrefetched;
  expect(target.prefetches()).toBe(0);

  const link = page.getByRole("link", { name: "Prefetched when visible" });
  const prefetched = page.waitForResponse((response) => toTarget("visible")(response.request()) && isPrefetch(response.request()));
  await link.scrollIntoViewIfNeeded();
  await prefetched;

  await link.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Target via visible");
  expect(target.navigations()).toBe(0);
});

test("load: prefetched right away, and an action empties the cache so the click gets a fresh page", async ({ page }) => {
  const prefetched = page.waitForResponse((response) => toTarget("load")(response.request()) && isPrefetch(response.request()));
  await page.goto("/prefetch");
  // The prefetched copy says which render of the target it is.
  const warmed = Number((await (await prefetched).text()).match(/Served (\d+)/)?.[1]);
  expect(warmed).toBeGreaterThan(0);

  // Anything warmed before an action may be out of date after it.
  const action = page.waitForResponse((response) => isAction(response.request()));
  await page.getByRole("button", { name: "Change something" }).click();
  await action;
  await expect(page.locator("#changed")).toHaveText("Changed");

  await page.getByRole("link", { name: "Prefetched on load" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Target via load");
  const shown = Number((await page.locator("#served").textContent())?.match(/\d+/)?.[0]);
  expect(shown).toBeGreaterThan(warmed);
});
