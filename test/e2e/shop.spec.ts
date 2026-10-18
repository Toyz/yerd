import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The shop's inputs carry browser checks (type="email", min, max), which stop
 * a bad submit before it leaves the page. These tests are about the server's
 * answer, so they turn those checks off on the field's form.
 */
async function skipBrowserChecks(field: Locator): Promise<void> {
  await field.evaluate((el) => ((el as HTMLInputElement).form!.noValidate = true));
}

/** Set a marker on window; if it survives, the page was never fully reloaded. */
async function markPage(page: Page) {
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
}
async function stillSamePage(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
}

async function signIn(page: Page) {
  await page.getByLabel("Username").fill("ada");
  await page.getByLabel("Password").fill("analytical-engine");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("searches and filters the catalog", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Shop · Paperyard");
  await expect(page.locator(".card")).toHaveCount(8);

  await page.getByRole("searchbox", { name: "Search" }).fill("notebook");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\?q=notebook/);
  await expect(page.locator(".card a")).toHaveText(["Pocket notebook", "Field notebook"]);

  await page.getByRole("link", { name: "desk", exact: true }).click();
  await expect(page.locator(".card a")).toHaveText(["Desk lamp", "Brass ruler"]);
  await expect(page.getByRole("link", { name: "desk", exact: true })).toHaveAttribute("aria-current", "page");

  await page.getByRole("searchbox", { name: "Search" }).fill("zebra");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.locator(".empty")).toHaveText('Nothing matches "zebra".');
});

test("an unknown product is a 404 page inside the layout", async ({ page }) => {
  const res = await page.goto("/products/99");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not on the shelves" })).toBeVisible();
  await expect(page.locator("#cart-badge")).toBeVisible();
});

test("adds to the cart, changes the quantity and removes it, without reloading", async ({ page }) => {
  await page.goto("/products/2");
  await markPage(page);
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await stillSamePage(page);

  await page.locator("#cart-badge").click();
  await expect(page).toHaveTitle("Your cart · Paperyard");
  await markPage(page);
  const qty = page.getByLabel("Quantity of Gel pens, 3 pack");
  await qty.fill("4");
  await qty.press("Enter");
  await expect(page.locator(".total")).toHaveText("Total $30.00");
  await expect(page.locator("#cart-badge .badge")).toHaveText("4");

  // The browser would stop -2 itself (min="0"); switch that off to see the server's answer.
  await skipBrowserChecks(qty);
  await qty.fill("-2");
  await qty.press("Enter");
  await expect(page.locator('[data-yx-error="qty"]')).toContainText("Must be from 0 to 99");

  await page.getByRole("button", { name: "Remove Gel pens, 3 pack" }).click();
  await expect(page.locator(".empty")).toContainText("Your cart is empty.");
  await expect(page.locator("#cart-badge .badge")).toHaveText("0");
  await stillSamePage(page);
});

test("a sold-out product can't be added", async ({ page }) => {
  await page.goto("/products/8");
  await expect(page.locator("#stock")).toHaveText("Sold out");
  await expect(page.getByRole("button", { name: "Add to cart" })).toBeDisabled();
});

test("product pages list what this browser looked at before", async ({ page }) => {
  await page.goto("/products/2");
  // The island mounts when the browser is idle; wait for it to remember this page.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("paperyard:recent"))).toContain('"id":2');
  await expect(page.locator(".recent")).toBeEmpty();

  await page.goto("/products/5");
  await expect(page.locator(".recent h2")).toHaveText("Recently viewed");
  await expect(page.locator(".recent a")).toHaveText(["Gel pens, 3 pack"]);
  await page.locator(".recent a").click();
  await expect(page).toHaveTitle("Gel pens, 3 pack · Paperyard");
  await expect(page.locator(".recent a")).toHaveText(["Brass ruler"]);
});

test("checks out behind a sign-in that keeps the cart, with errors under their fields", async ({ page }) => {
  await page.goto("/products/6");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");

  await page.goto("/cart");
  await page.getByRole("link", { name: "Check out" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fcheckout$/);
  await signIn(page);

  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.locator(".summary")).toContainText("1 x Pocket notebook");
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");

  await skipBrowserChecks(page.getByLabel("Name"));
  await page.getByLabel("Name").fill("A");
  await page.getByLabel("Email").fill("nope");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator('[data-yx-error="name"]')).toHaveText("Must be 2 to 80 characters (got 1)");
  await expect(page.locator('[data-yx-error="email"]')).toHaveText("Expected an email address");
  await expect(page.locator('[data-yx-error="address"]')).toHaveText("Can't be empty");
  await expect(page.getByLabel("Name")).toHaveAttribute("aria-invalid", "true");

  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Address").fill("12 St James's Square, London");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/orders\/\d+$/);
  await expect(page.getByRole("heading", { name: /^Order \d+ is in$/ })).toBeVisible();
  await expect(page.locator("#cart-badge .badge")).toHaveText("0");
});

test("checkout errors work without JavaScript too", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/products/3");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await page.goto("/login?next=/checkout");
  await signIn(page);
  await expect(page).toHaveURL(/\/checkout$/);

  await skipBrowserChecks(page.getByLabel("Email"));
  await page.getByLabel("Email").fill("nope");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator('[data-yx-error="email"]')).toHaveText("Expected an email address");
  await expect(page.getByLabel("Email")).toHaveValue("nope");
  await context.close();
});

test("stock updates live on every open product page", async ({ page, browser }) => {
  // A second visitor watches the brass ruler.
  const watcher = await (await browser.newContext()).newPage();
  await watcher.goto("/products/5");
  const before = Number((await watcher.locator("#stock").textContent())?.match(/\d+/)?.[0]);
  await markPage(watcher);
  await watcher.waitForTimeout(300); // let the EventSource connect

  await page.goto("/products/5");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await page.goto("/login?next=/checkout");
  await signIn(page);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Address").fill("12 St James's Square, London");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/orders\/\d+$/);

  await expect(watcher.locator("#stock")).toHaveText(`${before - 1} in stock`);
  await stillSamePage(watcher);
});

test("the JSON API", async ({ request }) => {
  const list = await request.get("/api/products?category=pens");
  expect(list.headers()["content-type"]).toBe("application/json; charset=utf-8");
  expect(((await list.json()) as Array<{ name: string }>).map((p) => p.name)).toEqual(["Fountain pen", "Gel pens, 3 pack", "Mechanical pencil"]);

  const missing = await request.get("/api/products/99");
  expect(missing.status()).toBe(404);
  expect(await missing.json()).toEqual({ error: "No product 99", code: "not_found", id: 99 });
});
