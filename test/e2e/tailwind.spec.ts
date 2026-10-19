import { expect, test, type Locator, type Page } from "@playwright/test";

// examples/tailwind: Tailwind through the Vite plugin, and one counter
// component kept in four places (shared, session, tab, browser).

/** A counter's card, by its section heading and label. */
function counter(page: Page, section: string, label: string): Locator {
  return page
    .locator("section", { has: page.getByRole("heading", { name: section }) })
    .locator("div", { has: page.getByText(label, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "+1" }) })
    .last();
}

test("Tailwind's styles are built and applied", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Tailwind in yerd");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tailwind, yerd style");
  // bg-stone-100 on <body>: not the browser's white. grid on the sections.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toMatch(/^rgba?\(255, 255, 255/);
  expect(await page.locator("section .grid").first().evaluate((el) => getComputedStyle(el).display)).toBe("grid");
});

test("a shared counter goes up for everyone; a session counter only for this visitor", async ({ page, browser, baseURL }) => {
  await page.goto("/");
  const shared = counter(page, "Shared", "Coffees");
  const before = Number(await shared.locator("[data-yx-region]").textContent());
  await shared.getByRole("button", { name: "+1" }).click();
  await expect(shared.locator("[data-yx-region]")).toHaveText(String(before + 1));

  const mine = counter(page, "Yours", "Bugs fixed");
  // The first bump starts the session; the runtime rebinds the page's tokens after it.
  const rebound = page.waitForResponse((response) => response.request().headers()["yx-boost"] === "1");
  await mine.getByRole("button", { name: "+1" }).click();
  await expect(mine.locator("[data-yx-region]")).toHaveText("1");
  await rebound;
  await mine.getByRole("button", { name: "+1" }).click();
  await expect(mine.locator("[data-yx-region]")).toHaveText("2");
  await page.reload();
  await expect(counter(page, "Yours", "Bugs fixed").locator("[data-yx-region]")).toHaveText("2");

  // Another visitor: the shared count, but no session count of their own.
  const other = await (await browser.newContext({ baseURL })).newPage();
  await other.goto("/");
  await expect(counter(other, "Shared", "Coffees").locator("[data-yx-region]")).toHaveText(String(before + 1));
  await expect(counter(other, "Yours", "Bugs fixed").locator("[data-yx-region]")).toHaveText("0");
  await other.context().close();
});

test("tab counters are local state, and browser counters survive a reload", async ({ page }) => {
  await page.goto("/");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  const tab = counter(page, "This tab", "Deploys");
  await tab.getByRole("button", { name: "+1" }).click();
  await tab.getByRole("button", { name: "+1" }).click();
  await expect(tab.locator("[data-yx-text]")).toHaveText("2");

  const kept = counter(page, "This browser", "Yerds");
  await kept.getByRole("button", { name: "+1" }).click();
  await expect(kept.locator("[data-yx-text]")).toHaveText("1");
  expect(posts).toHaveLength(0);

  await page.reload();
  await expect(counter(page, "This tab", "Deploys").locator("[data-yx-text]")).toHaveText("0");
  await expect(counter(page, "This browser", "Yerds").locator("[data-yx-text]")).toHaveText("1");
});
