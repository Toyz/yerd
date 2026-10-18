// examples/shop end to end, in-process: the flows the guides walk through.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Events, ILogger, type LogRecord } from "@toyz/yerd";
import { createApp } from "../../examples/shop/src/app.js";
import { DEMO_ACCOUNT } from "../../examples/shop/src/users.js";
import { OrderPlaced } from "../../examples/shop/src/orders.js";
import "../../examples/shop/src/routes/products.js";
import "../../examples/shop/src/routes/cart.js";
import "../../examples/shop/src/routes/checkout.js";
import "../../examples/shop/src/routes/auth.js";
import "../../examples/shop/src/routes/api.js";

const logs: LogRecord[] = [];
const app = createApp({ handleSignals: false })
  .services((s) => s.value(ILogger, { write: (record) => logs.push(record) }))
  .logging({ filter: "info" });

beforeAll(() => app.boot());
afterAll(() => app.stop());

const page = { accept: "text/html" };

/** A client with one Field notebook (id 7) in the cart, signed in as the demo account. */
async function shopperWithNotebook() {
  const client = app.client();
  await client.action("/products/7", {});
  await client.action("/login?next=/checkout", DEMO_ACCOUNT);
  return client;
}

describe("the product list", () => {
  it("lists every product", async () => {
    const res = await app.request("/", { headers: page });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Shop · Paperyard</title>");
    expect(html.match(/class="card"/g)).toHaveLength(8);
  });

  it("searches names and descriptions", async () => {
    const html = await (await app.request("/?q=notebook", { headers: page })).text();
    expect(html).toContain("Pocket notebook");
    expect(html).toContain("Field notebook");
    expect(html).not.toContain("Fountain pen");
  });

  it("filters by category, and refuses one it doesn't know", async () => {
    const html = await (await app.request("/?category=desk", { headers: page })).text();
    expect(html.match(/class="card"/g)).toHaveLength(2);
    expect(html).toContain('<a href="/?category=desk" aria-current="page">desk</a>');

    const bad = await app.request("/?category=hats");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ issues: [{ path: "category" }] });
  });

  it("says so when nothing matches", async () => {
    expect(await (await app.request("/?q=zebra", { headers: page })).text()).toContain("Nothing matches &quot;zebra&quot;.");
  });
});

describe("the product page", () => {
  it("shows the product, its stock and an add button", async () => {
    const html = await (await app.request("/products/7", { headers: page })).text();
    expect(html).toContain("<title>Field notebook · Paperyard</title>");
    expect(html).toContain('id="stock" data-yx-region>');
    expect(html).toContain('data-yx-live="/products/7/stock"');
  });

  it("leaves room for the recently viewed island, loaded when the browser is idle", async () => {
    const html = await (await app.request("/products/7", { headers: page })).text();
    expect(html).toContain('<yerd-island class="recent" data-yx-island="/src/recent.client.ts" data-yx-when="idle"');
    expect(html).toContain('data-yx-props="{&quot;id&quot;:7,&quot;name&quot;:&quot;Field notebook&quot;}"');
  });

  it("is a 404 for an unknown id: the error page for browsers, JSON for the rest", async () => {
    const html = await app.request("/products/99", { headers: page });
    expect(html.status).toBe(404);
    expect(await html.text()).toContain("Not on the shelves");

    const json = await app.request("/products/99");
    expect(json.status).toBe(404);
    expect(await json.json()).toEqual({ error: "No product 99", code: "not_found", id: 99 });
  });

  it("renders the error page for unknown paths too, inside the layout", async () => {
    const res = await app.request("/nope", { headers: page });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Back to the shop");
  });
});

describe("the cart", () => {
  it("adds to the cart and sends back the badge", async () => {
    const client = app.client();
    const res = await client.action("/products/7", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="cart-badge" data-yx-region>Cart <span class="badge">1</span>');
    expect(await client.page("/cart")).toContain("Field notebook");
  });

  it("works without JavaScript: back to the product page", async () => {
    const client = app.client();
    const res = await client.action("/products/7", {}, { script: false });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/products/7");
  });

  it("refuses a sold-out product", async () => {
    const res = await app.client().action("/products/8", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Sold out.", code: "conflict" });
  });

  it("changes a quantity, validates it, and removes a line", async () => {
    const client = app.client();
    await client.action("/products/7", {});

    const changed = await client.action("/cart", { qty: "3" }); // the first action on /cart: the quantity form
    expect(await changed.text()).toContain('<span class="badge">3</span>');

    const bad = await client.action("/cart", { qty: "-1" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ issues: [{ path: "qty", message: "Must be from 0 to 99 (got -1)" }] });

    const removed = await client.action("/cart", {}, { index: 1 }); // the remove button
    expect(await removed.text()).toContain("Your cart is empty.");
  });
});

describe("sign in and checkout", () => {
  it("sends guests to sign in first", async () => {
    const res = await app.request("/checkout", { headers: page });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?next=%2Fcheckout");
  });

  it("refuses a wrong password", async () => {
    const client = app.client();
    const res = await client.action("/login", { name: "ada", password: "nope" });
    expect(res.headers.get("yx-location")).toBe("/login");
    expect(await client.page("/login")).toContain("Wrong username or password.");
  });

  it("keeps the guest's cart through sign-in", async () => {
    const client = await shopperWithNotebook();
    const html = await client.page("/cart");
    expect(html).toContain("ada <button");
    expect(html).toContain('<span class="badge">1</span>');
  });

  it("reports every invalid field at once", async () => {
    const client = await shopperWithNotebook();
    const res = await client.action("/checkout", { name: "A", email: "nope", address: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      issues: [
        { path: "name", message: "Must be 2 to 80 characters (got 1)" },
        { path: "email", message: "Expected an email address" },
        { path: "address", message: "Can't be empty" },
      ],
    });
  });

  it("shows field errors and keeps the input without JavaScript", async () => {
    const client = await shopperWithNotebook();
    const res = await client.action("/checkout", { name: "A", email: "nope", address: "" }, { script: false });
    expect(res.status).toBe(303);
    const html = await client.page("/checkout");
    expect(html).toContain('value="nope"');
    expect(html).toContain('data-yx-error="email">Expected an email address</span>');
  });

  it("places the order, announces it, takes the stock and empties the cart", async () => {
    const client = await shopperWithNotebook();
    const before = (await (await app.request("/api/products/7")).json()) as { stock: number };
    const placed = app.container.get(Events).waitFor(OrderPlaced, { where: (e) => e.email === "ada@example.com", timeout: "2s" });

    const res = await client.action("/checkout", { name: "Ada Lovelace", email: "ada@example.com", address: "12 St James's Square, London" });
    const location = res.headers.get("yx-location");
    expect(location).toMatch(/^\/orders\/\d+$/);
    const event = await placed;
    expect(event.total).toBe(2400);

    const receipt = await client.page(location!);
    expect(receipt).toContain("A receipt is on its way to ada@example.com.");
    expect(receipt).toContain('<span class="badge">0</span>');
    expect(((await (await app.request("/api/products/7")).json()) as { stock: number }).stock).toBe(before.stock - 1);

    // The handler runs after the response: wait for its log line.
    const receiptSent = () => logs.find((r) => r.target === "Receipts" && r.fields?.order === event.orderId);
    for (let i = 0; i < 100 && !receiptSent(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receiptSent()?.fields).toMatchObject({ order: event.orderId, to: "ada@example.com", total: "$24.00" });
  });

  it("hides other people's orders", async () => {
    const client = await shopperWithNotebook();
    expect((await client.request("/orders/999", { headers: page })).status).toBe(404);
  });
});

describe("live stock", () => {
  it("streams a message to the product page when stock changes", async () => {
    const controller = new AbortController();
    const feed = await app.request("/products/7/stock", { signal: controller.signal });
    expect(feed.headers.get("content-type")).toContain("text/event-stream");
    const reader = feed.body!.getReader();

    const client = await shopperWithNotebook();
    await client.action("/checkout", { name: "Ada Lovelace", email: "ada@example.com", address: "12 St James's Square, London" });

    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("data:")) text += decoder.decode((await reader.read()).value);
    expect(text).toMatch(/data: \{"id":7,"stock":\d+\}/);
    await reader.cancel();
  });

  it("is a 404 for an unknown product", async () => {
    expect((await app.request("/products/99/stock")).status).toBe(404);
  });
});

describe("the JSON API", () => {
  it("lists products, filtered like the page", async () => {
    const res = await app.request("/api/products?category=pens");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("set-cookie")).toBeNull();
    const products = (await res.json()) as Array<{ name: string }>;
    expect(products.map((p) => p.name)).toEqual(["Fountain pen", "Gel pens, 3 pack", "Mechanical pencil"]);
  });

  it("returns one product, or a JSON 404", async () => {
    expect(await (await app.request("/api/products/1")).json()).toMatchObject({ id: 1, name: "Fountain pen", price: 4800 });
    const missing = await app.request("/api/products/99");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No product 99", code: "not_found", id: 99 });
  });
});
