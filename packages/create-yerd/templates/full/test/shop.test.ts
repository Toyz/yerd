import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, ValidationFailed } from "@toyz/yerd";
import { createApp } from "../src/app.js";
import { CheckoutForm } from "../src/orders.js";
import { DEMO_ACCOUNT } from "../src/users.js";
import "../src/routes/products.js";
import "../src/routes/cart.js";
import "../src/routes/checkout.js";
import "../src/routes/auth.js";
import "../src/routes/api.js";

// The app main.ts serves, with the routes this file imports. No port is opened.
const app = createApp({ handleSignals: false });
beforeAll(() => app.boot());
afterAll(() => app.stop());

const page = { accept: "text/html" };
const address = { name: "Ada Lovelace", email: "ada@example.com", address: "12 St James's Square, London" };

/** A client with a Pocket notebook (id 2) in the cart, signed in as the demo account. */
async function shopper() {
  const client = app.client();
  await client.action("/products/2", {});
  await client.action("/login?next=/checkout", DEMO_ACCOUNT);
  return client;
}

describe("the catalog", () => {
  it("lists every product, and searches", async () => {
    const res = await app.request("/", { headers: page });
    expect(res.status).toBe(200);
    expect((await res.text()).match(/class="card"/g)).toHaveLength(5);

    const html = await (await app.request("/?q=notebook", { headers: page })).text();
    expect(html).toContain("Pocket notebook");
    expect(html).not.toContain("Fountain pen");
  });

  it("is a 404 for an unknown product: the error page for browsers, JSON for the rest", async () => {
    const html = await app.request("/products/99", { headers: page });
    expect(html.status).toBe(404);
    expect(await html.text()).toContain("Not on the shelves");

    const json = await app.request("/products/99");
    expect(json.status).toBe(404);
    expect(await json.json()).toEqual({ error: "No product 99", code: "not_found", id: 99 });
  });
});

describe("the cart", () => {
  it("adds to the cart and sends back the badge", async () => {
    const client = app.client();
    const res = await client.action("/products/2", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<span class="badge">1</span>');
    expect(await client.page("/cart")).toContain("Pocket notebook");
  });

  it("refuses a sold-out product", async () => {
    const res = await app.client().action("/products/5", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Sold out.", code: "conflict" });
  });

  it("removes a line", async () => {
    const client = app.client();
    await client.action("/products/2", {});
    const res = await client.action("/cart", {});
    const html = await res.text();
    expect(html).toContain("Your cart is empty.");
    expect(html).toContain('<span class="badge">0</span>');
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
    await client.action("/login", { name: "ada", password: "nope" });
    expect(await client.page("/login")).toContain("Wrong username or password.");
  });

  it("reports every invalid field at once", async () => {
    const client = await shopper();
    const res = await client.action("/checkout", { name: "A", email: "nope", address: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      issues: [{ path: "name" }, { path: "email", message: "Expected an email address" }, { path: "address" }],
    });
  });

  it("places the order and empties the cart", async () => {
    const client = await shopper();
    const res = await client.action("/checkout", address);
    const location = res.headers.get("yx-location");
    expect(location).toMatch(/^\/orders\/\d+$/);

    const receipt = await client.page(location!);
    expect(receipt).toContain("A receipt is on its way to ada@example.com.");
    expect(receipt).toContain('<span class="badge">0</span>');
  });

  it("validates the form without a request", () => {
    expect(() => parse(CheckoutForm, { name: "A", email: "nope", address: "" })).toThrow(ValidationFailed);
    expect(parse(CheckoutForm, { ...address, name: "  Ada  " }).name).toBe("Ada");
  });
});

describe("the JSON API", () => {
  it("lists and shows products, with no session cookie", async () => {
    const res = await app.request("/api/products?q=lamp");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toMatchObject([{ id: 3, name: "Desk lamp" }]);

    const missing = await app.request("/api/products/99");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found", id: 99 });
  });

  it("answers health checks with 204", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
