import { expect, test, type Page } from "@playwright/test";
import { KITCHEN, SHOP, TODO } from "./ports.js";

/**
 * Every example's critical flows with JavaScript off (the "nojs" project sets
 * javaScriptEnabled: false): plain form posts, redirects and server-rendered
 * errors, against the production builds.
 */

test("the runtime really is off: pages load, but nothing of it runs", async ({ page }) => {
  for (const origin of [TODO, SHOP, KITCHEN]) {
    await page.goto(`${origin}/login`);
    await expect(page.locator('script[src="/_yerd/runtime.js"]')).toHaveCount(1);
    expect(await page.evaluate(() => "yerd" in window)).toBe(false);
  }
});

/** Turn off the browser's own checks (required, min...) so the server's answer is what's tested. */
async function skipBrowserChecks(page: Page, formWith: string): Promise<void> {
  await page.locator("form", { has: page.locator(formWith) }).evaluate((form: HTMLFormElement) => (form.noValidate = true));
}

test.describe("todo", () => {
  let users = 0;
  const name = () => `nojs_${Date.now().toString(36)}_${users++}`;

  test("sign up with errors shown, then add, toggle, rename, filter and delete todos", async ({ page }) => {
    await page.goto(`${TODO}/signup`);
    const user = name();
    await page.getByLabel("Username").fill(user);
    await page.getByLabel(/^Password/).fill("short");
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole("alert")).not.toBeEmpty();

    await page.getByLabel("Username").fill(user);
    await page.getByLabel(/^Password/).fill("correct horse battery");
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/todos$/);

    // A blank todo: without the runtime, the thrown validation error renders the error page.
    await skipBrowserChecks(page, "#new-title");
    await page.getByLabel("What needs doing?").fill("   ");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".error-code")).toHaveText("400");
    await page.getByRole("link", { name: "Back to your todos" }).click();

    await page.getByLabel("What needs doing?").fill("Water the plants");
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByLabel("What needs doing?").fill("Fix the fence");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator(".todo-title")).toHaveText(["Water the plants", "Fix the fence"]);

    await page.getByRole("button", { name: 'Mark "Water the plants" as done' }).click();
    await expect(page.locator(".todo.done .todo-title")).toHaveText("Water the plants");

    const row = page.locator(".todo", { hasText: "Fix the fence" });
    await row.getByText("Rename").click();
    await row.getByLabel("New title").fill("Fix the gate");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".todo-title")).toHaveText(["Water the plants", "Fix the gate"]);

    await page.getByRole("link", { name: "Completed" }).click();
    await expect(page).toHaveURL(/filter=completed/);
    await expect(page.locator(".todo-title")).toHaveText(["Water the plants"]);
    await page.getByRole("link", { name: "All" }).click();

    await page.getByRole("button", { name: 'Delete "Fix the gate"' }).click();
    await expect(page.locator(".todo-title")).toHaveText(["Water the plants"]);

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("shop", () => {
  test("search, add to the cart, change the quantity and remove, all with page loads", async ({ page }) => {
    await page.goto(`${SHOP}/`);
    await page.getByRole("searchbox", { name: "Search" }).fill("pen");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/\?q=pen/);
    await expect(page.locator(".card a").first()).toBeVisible();

    await page.goto(`${SHOP}/products/1`);
    await page.getByRole("button", { name: "Add to cart" }).click();
    // A plain post is sent back to the page it came from.
    await expect(page).toHaveURL(/\/products\/1$/);
    await expect(page.locator("#cart-badge .badge")).toHaveText("1");

    await page.locator("#cart-badge").click();
    await expect(page).toHaveURL(/\/cart$/);
    const qty = page.locator(".lines input[name=qty]").first();
    await qty.fill("3");
    await page.getByRole("button", { name: "Update" }).click();
    await expect(page.locator("#cart-badge .badge")).toHaveText("3");

    await page.getByRole("button", { name: /^Remove / }).click();
    await expect(page.locator(".empty")).toContainText("Your cart is empty.");
  });

  test("a wrong password and checkout errors render on the page; a good order lands on its receipt", async ({ page }) => {
    await page.goto(`${SHOP}/products/4`);
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.goto(`${SHOP}/login?next=/checkout`);
    await page.getByLabel("Username").fill("ada");
    await page.getByLabel("Password").fill("wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).not.toBeEmpty();

    await page.getByLabel("Username").fill("ada");
    await page.getByLabel("Password").fill("analytical-engine");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/checkout$/);

    await skipBrowserChecks(page, "#email");
    await page.getByLabel("Name").fill("A");
    await page.getByLabel("Email").fill("nope");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.locator('[data-yx-error="name"]')).toHaveText("Must be 2 to 80 characters (got 1)");
    await expect(page.locator('[data-yx-error="email"]')).toHaveText("Expected an email address");
    await expect(page.getByLabel("Email")).toHaveValue("nope");

    await page.getByLabel("Name").fill("Ada Lovelace");
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Address").fill("12 St James's Square, London");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page).toHaveURL(/\/orders\/\d+$/);
    await expect(page.getByRole("heading", { name: /^Order \d+ is in$/ })).toBeVisible();
  });
});

test.describe("kitchen sink", () => {
  test("log in, add to the cart, check out with an error flashed above the form, then place the order", async ({ page }) => {
    await page.goto(`${KITCHEN}/login?next=%2F`);
    await page.getByLabel("Username").fill("cy");
    await page.getByLabel("Password").fill("rock-collector");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(`${KITCHEN}/`);

    await page.locator(".add-form button:enabled").first().click();
    await expect(page.locator("#cart-badge .badge")).toHaveText("1");

    await page.goto(`${KITCHEN}/cart`);
    await skipBrowserChecks(page, "#card");
    await page.getByLabel("Name").fill("Cy Rock");
    await page.getByLabel("Address").fill("1 Boulder Lane");
    await page.getByLabel("Card number").fill("not a card");
    await page.getByLabel("CVC").fill("123");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.locator(".form-error")).toHaveText("Card: That doesn't look like a card number");

    await page.getByLabel("Name").fill("Cy Rock");
    await page.getByLabel("Address").fill("1 Boulder Lane");
    await page.getByLabel("Card number").fill("4242 4242 4242 4242");
    await page.getByLabel("CVC").fill("123");
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
    await expect(page.locator(".notice")).toContainText("placed");
  });

  test("remove from the cart without the runtime", async ({ page }) => {
    await page.goto(`${KITCHEN}/`);
    await page.locator(".add-form button:enabled").first().click();
    await expect(page.locator("#cart-badge .badge")).toHaveText("1");
    await page.goto(`${KITCHEN}/cart`);
    await page.getByRole("button", { name: /^Remove / }).click();
    await expect(page.locator("#cart .empty")).toBeVisible();
    await expect(page.locator("#cart-badge .badge")).toHaveText("0");
  });
});
