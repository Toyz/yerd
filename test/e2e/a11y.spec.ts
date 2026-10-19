import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { FIXTURE, KITCHEN, PORTS, SHOP, TODO, url } from "./ports.js";

/**
 * Accessibility smoke checks with axe on each example's main pages and the
 * runtime fixture: WCAG 2.x A and AA rules, failing on serious and critical
 * violations (minor and moderate ones are left to review).
 */

/**
 * Let the page settle before it's judged: deferred parts filled in, and
 * one-off animations done (an element a morph inserts fades in from
 * transparent, which would read as low contrast halfway through).
 */
async function settle(page: Page): Promise<void> {
  await expect(page.locator("[data-yx-defer]")).toHaveCount(0);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** The serious and critical violations on the page as it is now, in a form that reads well in a failure. */
async function seriousViolations(page: Page): Promise<string[]> {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .flatMap((violation) => violation.nodes.map((node) => `${violation.id} (${violation.impact}): ${violation.help} at ${node.target.join(" ")}`));
}

async function check(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} loads`).toBe(true);
  expect(await seriousViolations(page), path).toEqual([]);
}

test("todo: the about, login, signup, list and detail pages", async ({ page }) => {
  for (const path of ["/about", "/login", "/signup"]) await check(page, `${TODO}${path}`);

  await page.goto(`${TODO}/signup`);
  await page.getByLabel("Username").fill(`a11y_${Date.now().toString(36)}`);
  await page.getByLabel(/^Password/).fill("correct horse battery");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/todos$/);
  await page.getByLabel("What needs doing?").fill("Check the contrast");
  await page.getByLabel("What needs doing?").press("Enter");
  await expect(page.locator(".todo-title")).toHaveText(["Check the contrast"]);
  expect(await seriousViolations(page), "/todos").toEqual([]);

  await page.locator(".todo-title").click();
  await expect(page.getByLabel("Notes")).toBeVisible();
  expect(await seriousViolations(page), "a todo's page").toEqual([]);
});

test("shop: the catalog, a product, the cart, sign-in and checkout", async ({ page }) => {
  for (const path of ["/", "/products/2", "/login"]) await check(page, `${SHOP}${path}`);

  await page.goto(`${SHOP}/products/2`);
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await check(page, `${SHOP}/cart`);

  await page.goto(`${SHOP}/login?next=/checkout`);
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Password").fill("analytical-engine");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  expect(await seriousViolations(page), "/checkout").toEqual([]);
});

test("kitchen sink: the shop, a product, the cart, chat, the feature tour and the about page", async ({ page }) => {
  for (const path of ["/", "/products/disco-gnome", "/cart", "/chat", "/features", "/about", "/login"]) await check(page, `${KITCHEN}${path}`);
});

test("hello and tailwind: their pages", async ({ page }) => {
  for (const path of ["/", "/users/7"]) await check(page, url(PORTS.helloProd, path));
  await check(page, url(PORTS.tailwindProd, "/"));
});

test("the runtime fixture's pages", async ({ page }) => {
  for (const path of ["/", "/morph", "/nav/one", "/triggers", "/regions", "/forms", "/local", "/dnd", "/islands", "/lazy", "/session"]) {
    await check(page, `${FIXTURE}${path}`);
  }
});
