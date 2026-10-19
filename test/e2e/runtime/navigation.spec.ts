import { expect, test, type Page } from "@playwright/test";
import { isBoost, markPage, stillSamePage } from "./helpers.js";

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
const served = async (page: Page) => Number((await page.locator("#served").textContent())?.match(/\d+/)?.[0]);

test("boosted links swap the page in place, and Back and Forward restore it and its scroll position", async ({ page }) => {
  await page.goto("/nav/one");
  await expect(page).toHaveTitle("Page one · fixture");
  await markPage(page);

  // Scroll well down, to a link that's then clicked where it is (a click doesn't scroll to a link in view).
  const fromTheBottom = page.getByRole("link", { name: "On to page two, from the bottom" });
  await fromTheBottom.scrollIntoViewIfNeeded();
  await expect.poll(() => scrollY(page)).toBeGreaterThan(1000);
  const scrolledTo = await scrollY(page);

  // The runtime fetches the page itself (on the press, as a prefetch the click then uses): no document load.
  const documents: string[] = [];
  const fetched: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
    if (request.headers()["yx-boost"] === "1") fetched.push(new URL(request.url()).pathname);
  });
  await fromTheBottom.click();
  await expect(page).toHaveURL(/\/nav\/two$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page two");
  await expect(page).toHaveTitle("Page two · fixture");
  // A new page starts at the top.
  await expect.poll(() => scrollY(page)).toBe(0);
  expect(fetched).toEqual(["/nav/two"]);
  expect(documents).toEqual([]);

  await page.goBack();
  await expect(page).toHaveURL(/\/nav\/one$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page one");
  await expect.poll(() => scrollY(page)).toBe(scrolledTo);

  await page.goForward();
  await expect(page).toHaveURL(/\/nav\/two$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page two");
  await stillSamePage(page);
});

test("a boosted link with a fragment scrolls to its target", async ({ page }) => {
  await page.goto("/nav/one");
  await markPage(page);
  await page.getByRole("link", { name: "To the target on page three" }).click();
  await expect(page).toHaveURL(/\/nav\/three#target$/);
  await expect(page.getByRole("heading", { name: "Target" })).toBeInViewport();
  await stillSamePage(page);
});

test('data-yx-boost="false" opts a link out: it loads the page the ordinary way', async ({ page }) => {
  await page.goto("/nav/one");
  await markPage(page);
  const load = page.waitForEvent("load");
  await page.getByRole("link", { name: "Page two, without boosting" }).click();
  await load;
  await expect(page).toHaveURL(/\/nav\/two$/);
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBeUndefined();
});

test("a page restored from the back/forward cache is fetched fresh", async ({ page }) => {
  await page.goto("/nav/one");
  const before = await served(page);
  await markPage(page);
  // Playwright's Chromium runs with the back/forward cache off, and the other
  // browsers don't promise to use it, so stand in for the browser: the event
  // a bfcache restore fires is all the runtime reacts to.
  const refetch = page.waitForRequest((request) => isBoost(request) && new URL(request.url()).pathname === "/nav/one");
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await refetch;
  await expect(page.locator("#served")).toHaveText(`Served ${before + 1}`);
  await stillSamePage(page);
});
