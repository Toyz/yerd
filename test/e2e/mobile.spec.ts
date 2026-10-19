import { expect, test, type Locator, type Page } from "@playwright/test";
import { KITCHEN, PORTS, SHOP, TODO, url } from "./ports.js";

/**
 * Phones (the mobile-* projects: a Pixel 7 in Chrome and an iPhone 14 in
 * WebKit, both with touch): the examples' main journeys by tapping, the
 * runtime driven by touch, and every key page fitting the screen's width.
 */

/** Nothing wider than the viewport: no sideways scrolling. */
async function fitsTheScreen(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `${page.url()} scrolls sideways`).toBeLessThanOrEqual(0);
}

/** WCAG 2.2's minimum target size: 24 by 24 CSS pixels. */
async function bigEnoughToTap(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box, "the target is on screen").not.toBeNull();
  expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(24);
}

async function markPage(page: Page): Promise<void> {
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
}
async function stillSamePage(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
}

test("shop: browse, add to the cart, change the quantity and remove, by tapping", async ({ page }) => {
  await page.goto(`${SHOP}/`);
  await fitsTheScreen(page);
  await page.locator(".card a", { hasText: "Gel pens, 3 pack" }).tap();
  await expect(page).toHaveTitle("Gel pens, 3 pack · Paperyard");
  await fitsTheScreen(page);

  const add = page.getByRole("button", { name: "Add to cart" });
  await bigEnoughToTap(add);
  await markPage(page);
  await add.tap();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await stillSamePage(page);

  await page.locator("#cart-badge").tap();
  await expect(page).toHaveTitle("Your cart · Paperyard");
  await fitsTheScreen(page);
  await markPage(page);
  await page.getByLabel("Quantity of Gel pens, 3 pack").fill("2");
  await page.getByRole("button", { name: "Update" }).tap();
  await expect(page.locator("#cart-badge .badge")).toHaveText("2");

  const remove = page.getByRole("button", { name: "Remove Gel pens, 3 pack" });
  await bigEnoughToTap(remove);
  await remove.tap();
  await expect(page.locator(".empty")).toContainText("Your cart is empty.");
  await stillSamePage(page);
});

test("shop: sign in and check out on a phone", async ({ page }) => {
  await page.goto(`${SHOP}/products/6`);
  await page.getByRole("button", { name: "Add to cart" }).tap();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await page.goto(`${SHOP}/login?next=/checkout`);
  await fitsTheScreen(page);
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Password").fill("analytical-engine");
  await page.getByRole("button", { name: "Sign in" }).tap();
  await expect(page).toHaveURL(/\/checkout$/);
  await fitsTheScreen(page);
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Address").fill("12 St James's Square, London");
  await page.getByRole("button", { name: "Place order" }).tap();
  await expect(page.getByRole("heading", { name: /^Order \d+ is in$/ })).toBeVisible();
  await fitsTheScreen(page);
});

test("kitchen sink: a touch prefetches a product link, and the tap swaps the page in without a reload", async ({ page }) => {
  await page.goto(`${KITCHEN}/`);
  await fitsTheScreen(page);
  // The made-up crowd buys things out: take a product that's still in stock.
  const link = page.locator(".product", { has: page.locator(".add-form button:enabled") }).first().locator(".product-link");
  const name = (await link.locator(".product-name").textContent())!.trim();
  await markPage(page);
  // touchstart warms the page (the prefetch prop's "intent", and the press itself).
  const prefetched = page.waitForRequest((request) => request.headers()["yx-prefetch"] === "1");
  await link.tap();
  await prefetched;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await stillSamePage(page);
  await fitsTheScreen(page);

  const add = page.getByRole("button", { name: "Add to cart" });
  await bigEnoughToTap(add);
  await add.tap();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await page.goto(`${KITCHEN}/cart`);
  await fitsTheScreen(page);
});

test("todo: sign up, add and complete a todo by tapping", async ({ page }) => {
  await page.goto(`${TODO}/signup`);
  await fitsTheScreen(page);
  await page.getByLabel("Username").fill(`phone_${Date.now().toString(36)}`);
  await page.getByLabel(/^Password/).fill("correct horse battery");
  await page.getByRole("button", { name: "Sign up" }).tap();
  await expect(page).toHaveURL(/\/todos$/);

  await page.getByLabel("What needs doing?").fill("A todo with a title long enough to wrap across a phone's narrow screen");
  await page.getByRole("button", { name: "Add", exact: true }).tap();
  await expect(page.locator(".todo-title")).toHaveCount(1);
  const toggle = page.getByRole("button", { name: /^Mark ".+" as done$/ });
  await bigEnoughToTap(toggle);
  await toggle.tap();
  await expect(page.locator(".todo.done")).toHaveCount(1);
  await fitsTheScreen(page);
});

test("the examples' other key pages fit a phone's width", async ({ page }) => {
  const pages = [
    `${TODO}/about`,
    `${TODO}/login`,
    `${KITCHEN}/about`,
    `${KITCHEN}/features`,
    `${KITCHEN}/chat`,
    url(PORTS.helloProd, "/"),
    url(PORTS.helloProd, "/users/7"),
    url(PORTS.tailwindProd, "/"),
  ];
  for (const path of pages) {
    await page.goto(path);
    await fitsTheScreen(page);
  }
});
