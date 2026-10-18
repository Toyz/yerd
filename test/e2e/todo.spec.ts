import { expect, test, type Page } from "@playwright/test";

let users = 0;

/** Sign up a fresh user (so every test has its own empty list) and land on /todos. */
async function signUp(page: Page, name = `user_${Date.now().toString(36)}_${users++}`) {
  await page.goto("/signup");
  await page.getByLabel("Username").fill(name);
  await page.getByLabel(/^Password/).fill("correct horse battery");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/todos$/);
  return name;
}

/** Set a marker on window; if it survives, the page was never fully reloaded. */
async function markPage(page: Page) {
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
}
async function stillSamePage(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
}

async function addTodo(page: Page, title: string) {
  await page.getByLabel("What needs doing?").fill(title);
  await page.getByLabel("What needs doing?").press("Enter");
  await expect(page.locator(".todo-title", { hasText: title })).toBeVisible();
}

test.beforeEach(async ({ page }, info) => {
  // The auth tests sign in their own way.
  if (!info.title.startsWith("auth:")) await signUp(page);
});

test("adds, toggles and filters without reloading the page", async ({ page }) => {
  await page.goto("/todos");
  await expect(page).toHaveTitle("Todos · yerd todos");
  await markPage(page);

  await addTodo(page, "Buy milk");
  await addTodo(page, "Walk the dog");
  const input = page.getByLabel("What needs doing?");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(page.locator("#todo-count")).toHaveText("2 left");

  await page.getByRole("button", { name: 'Mark "Buy milk" as done' }).click();
  await expect(page.locator(".todo.done .todo-title")).toHaveText("Buy milk");
  await expect(page.locator("#todo-count")).toHaveText("1 left");

  await page.getByRole("link", { name: "Active" }).click();
  await expect(page).toHaveURL(/filter=active/);
  await expect(page.locator(".todo-title")).toHaveText(["Walk the dog"]);
  await expect(page).toHaveTitle("Active todos · yerd todos");

  await page.getByRole("link", { name: "Completed" }).click();
  await expect(page.locator(".todo-title")).toHaveText(["Buy milk"]);

  await page.goBack();
  await expect(page.locator(".todo-title")).toHaveText(["Walk the dog"]);
  await stillSamePage(page);
});

test("renames inline and deletes", async ({ page }) => {
  await page.goto("/todos");
  await addTodo(page, "Typo tittle");
  await markPage(page);

  const row = page.locator(".todo", { hasText: "Typo tittle" });
  await row.getByText("Rename").click();
  const field = row.getByLabel("New title");
  await field.fill("Fixed title");
  await field.press("Enter");
  await expect(page.locator(".todo-title")).toHaveText(["Fixed title"]);
  await expect(page.locator("details.edit[open]")).toHaveCount(0);

  await page.getByRole("button", { name: 'Delete "Fixed title"' }).click();
  await expect(page.locator(".empty")).toContainText("No todos yet");
  await stillSamePage(page);
});

test("shows server validation errors next to the form", async ({ page }) => {
  await page.goto("/todos");
  await page.getByLabel("What needs doing?").fill("    ");
  await page.getByLabel("What needs doing?").press("Enter");
  await expect(page.getByRole("alert").first()).toHaveText("Expected a length from 1 to 140, got 0");
  await expect(page.locator(".todo")).toHaveCount(0);
});

test("completes all, then clears completed after confirming", async ({ page }) => {
  await page.goto("/todos");
  await addTodo(page, "One");
  await addTodo(page, "Two");
  await page.getByRole("button", { name: "Complete all" }).click();
  await expect(page.locator(".todo.done")).toHaveCount(2);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear completed" }).click();
  await expect(page.locator(".todo")).toHaveCount(0);
});

test("keeps the same user's other tabs in sync over SSE", async ({ page, context }) => {
  await page.goto("/todos");
  const other = await context.newPage();
  await other.goto("/todos");
  await markPage(other);
  // Let the second tab's EventSource connect.
  await other.waitForTimeout(300);

  await addTodo(page, "Seen everywhere");
  await expect(other.locator(".todo-title")).toHaveText(["Seen everywhere"]);
  await expect(other.locator("#todo-count")).toHaveText("1 left");
  await stillSamePage(other);
});

test("edits on the detail page (nested group layouts) and redirects back", async ({ page }) => {
  await page.goto("/todos");
  await addTodo(page, "Plan trip");
  await page.getByRole("link", { name: "Plan trip" }).click();
  await expect(page).toHaveTitle("Plan trip · yerd todos");
  await expect(page.locator(".shell .card-wrap .panel.card h1")).toHaveText("Plan trip");

  await page.getByLabel("Notes").fill("Book the train first");
  await page.getByLabel("Done").check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/\/todos$/);
  await expect(page.locator(".todo.done .todo-title")).toHaveText("Plan trip");
  await expect(page.locator(".todo-notes")).toHaveText("Book the train first");
});

test("works with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signUp(page);
  await page.getByLabel("What needs doing?").fill("No JS needed");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".todo-title")).toHaveText(["No JS needed"]);
  await page.getByRole("button", { name: 'Mark "No JS needed" as done' }).click();
  await expect(page.locator(".todo.done")).toHaveCount(1);
  await page.getByRole("link", { name: "Active" }).click();
  await expect(page).toHaveURL(/filter=active/);
  await expect(page.locator(".empty")).toContainText("All caught up");
  await context.close();
});

test("renders the about page on its own layout and errors in the root layout", async ({ page }) => {
  await page.goto("/about");
  await expect(page.locator(".marketing .hero h1")).toContainText("Todos, yerd style.");
  await expect(page.locator(".topbar")).toHaveCount(0);

  const response = await page.goto("/nope");
  expect(response?.status()).toBe(404);
  await expect(page.locator(".error-code")).toHaveText("404");
  await expect(page).toHaveTitle("Not Found · yerd todos");
});

test("fits a phone screen without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.goto("/todos");
  await addTodo(page, "A rather long todo title that has to wrap nicely on a small phone screen");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("auth: signed-out visitors are sent to login and come back to where they were going", async ({ page }) => {
  const name = await signUp(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto("/todos?filter=completed");
  await expect(page).toHaveURL(/\/login\?next=%2Ftodos%3Ffilter%3Dcompleted/);
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/todos\?filter=completed$/);
  await expect(page.locator(".who")).toHaveText(`@${name}`);
});

test("auth: users only see their own todos", async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage();
  const bob = await (await browser.newContext()).newPage();
  await signUp(alice);
  await signUp(bob);
  await addTodo(alice, "Alice's secret");
  await bob.reload();
  await expect(bob.locator(".empty")).toContainText("No todos yet");
  // And not through the API either.
  const id = await alice.locator(".todo-title").getAttribute("href");
  expect((await bob.goto(id!))?.status()).toBe(404);
});

test("auth: wrong passwords and bad signups show errors and keep the username", async ({ page }) => {
  const name = await signUp(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password").fill("nope nope nope");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong username or password.");
  await expect(page.getByLabel("Username")).toHaveValue(name);

  await page.goto("/signup");
  await page.getByLabel("Username").fill(name);
  await page.getByLabel(/^Password/).fill("long enough pw");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("alert")).toHaveText("That username is taken.");
  await page.getByLabel(/^Password/).fill("short");
  await page.getByLabel("Username").fill("fresh_name");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/signup$/);
});

test("auth: login works with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const name = await signUp(page);
  await page.getByRole("button", { name: "Log out" }).click();
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/todos$/);
  await context.close();
});

test("prerendered /about ships a skeleton and fills in who's signed in", async ({ page }, info) => {
  const name = await signUp(page);
  await addTodo(page, "One thing");
  if (info.project.name === "prod") {
    // The static file from the build: skeleton, no user.
    const file = await (await page.request.get("/about")).text();
    expect(file).toContain('data-yx-defer');
    expect(file).not.toContain(name);
  }
  await page.goto("/about");
  await expect(page.locator("#account-cta .who")).toHaveText(`@${name}`);
  await expect(page.locator("#account-cta")).toContainText("Your todos · 1 left");
  await expect(page.locator("[data-yx-defer]")).toHaveCount(0);
});

test("auth: prerendered /about shows log in / sign up to visitors", async ({ page }) => {
  await page.goto("/about");
  await expect(page.locator("#account-cta")).toContainText("Log in");
  await expect(page.locator("#account-cta")).toContainText("Sign up");
});

test("auth: prerendered /about without JavaScript shows the noscript link instead of a skeleton", async ({ browser }, info) => {
  test.skip(info.project.name !== "prod", "only the production build is prerendered");
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/about");
  await expect(page.locator(".skeleton")).toBeHidden();
  await expect(page.getByRole("link", { name: "Open the app" })).toBeVisible();
  await context.close();
});

test("going Back to the prerendered /about by boosted navigation fills its account area again", async ({ page }) => {
  await page.goto("/about");
  await expect(page.locator("#account-cta .who")).toBeVisible();
  await markPage(page);
  await page.locator(".marketing header .brand").click();
  await expect(page).toHaveURL(/\/todos$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.locator("#account-cta .who")).toBeVisible();
  await expect(page.locator("[data-yx-defer]")).toHaveCount(0);
  await stillSamePage(page);
});

test("prefetches a boosted link on hover, so the click needs no request", async ({ page }) => {
  await addTodo(page, "Prefetch me");
  const link = page.locator(".todo-title", { hasText: "Prefetch me" });
  const prefetch = page.waitForRequest((r) => r.headers()["yx-prefetch"] === "1");
  await link.hover();
  const request = await prefetch;
  expect(new URL(request.url()).pathname).toMatch(/^\/todos\/[\w-]+$/);
  let navigations = 0;
  page.on("request", (r) => {
    if (r.headers()["yx-boost"] === "1" && r.headers()["yx-prefetch"] === undefined) navigations++;
  });
  await markPage(page);
  await link.click();
  await expect(page).toHaveURL(/\/todos\/[\w-]+$/);
  await stillSamePage(page);
  expect(navigations).toBe(0);
});

test("auth: auto mode boosts plain links without any attributes", async ({ page }) => {
  await page.goto("/login");
  await markPage(page);
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await stillSamePage(page);
});

test("auth: auto mode prefetches the link the pointer is heading for, before it gets there", async ({ page }) => {
  await page.goto("/login");
  const link = page.getByRole("link", { name: "Create an account" });
  const box = (await link.boundingBox())!;
  const y = box.y + box.height / 2;
  const prefetched = page.waitForRequest((r) => r.headers()["yx-prefetch"] === "1", { timeout: 3000 });
  // Glide toward the link from the left, slowing down like a hand aiming,
  // and stop well short of it.
  let x = Math.max(5, box.x - 260);
  await page.mouse.move(x, y);
  for (const step of [40, 34, 28, 22, 17, 13, 10, 8, 6]) {
    x += step;
    await page.mouse.move(x, y);
    await page.waitForTimeout(16);
  }
  expect(x).toBeLessThan(box.x - 40);
  const request = await prefetched;
  expect(new URL(request.url()).pathname).toBe("/signup");
});
