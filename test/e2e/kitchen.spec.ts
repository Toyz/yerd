import { expect, test, type Page } from "@playwright/test";

/** Log in through the form (the demo accounts are seeded at boot). */
async function logIn(page: Page, name: string, password: string, next = "/") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Username").fill(name);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
}

const ada = (page: Page, next = "/admin") => logIn(page, "ada", "gnome-overlord", next);
const cy = (page: Page, next = "/") => logIn(page, "cy", "rock-collector", next);

/** Set a marker on window; if it survives, the page was never fully reloaded. */
async function markPage(page: Page) {
  await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
}
async function stillSamePage(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
}

/** A tiny SVG file, built in the page, for drop events. */
const svgFiles = (page: Page, names: string[]) =>
  page.evaluateHandle((names) => {
    const transfer = new DataTransfer();
    for (const name of names) {
      transfer.items.add(new File([`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="red"/></svg>`], name, { type: "image/svg+xml" }));
    }
    return transfer;
  }, names);

test("typeahead and the category select narrow the shelf in place", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Shop · Yerd Bazaar");
  await expect(page.locator(".product")).toHaveCount(12);
  await markPage(page);

  await page.locator("#q").fill("googly");
  await expect(page.locator("#result-count")).toHaveText('1 item matching "googly"');
  await expect(page.locator(".product-name")).toHaveText(["Rock With Googly Eyes"]);
  await expect(page.locator("#more")).toContainText("whole shelf");

  // The select reads the search box with ref("#q"): clear it first, then pick an aisle.
  await page.locator("#q").fill("");
  await expect(page.locator(".product")).toHaveCount(12);
  await page.locator("#category").selectOption("signs");
  await expect(page.locator("#result-count")).toHaveText("12 items");
  await expect(page.locator(".product-name").first()).toHaveText("Beware of the Gnome");
  await stillSamePage(page);
});

test("infinite scroll appends the next page when the sentinel shows up", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".product")).toHaveCount(12);
  await page.locator("#more").scrollIntoViewIfNeeded();
  await expect(page.locator(".product")).toHaveCount(24);
  await page.locator("#more").scrollIntoViewIfNeeded();
  await expect(page.locator(".product")).toHaveCount(36);
  await expect(page.locator(".product-name").nth(12)).toHaveText("Classic Pink Flamingo");
});

test("adds to the cart and changes the quantity", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#cart-badge .badge")).toHaveText("0");
  const first = page.locator(".product").first();
  const name = await first.locator(".product-name").textContent();
  await first.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await expect(page.locator("#toast")).toContainText("is in your cart");

  await page.locator("#cart-badge").click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.locator(".cart-name")).toHaveText([name!]);
  await markPage(page);
  const qty = page.getByLabel(`Quantity of ${name}`);
  await qty.fill("3");
  await qty.press("Tab");
  await expect(page.locator("#cart-badge .badge")).toHaveText("3");
  await page.getByRole("button", { name: `Remove ${name}` }).click();
  await expect(page.locator("#cart .empty")).toBeVisible();
  await expect(page.locator("#cart-badge .badge")).toHaveText("0");
  await stillSamePage(page);
});

/** Sign in as cy, put something in the cart and check out; returns the order page's URL. */
async function placeOrder(page: Page) {
  await cy(page);
  // The made-up crowd buys things out, so take whatever is still in stock.
  await page.locator(".add-form button:enabled").first().click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await page.goto("/cart");
  await page.getByLabel("Name").fill("Cy Rock");
  await page.getByLabel("Address").fill("1 Boulder Lane");
  await page.getByLabel("Card number").fill("4242 4242 4242 4242");
  await page.getByLabel("CVC").fill("123");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  return page.url();
}

test("checks out behind a login and lands on the order, with a flash notice", async ({ page }) => {
  await placeOrder(page);
  await expect(page.locator(".receipt h1")).toHaveText(/Order Y-\d+/);
  await expect(page.locator(".notice")).toContainText("placed");
  await expect(page.locator(".steps .current")).toHaveText("Pending");
  const number = (await page.locator(".receipt h1").textContent())!.replace("Order ", "");

  // My orders: in the nav, newest first.
  await page.getByRole("link", { name: "My orders", exact: true }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.locator("#my-orders tbody tr").first()).toContainText(number);
  await expect(page.locator("#my-orders tbody tr").first().locator(".status")).toHaveText("Pending");
});

test("orders: cancel while pending, and someone else's order is a 404", async ({ page, browser }) => {
  const url = await placeOrder(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(page.locator("#order-status")).toContainText("Cancelled");
  await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);

  const other = await browser.newContext();
  const bo = await other.newPage();
  await logIn(bo, "bo", "flamingo-wrangler", "/");
  const response = await bo.goto(url);
  expect(response?.status()).toBe(404);
  expect((await bo.goto("/orders/not-a-uuid"))?.status()).toBe(404);
  await other.close();
});

test("orders: staff move an order along and the customer's page updates live", async ({ page, browser }) => {
  await placeOrder(page);
  await expect(page.locator(".steps .current")).toHaveText("Pending");
  const number = (await page.locator(".receipt h1").textContent())!.replace("Order ", "");
  await markPage(page);

  const staff = await browser.newContext();
  const admin = await staff.newPage();
  await ada(admin, "/admin/orders");
  await admin.locator("#admin-orders tr", { hasText: number }).getByRole("button", { name: "Mark packed" }).click();
  await expect(admin.locator("#admin-orders tr", { hasText: number }).locator(".status")).toHaveText("Packed");

  // Published on the orders channel; the customer's page refreshes its Regions over SSE.
  await expect(page.locator(".steps .current")).toHaveText("Packed");
  await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  await stillSamePage(page);
  await staff.close();
});

test("returns: photos staged with dropTo, a non-image refused, staff approve live", async ({ page, browser }) => {
  await placeOrder(page);
  const number = (await page.locator(".receipt h1").textContent())!.replace("Order ", "");
  await expect(page.locator("#order-return")).toContainText("once the order has shipped");

  const staff = await browser.newContext();
  const admin = await staff.newPage();
  await ada(admin, "/admin/orders");
  const row = admin.locator("#admin-orders tr", { hasText: number });
  await row.getByRole("button", { name: "Mark packed" }).click();
  await row.getByRole("button", { name: "Mark shipped" }).click();
  await expect(row.locator(".status")).toHaveText("Shipped");

  // Shipped: the return form appears on the customer's page by itself (live refresh).
  await expect(page.locator("#order-return h2")).toHaveText("Request a return");
  await page.getByLabel("Note").fill("It winked at me. Twice.");

  // A text file sneaks past the input's accept (setInputFiles ignores it): the server refuses it next to the field.
  await page.locator("#return-photos").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") });
  await page.getByRole("button", { name: "Request the return" }).click();
  await expect(page.locator('[data-yx-error="photos"]')).not.toBeEmpty();
  await page.locator("#return-photos").setInputFiles([]);

  const zone = page.locator("#order-return .dropzone");
  await zone.dispatchEvent("drop", { dataTransfer: await svgFiles(page, ["front.svg", "back.svg"]) });
  await expect(zone).toHaveAttribute("data-yx-files", "2");
  await page.getByRole("button", { name: "Request the return" }).click();
  await expect(page.locator("#order-return .status")).toHaveText("Return requested");
  await expect(page.locator("#order-return .thumb")).toHaveCount(2);
  const src = await page.locator("#order-return .slide").first().getAttribute("src");
  expect((await page.request.get(src!)).headers()["content-type"]).toBe("image/svg+xml");
  // Staff can see them; a signed-out visitor can't.
  expect((await admin.context().request.get(src!)).status()).toBe(200);
  const stranger = await browser.newContext();
  expect((await stranger.request.get(src!)).status()).toBe(401);
  await stranger.close();

  await admin.reload();
  await expect(row.locator("+ tr.return-row img")).toHaveCount(2);
  await admin.locator("tr.return-row", { hasText: "It winked at me" }).getByRole("button", { name: "Approve return" }).click();
  await expect(page.locator("#order-return .status")).toHaveText("Return approved");
  await staff.close();
});

test("a saved cart: the guest's items merge into it on sign-in and it survives signing out", async ({ page, browser }) => {
  // As a guest: two things in the cart.
  await page.goto("/");
  const add = page.locator(".add-form button:enabled");
  await add.nth(0).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await add.nth(1).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("2");
  const guestItems = await page.locator(".product").filter({ has: page.locator(".add-form button:enabled") }).locator(".product-name").evaluateAll((els) => els.slice(0, 2).map((e) => e.textContent!));

  // di has a saved cart from last time: signing in merges the two, and the header shows it at once.
  await logIn(page, "di", "saved-my-cart", "/cart");
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.locator(".notice")).toContainText("Welcome back, we kept 2 items from last time");
  const names = await page.locator(".cart-name").allTextContents();
  for (const item of guestItems) expect(names).toContain(item);
  expect(names).toContain("Rock That Was Here First");
  const quantities = await page.locator(".cart-line .qty").evaluateAll((els) => els.map((e) => Number((e as HTMLInputElement).value)));
  const total = String(quantities.reduce((a, b) => a + b, 0));
  expect(Number(total)).toBeGreaterThan(2);
  await expect(page.locator("#cart-badge .badge")).toHaveText(total);
  // Shown once.
  await page.reload();
  await expect(page.locator(".notice")).toHaveCount(0);
  await page.goto("/orders");
  await expect(page.locator(".saved-cart")).toContainText("Rock That Was Here First");

  // Sign out (saved), then sign in somewhere else: the cart is still there.
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("0");
  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  await logIn(other, "di", "saved-my-cart", "/cart");
  await expect(other.locator("#cart-badge .badge")).toHaveText(total);
  expect((await other.locator(".cart-name").allTextContents()).sort()).toEqual([...names].sort());
  await elsewhere.close();
});

test("events: the cart's shipping is a call, and an order fans out to every handler, live in the event log", async ({ page, browser }) => {
  const staff = await browser.newContext();
  const log = await staff.newPage();
  await ada(log, "/admin/event-log");
  await expect(log.locator("h1")).toHaveText("Event log");

  await cy(page);
  await page.locator(".add-form button:enabled").first().click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await page.goto("/cart");
  await expect(page.locator("#shipping .cart-total")).toContainText(/Shipping (Free|\$\d)/);

  // The Shipping handler's 422 comes back through events.call() and lands on the select.
  await page.getByLabel("Ship to").selectOption("AQ");
  await expect(page.locator('[data-yx-error="country"]')).toHaveText("We don't ship to Antarctica: the penguins send everything back.");
  await page.getByLabel("Ship to").selectOption("PT");
  await expect(page.locator('[data-yx-error="country"]')).toBeEmpty();
  await expect(page.getByLabel("Ship to")).toHaveValue("PT");

  await page.getByLabel("Name").fill("Cy Rock");
  await page.getByLabel("Address").fill("1 Boulder Lane, Lisbon");
  await page.getByLabel("Card number").fill("4242 4242 4242 4242");
  await page.getByLabel("CVC").fill("123");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  const number = (await page.locator(".receipt h1").textContent())!.replace("Order ", "");

  // The staff tab updates by itself: one order.placed, six handlers (the Warehouse may need a retry or two).
  const entry = log.locator('.event-row[data-name="order.placed"]', { hasText: number });
  await expect(entry).toHaveCount(1);
  for (const handler of ["Receipts.send", "Warehouse.reserve", "SalesFeed.fromOrder", "Carts.forget", "OrderFeed.placed", "OrderBell.ring"]) {
    await expect(entry.locator(`.handler.ok[data-handler="${handler}"]`)).toHaveCount(1, { timeout: 10_000 });
  }
  await expect(log.locator('.event-row[data-name="shipping.quote"]').first()).toContainText("Shipping.quote");
  await staff.close();
});

test("events: a declined card fails the request after emitting, so nothing is sent", async ({ page, browser }) => {
  const staff = await browser.newContext();
  const log = await staff.newPage();
  await ada(log, "/admin/event-log");
  const placed = log.locator('.event-row[data-name="order.placed"]');
  const before = await placed.count();

  await cy(page);
  await page.locator(".add-form button:enabled").first().click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await page.goto("/cart");
  await page.getByLabel("Name").fill("Cy Rock");
  await page.getByLabel("Address").fill("1 Boulder Lane");
  await page.getByLabel("Card number").fill("4000 0000 0000 0002");
  await page.getByLabel("CVC").fill("123");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator(".checkout .form-error")).toHaveText("The bank said no. The gnomes are sympathetic.");
  await expect(page).toHaveURL(/\/cart$/);
  // The cart is still there (the request failed), and no order was kept.
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");

  // Give any stray event time to arrive, then check it never did.
  await log.waitForTimeout(1500);
  await log.reload();
  await expect(placed).toHaveCount(before);
  await page.goto("/orders");
  await expect(page.locator("#my-orders")).not.toContainText("Cy Rock");
  await staff.close();
});

test("the back office: guests go to login, customers get a 403, staff get in", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);

  await cy(page, "/admin");
  await expect(page.locator(".error-code")).toHaveText("403");
  await expect(page.locator("h1")).toHaveText("Staff only");

  // The error page has no shop chrome (no log-out button): start over as someone else.
  await page.context().clearCookies();
  await ada(page);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator("h1.page-title")).toHaveText("Dashboard");
  // trigger="load": the panel fills itself right after the page arrives.
  await expect(page.locator("#low-stock .skeleton")).toHaveCount(0);
  await expect(page.locator("#pulse .stat-value")).toBeVisible();
});

test("kanban: drag a card to another column, then into the bin", async ({ page }) => {
  await ada(page, "/admin/board");
  const title = `Polish the googly eyes ${Date.now().toString(36)}`;
  await page.getByPlaceholder("What needs doing around the shop?").fill(title);
  await page.getByRole("button", { name: "Add card" }).click();
  const card = page.locator(".card", { hasText: title });
  await expect(page.locator('.column[data-status="todo"] .card', { hasText: title })).toBeVisible();

  // Onto the column's heading, not onto another card.
  await card.dragTo(page.locator('.column[data-status="done"] h2'));
  await expect(page.locator('.column[data-status="done"] .card', { hasText: title })).toBeVisible();
  await expect(page.locator('.column[data-status="todo"] .card', { hasText: title })).toHaveCount(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".card", { hasText: title }).dragTo(page.locator(".bin"));
  await expect(page.locator(".card", { hasText: title })).toHaveCount(0);
});

test("file drops: a photo zone uploads at once, a dropTo zone stages for the form", async ({ page }) => {
  await ada(page, "/admin/products");
  const row = page.locator(".admin-row").first();
  await row.locator(".photo-drop").dispatchEvent("drop", { dataTransfer: await svgFiles(page, ["gnome.svg"]) });
  await expect(page.locator(".admin-row").first().locator(".photo-drop")).toContainText("1 photo");

  const name = `Gnome Lawyer ${Date.now().toString(36)}`;
  // Every row has its own (visually hidden) "Name" label too, so the new-product fields go by id.
  await page.locator("#new-name").fill(name);
  await page.locator("#new-price").fill("42");
  const zone = page.locator(".dropzone");
  await zone.dispatchEvent("drop", { dataTransfer: await svgFiles(page, ["a.svg", "b.svg"]) });
  await expect(zone).toHaveAttribute("data-yx-files", "2");
  await page.getByRole("button", { name: "Add product" }).click();
  const added = page.locator(".admin-row").first();
  await expect(added.locator('input[name="name"]')).toHaveValue(name);
  await expect(added.locator(".photo-drop")).toContainText("2 photos");
  // data-yx-reset cleared the form, and the zone's count with it.
  await expect(zone).not.toHaveAttribute("data-yx-files", /.*/);
});

test("chat: Enter sends, the message lands on top", async ({ page }) => {
  await cy(page, "/chat");
  await expect(page).toHaveURL(/\/chat$/);
  const text = `Is the warm rock warm today? ${Date.now().toString(36)}`;
  const box = page.getByLabel("Message");
  await box.fill(text);
  await box.press("Enter");
  await expect(page.locator(".message").first()).toContainText(text);
  await expect(box).toHaveValue("");
});

test("the product slider: next and previous wrap, thumbnails jump, arrow keys work", async ({ browser }) => {
  // Headless Chrome counts as a bot (isBot), which gets the script-free variant: be a person.
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" });
  const page = await context.newPage();
  await page.goto("/products/disco-gnome");
  const slides = page.locator(".slide");
  const thumbs = page.locator(".thumb");
  await expect(slides).toHaveCount(3);
  await expect(slides.nth(0)).toBeVisible();
  await expect(slides.nth(1)).toBeHidden();

  await page.getByRole("button", { name: "Next photo" }).click();
  await expect(slides.nth(1)).toBeVisible();
  await expect(slides.nth(0)).toBeHidden();
  await expect(thumbs.nth(1)).toHaveClass(/active/);
  await expect(thumbs.nth(0)).not.toHaveClass(/active/);

  await page.getByRole("button", { name: "Previous photo" }).click();
  await page.getByRole("button", { name: "Previous photo" }).click();
  await expect(slides.nth(2)).toBeVisible();

  await thumbs.nth(0).click();
  await expect(slides.nth(0)).toBeVisible();
  await expect(page).toHaveURL(/\/products\/disco-gnome$/);

  await page.locator(".slider").focus();
  await page.keyboard.press("ArrowRight");
  await expect(slides.nth(1)).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(slides.nth(2)).toBeVisible();
  await context.close();
});

test("field-level errors: each message goes into its field's box", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Username").fill("x");
  await page.getByLabel(/^Password/).fill("short");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.locator('[data-yx-error="name"]')).not.toBeEmpty();
  await expect(page.locator('[data-yx-error="password"]')).not.toBeEmpty();
  await expect(page.getByLabel("Username")).toHaveAttribute("aria-invalid", "true");
  await expect(page).toHaveURL(/\/signup$/);
});

test("returns: is.email, is.date, is.url and a branded Uuid pipeline", async ({ page }) => {
  await page.goto("/returns");
  await page.getByLabel(/^Order id/).fill("not-an-order");
  await page.getByLabel("Email").fill("not an email");
  await page.getByLabel("Received on").fill("2026-01-02");
  await page.getByLabel(/Photo link/).fill("javascript:alert(1)");
  await page.getByLabel("What happened?").fill("It looked at me.");
  await page.getByRole("button", { name: "Send the return request" }).click();
  await expect(page.locator('[data-yx-error="order"]')).toHaveText("There's no order with that number.");
  await expect(page.locator('[data-yx-error="email"]')).not.toBeEmpty();
  await expect(page.locator('[data-yx-error="evidence"]')).not.toBeEmpty();

  await page.getByLabel(/^Order id/).fill("  123E4567-E89B-42D3-A456-426614174000 ");
  await page.getByLabel("Email").fill("cy@example.com");
  await page.getByLabel(/Photo link/).fill("https://example.com/gnome.jpg");
  await page.getByRole("button", { name: "Send the return request" }).click();
  await expect(page.locator("#return-form .notice")).toContainText("received");
});

test("the feature tour: every link leads somewhere real", async ({ page }) => {
  await ada(page, "/features");
  await expect(page.locator("h1")).toHaveText(/^Feature tour/);
  const links = [...new Set(await page.locator(".features-list dt a").evaluateAll((as) => as.map((a) => a.getAttribute("href")!)))];
  expect(links.length).toBeGreaterThan(25);
  // The error demos answer with their status on purpose.
  const expected: Record<string, number> = { "/oops": 500, "/no-such-aisle": 404, "/products/no-such-thing": 404, "/api/products/p999": 404 };
  for (const link of links) {
    const response = await page.request.get(link, { headers: { accept: "text/html" } });
    expect(response.status(), link).toBe(expected[link] ?? 200);
  }
});

test("the error page shows a crash's stack in development only", async ({ request }, info) => {
  const response = await request.get("/oops", { headers: { accept: "text/html" } });
  expect(response.status()).toBe(500);
  const html = await response.text();
  expect(html).toContain("Internal Server Error");
  expect(html.includes("Stack trace")).toBe(info.project.name === "kitchen-dev");
});

test("assets: the stylesheet and hero resolve (hashed in production), public files are served", async ({ page, request }, info) => {
  await page.goto("/");
  const css = await page.locator('link[rel="stylesheet"]:not([href*="/yerd-"])').getAttribute("href");
  const hero = await page.locator(".hero-img").getAttribute("src");
  expect(css).toMatch(info.project.name === "kitchen-prod" ? /^\/assets\/styles-[\w-]+\.css$/ : /^\/src\/styles\.css$/);
  expect(hero).toMatch(info.project.name === "kitchen-prod" ? /^\/assets\/hero-[\w-]+\.svg$/ : /^\/src\/hero\.svg$/);
  // The page is styled: the stylesheet's custom properties apply.
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  for (const url of [css!, hero!, "/humans.txt"]) expect((await request.get(url)).status(), url).toBe(200);
});

test("about is prerendered with Dynamic parts filled in", async ({ page }) => {
  await page.goto("/about");
  await expect(page.locator("h1")).toContainText("one framework");
  await expect(page.locator("#online-now")).toContainText("browsing right now");
  await expect(page.locator("#about-account")).toContainText("Log in");
});

test("sitemap.xml lists the public pages and every product, robots.txt points at it", async ({ request }) => {
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toBe("application/xml; charset=utf-8");
  const xml = await sitemap.text();
  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).pathname);
  expect(paths).toEqual(expect.arrayContaining(["/", "/products", "/about", "/features", "/products/disco-gnome"]));
  expect(paths.filter((p) => /^\/(admin|api|cart|login|signup|oops)(\/|$)/.test(p) || p.endsWith("/embed"))).toEqual([]);
  expect(xml).toMatch(/<loc>[^<]+\/products\/disco-gnome<\/loc><lastmod>[^<]+<\/lastmod><priority>0\.8<\/priority>/);

  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /admin\nDisallow: /cart\n");
  expect(robots).toMatch(/^Sitemap: https?:\/\/[^/\s]+\/sitemap\.xml$/m);
});

test("REST API: create, patch, delete, with the API key", async ({ request }) => {
  const denied = await request.post("/api/products", { data: { name: "Nope", category: "rocks", priceCents: 100 } });
  expect(denied.status()).toBe(401);

  const headers = { "x-api-key": "let-me-in" };
  const created = await request.post("/api/products", { headers, data: { name: "  Gnome Lawyer  ", category: "gnomes", priceCents: 4200, tags: ["Legal"] } });
  expect(created.status()).toBe(201);
  const product = (await created.json()) as { id: string; name: string; stock: number; tags: string[] };
  expect(product).toMatchObject({ name: "Gnome Lawyer", stock: 10, tags: ["legal"] });
  expect(created.headers()["location"]).toBe(`/api/products/${product.id}`);

  const bad = await request.post("/api/products", { headers, data: { name: "x", category: "moons", priceCents: -1 } });
  expect(bad.status()).toBe(400);
  expect(((await bad.json()) as { issues: unknown[] }).issues).toHaveLength(3);

  const patched = await request.patch(`/api/products/${product.id}`, { headers, data: { stock: 0 } });
  expect(await patched.json()).toMatchObject({ name: "Gnome Lawyer", stock: 0, priceCents: 4200 });

  expect((await request.delete(`/api/products/${product.id}`, { headers })).status()).toBe(204);
  const gone = await request.get(`/api/products/${product.id}`);
  expect(gone.status()).toBe(404);
  expect(await gone.json()).toEqual({ error: `No product with id ${product.id}`, code: "not_found", id: product.id });
});

test("crawlers get the script-free variant, people the interactive one", async ({ request }) => {
  const bot = await request.get("/products/disco-gnome", { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)", accept: "text/html" } });
  const botHtml = await bot.text();
  expect(bot.headers()["vary"]).toContain("user-agent");
  expect(botHtml).toContain('"@type":"Product"');
  expect(botHtml).not.toContain("/_yerd/runtime.js");
  expect(botHtml).not.toContain("Add to cart");

  const person = await request.get("/products/disco-gnome", { headers: { accept: "text/html" } });
  const html = await person.text();
  expect(html).toContain("/_yerd/runtime.js");
  expect(html).toContain("Add to cart");
});

test("checkout: a validation error shows under its field, and the field is marked", async ({ page }) => {
  await cy(page);
  await page.locator(".add-form button:enabled").first().click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await page.goto("/cart");
  await page.getByLabel("Name").fill("Cy Rock");
  await page.getByLabel("Address").fill("sdaf");
  await page.getByLabel("Card number").fill("4242 4242 4242 4242");
  await page.getByLabel("CVC").fill("123");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.locator('[data-yx-error="address"]')).toHaveText("Must be 5 to 200 characters (got 4)");
  await expect(page.getByLabel("Address")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Address")).toBeFocused();
  await expect(page).toHaveURL(/\/cart$/);
});

test("scoped css: the rules arrive with the page and style the element", async ({ page, baseURL }, info) => {
  await page.goto("/features");
  const pill = page.locator(".page-title span").first();
  await expect(pill).toHaveText("live");
  const style = await pill.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, radius: s.borderTopLeftRadius, animation: s.animationName };
  });
  expect(style.bg).toBe("rgb(214, 69, 43)");
  expect(style.radius).toBe("999px");
  expect(style.animation).toMatch(/^yx-k-/);
  // The global variable from css.global is defined.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bazaar-glow").trim())).toBe("rgba(214, 69, 43, 0.5)");
  const html = await (await page.request.get(`${baseURL}/features`)).text();
  if (info.project.name.endsWith("prod")) {
    // After vite build: one hashed stylesheet, nothing inlined.
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/yerd-[a-z0-9]+\.css">/);
    expect(html).not.toContain("data-yx-css=");
  } else {
    // Dev: rules inline, moved into <head> by the runtime.
    expect(html).toContain("data-yx-css=");
    expect(await page.locator("body style[data-yx-css]").count()).toBe(0);
    expect(await page.locator("head style[data-yx-css]").count()).toBeGreaterThanOrEqual(2);
  }
});

test("rave: two tabs dance on one beat, and a cue plays on both at the same moment", async ({ browser, baseURL }) => {
  const [one, two] = await Promise.all([browser.newContext({ baseURL }).then((c) => c.newPage()), browser.newContext({ baseURL }).then((c) => c.newPage())]);
  await Promise.all([one.goto("/rave"), two.goto("/rave")]);
  await expect(one.getByRole("heading", { name: "Gnome rave" })).toBeVisible();

  // Same machine: the measured offset is about nothing, over a quick round trip.
  const clock = await one.evaluate(() => (window as unknown as { yerd: { clock: { sync(): Promise<{ offset: number; rtt: number }> } } }).yerd.clock.sync());
  expect(Math.abs(clock.offset)).toBeLessThan(250);
  expect(clock.rtt).toBeLessThan(1000);

  // `sync`: each page's first gnome is at the same point of its beat, read against the server's clock.
  const phase = (page: Page) =>
    page.evaluate(() => {
      const yerd = (window as unknown as { yerd: { clock: { now(): number } } }).yerd;
      const animation = document.querySelector("[data-yx-sync] svg")!.parentElement!.getAnimations()[0]!;
      const period = 1400;
      return (((Number(animation.currentTime) - yerd.clock.now()) % period) + period) % period;
    });
  await expect.poll(async () => Math.min(await phase(one), 1400 - (await phase(one)))).toBeLessThan(40);
  await expect.poll(async () => Math.min(await phase(two), 1400 - (await phase(two)))).toBeLessThan(40);

  // A cue: wait on both pages, press the horn on one.
  const heard = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<{ name: string; late: number; drift: number }>((resolve) => {
          document.addEventListener(
            "yx:cue",
            (event) => {
              const { name, at, late } = (event as CustomEvent<{ name: string; at: number; late: number }>).detail;
              resolve({ name, late, drift: (window as unknown as { yerd: { clock: { now(): number } } }).yerd.clock.now() - at });
            },
            { once: true },
          );
        }),
    );
  // Both streams connected before the press.
  await expect.poll(() => one.evaluate(() => fetch("/_yerd/clock").then(() => true))).toBe(true);
  const waiting = Promise.all([heard(one), heard(two)]);
  await one.getByRole("button", { name: "Airhorn" }).click();
  const [a, b] = await waiting;
  for (const got of [a, b]) {
    expect(got.name).toBe("airhorn");
    expect(got.late).toBe(0);
    expect(Math.abs(got.drift)).toBeLessThan(100);
  }
  await expect(two.locator("[horn]")).toHaveText("@a guest hit the horn");
  await expect(two.locator('[data-yx-cued="airhorn"]').first()).toBeAttached();
  // It comes off when the cue's 1.2s are up.
  await expect(two.locator("[data-yx-cued]")).toHaveCount(0, { timeout: 3000 });

  // Two tabs listening: the count says so (polled every 5s, or on reload).
  await one.reload();
  await expect(one.locator("#ravers")).toContainText(/[2-9] tabs raving/);
  await Promise.all([one.context().close(), two.context().close()]);
});

test("service lifetimes: singleton stays, scoped is one per request and disposed after, transients differ", async ({ page }) => {
  await page.goto("/lifetimes");
  const boot = await page.locator("#boot-id").textContent();
  const visit = await page.locator("#visit-id").textContent();
  expect(visit).toMatch(/^[0-9a-f]{8}$/);
  await expect(page.locator("#visit-again")).toHaveText(visit!);
  expect(await page.locator("#die-left").textContent()).not.toBe(await page.locator("#die-right").textContent());
  await expect(page.locator("#fortune")).not.toBeEmpty();

  await page.reload();
  await expect(page.locator("#boot-id")).toHaveText(boot!);
  await expect(page.locator("#visit-id")).not.toHaveText(visit!);
  // The previous request's Visit was disposed when it ended.
  await expect(page.locator("#disposed")).toContainText(visit!);
});

test("private cue room: an order rings the bell on every staff dashboard, and nobody else can listen", async ({ page, browser, baseURL }) => {
  const staff = await browser.newContext({ baseURL });
  const dashboard = await staff.newPage();
  await ada(dashboard, "/admin");
  const bell = dashboard.locator('[data-yx-cue="ka-ching"]');
  await expect(bell).toHaveAttribute("data-yx-cue-from", "/admin/cues");

  // The staff room isn't public, and its own route is behind the staff guard.
  expect((await page.request.get("/_yerd/cues?room=staff")).status()).toBe(403);
  await cy(page);
  expect((await page.request.get("/admin/cues", { maxRedirects: 0 })).status()).toBe(403);

  await page.locator(".add-form button:enabled").first().click();
  await page.goto("/cart");
  await page.getByLabel("Name").fill("Cy Rock");
  await page.getByLabel("Address").fill("1 Boulder Lane, Lisbon");
  await page.getByLabel("Card number").fill("4242 4242 4242 4242");
  await page.getByLabel("CVC").fill("123");
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  const number = (await page.locator(".receipt h1").textContent())!.replace("Order ", "");

  await expect(bell).toHaveAttribute("data-yx-cued", "ka-ching");
  await expect(bell).toContainText(`Order ${number}:`);
  await expect(bell).toContainText("from @cy");
  await staff.close();
});

test("client code: the dashboard's sparkline island loads and draws once it scrolls into view", async ({ page }) => {
  const fetched: string[] = [];
  page.on("request", (request) => fetched.push(request.url()));
  await page.setViewportSize({ width: 1000, height: 500 });
  await ada(page);
  // The made-up crowd buys every few seconds and the live feed refreshes the Region: two sales make a line.
  const island = page.locator("yerd-island.trend");
  await expect(island).toBeAttached({ timeout: 15_000 });
  await expect(island).toHaveAttribute("data-yx-when", "visible");
  expect(fetched.some((url) => url.includes("sparkline.client"))).toBe(false);
  await expect(island.locator("canvas")).toHaveCount(0);

  // The live feed refreshes the Region (and remounts the island with the new line) every few
  // seconds, so a located element can be swapped out before it's scrolled to: scroll to
  // whichever island is current, and try again if a refresh lands in between.
  await expect(async () => {
    await page.evaluate(() => document.querySelector("yerd-island.trend")?.scrollIntoView({ block: "center" }));
    await expect(page.locator("yerd-island.trend canvas.sparkline")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator("yerd-island.trend")).not.toHaveAttribute("data-yx-loading");
  expect(fetched.some((url) => url.includes("sparkline.client"))).toBe(true);
});

test("client code: <share-link> upgrades once the browser is idle, and confetti's module loads on interaction", async ({ browser }) => {
  // Headless Chrome counts as a bot, which gets the script-free product page: be a person.
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" });
  const page = await context.newPage();
  const fetched: string[] = [];
  page.on("request", (request) => fetched.push(request.url()));
  await page.goto("/products/disco-gnome");
  // The server's plain link, replaced by the element's own button once its module defines it.
  await expect(page.locator("share-link button")).toHaveText("Share");
  await expect(page.locator("share-link a")).toHaveCount(0);
  expect(await page.evaluate(() => customElements.get("share-link") !== undefined)).toBe(true);
  await expect(page.locator("share-link")).not.toHaveAttribute("data-yx-loading");

  const button = page.getByRole("button", { name: "Add to cart" });
  expect(fetched.some((url) => url.includes("confetti.client"))).toBe(false);
  await expect(button).not.toHaveAttribute("data-confetti-ready");
  await button.hover();
  await expect(button).toHaveAttribute("data-confetti-ready", "");
  await expect(button).not.toHaveAttribute("data-yx-loading");
  expect(fetched.some((url) => url.includes("confetti.client"))).toBe(true);
  await context.close();
});
