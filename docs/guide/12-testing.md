# Testing

The shop's suite walks every flow in these guides, sign-in and checkout included, in well under a second and with no port open. It's [`test/unit/shop-example.test.tsx`](https://github.com/Toyz/yerd/blob/main/test/unit/shop-example.test.tsx); this guide is a tour of it.

## Set up vitest

Vite can't lower TC39 decorators, so add yerd's decorator plugin.

```sh
npm install -D vitest vite esbuild
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { yerdDecorators } from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerdDecorators()],
});
```

Use [yerdDecorators](api:vite.yerdDecorators), not the full `yerd()` plugin: tests don't need the dev server or the build.

## The app under test

The test builds the same app `main.ts` serves, from `createApp()`, with the routes it needs:

```ts
// test/shop.test.tsx
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Events, ILogger, type LogRecord } from "@toyz/yerd";
import { createApp } from "../src/app.js";
import "../src/routes/products.js";
import "../src/routes/cart.js";
// ...checkout, auth, api

const logs: LogRecord[] = [];
const app = createApp({ handleSignals: false })
  .services((s) => s.value(ILogger, { write: (record) => logs.push(record) }))
  .logging({ filter: "info" });

beforeAll(() => app.boot());
afterAll(() => app.stop());
```

```text
 Test Files  1 passed (1)
      Tests  22 passed (22)
   Duration  417ms (tests 60%, transform 22%, import 17%, worker 1%)
```

- `handleSignals: false` leaves Ctrl-C to vitest. `app.boot()` runs `@onBoot` hooks (the demo account's password is hashed there) and throws a `BootError` listing every wiring problem, so it's a test in itself.
- Importing a route registers it; `yerd({ routes: [...], services: [...] })` takes only those classes instead. Vitest gives each file its own module graph, so nothing leaks between files.
- Without `boot()`, the first request starts the app (timers, hosted services too); `stop()` it either way.
- The logger lines are [below](#capturing-logs).

## No server at all: app.request()

[app.request()](api:yerd.YerdApp/request) sends a request through the whole pipeline (middleware, sessions, guards, actions, error pages, streaming) and returns a fetch `Response`.

```ts
it("is a 404 for an unknown id: the error page for browsers, JSON for the rest", async () => {
  const html = await app.request("/products/99", { headers: { accept: "text/html" } });
  expect(html.status).toBe(404);
  expect(await html.text()).toContain("Not on the shelves");

  const json = await app.request("/products/99");
  expect(json.status).toBe(404);
  expect(await json.json()).toEqual({ error: "No product 99", code: "not_found", id: 99 });
});
```

- Paths resolve against `http://localhost`. Pass a full `https://...` URL to test `Secure` and `__Host-` cookies.
- The response resolves once headers are written, so SSE and NDJSON can be read as they arrive; `reader.cancel()` is the client hanging up. The shop reads its stock feed this way.
- [app.fetch(request)](api:yerd.YerdApp/fetch) takes a `Request` you built.

## Cookies and actions: app.client()

[app.client()](api:yerd.YerdApp/client) is a small test browser: it keeps cookies, sends a same-origin `Origin` on writes, and submits the action forms a page rendered.

```ts
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
```

`client.action(page, fields, { index, to, script })` fetches `page`, takes its first action token (or the `index`-th, counting forms and other elements in page order), and posts it with your fields. Signed-in flows reuse one client:

```ts
/** A client with one Field notebook (id 7) in the cart, signed in as the demo account. */
async function shopperWithNotebook() {
  const client = app.client();
  await client.action("/products/7", {});
  await client.action("/login?next=/checkout", DEMO_ACCOUNT);
  return client;
}
```

By default it posts like the runtime (a `yx` header); `script: false` posts like a plain form:

| | Like the runtime (default) | `script: false` |
| --- | --- | --- |
| returns nothing | 204 | 303 back to the page |
| returns JSX | 200, the JSX without layouts | 303 back to the page |
| returns `redirect(url)` | 200 with a `yx-location` header | 303 to `url` |
| throws a validation error | 400, JSON `{ error, issues }` | your error page (or the flash-and-redirect you wrote) |

- Tokens are bound to the session, so a token from one client posted by another is a 403 ([action tokens](15-security.md#action-tokens)); worth a test of its own.
- Values a lambda reads in the browser (`el.value`, `drag.data("id")`) travel as `_yxh0`, `_yxh1`, ... in first-read order: `client.action("/people", { _yxh0: "ada" })`. Without them the action answers 400.

## Events.waitFor()

Checkout announces `OrderPlaced`. Start waiting before the request that emits it:

```ts
it("places the order, announces it, takes the stock and empties the cart", async () => {
  const client = await shopperWithNotebook();
  const placed = app.container.get(Events).waitFor(OrderPlaced, { where: (e) => e.email === "ada@example.com", timeout: "2s" });

  const res = await client.action("/checkout", { name: "Ada Lovelace", email: "ada@example.com", address: "12 St James's Square, London" });
  expect(res.headers.get("yx-location")).toMatch(/^\/orders\/\d+$/);
  expect((await placed).total).toBe(2400);
  // ...the receipt page, the stock, the empty cart
});
```

More in [testing events](14-events.md#testing-events).

## Faking services

`app.services()` registrations win over `@service` ones for the same key. Empty shelves, to see the page say so:

```ts
/** Shelves with nothing on them. */
class EmptyCatalog extends Catalog {
  override search(): Product[] {
    return [];
  }
}

const app = createApp({ handleSignals: false }).services((s) => s.singleton(Catalog, EmptyCatalog));

it("says so when the shelves are empty", async () => {
  const html = await (await app.request("/?q=pen", { headers: { accept: "text/html" } })).text();
  expect(html).toContain("Nothing matches &quot;pen&quot;.");
});
```

```answer
GET /?q=pen
200 OK
content-type: text/html; charset=utf-8

<!doctype html><!-- ... --><main><form class="search" method="get" role="search"><!-- ... --></form><nav class="categories" aria-label="Categories"><!-- ... --></nav><p class="empty">Nothing matches &quot;pen&quot;.</p></main></body></html>
```

- `s.value(Mailer, fakeMailer)` registers a ready object; `s.singleton(Key, Impl)` a class built on first use.
- A fake needs the same shape as the real one; extending it is the short way.

## Capturing logs

The shop registers an [ILogger](api:yerd.ILogger) that collects records (under vitest the default level is `warn`, hence the filter). The receipt is written after the response, so the test waits for it:

```ts
const receiptSent = () => logs.find((r) => r.target === "Receipts" && r.fields?.order === event.orderId);
for (let i = 0; i < 100 && !receiptSent(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
expect(receiptSent()?.fields).toMatchObject({ order: event.orderId, to: "ada@example.com", total: "$24.00" });
```

See [logging](10-logging.md) for what's in a [LogRecord](api:yerd.LogRecord).

## Services, guards and DTOs, no request

[`app.scope()`](08-services.md#scripts-appscope) runs a function in a fresh request scope, so you can `resolve()` anything:

```ts
const desk = await app.scope(() => resolve(Catalog).search({ category: "desk" }).map((p) => p.name));
expect(desk).toEqual(["Desk lamp", "Brass ruler"]);
```

[parse](api:yerd.parse) checks a DTO: it returns the typed instance, or throws [ValidationFailed](api:yerd.ValidationFailed) with every issue:

```ts
expect(() => parse(CheckoutForm, { name: "A", email: "nope", address: "" })).toThrow(ValidationFailed);
// issues: [{ path: "name", message: "Must be 2 to 80 characters (got 1)" },
//          { path: "email", message: "Expected an email address" },
//          { path: "address", message: "Can't be empty" }]
```

A `createGuard` guard keeps its function as `.run`; call it with a stand-in context holding what it reads:

```ts
const weekdays = createGuard("weekdays", (ctx) => {
  const day = new Date(ctx.headers.date ?? Date.now()).getDay();
  return (day !== 0 && day !== 6) || new Forbidden("Closed on weekends");
});

const saturday = { headers: { date: "Sat, 17 Oct 2026 12:00:00 GMT" } } as unknown as YerdContext;
expect(await weekdays.run(saturday)).toBeInstanceOf(Forbidden);
```

A named `@guard` is a service method: `app.scope(() => resolve(Flags).beta(ctx))`.

## A real server

For the network itself (keep-alive, a proxy), listen on a free port:

```ts
let server: RunningServer;
beforeAll(async () => {
  server = await createApp({ handleSignals: false }).listen(0, "127.0.0.1");
});
afterAll(() => server.close());

it("answers over TCP", async () => {
  expect((await fetch(server.url + "/api/products/7")).status).toBe(200);
});
```

`listen(0)` picks a free port, `server.url` has it, and `server.close()` runs the full shutdown.

## In a browser

The runtime's side (morphs, no reloads, focus) needs a real browser. The shop's Playwright suite, [`test/e2e/shop.spec.ts`](https://github.com/Toyz/yerd/blob/main/test/e2e/shop.spec.ts), runs against the dev server and the production build:

```ts
test("adds to the cart, changes the quantity and removes it, without reloading", async ({ page }) => {
  await page.goto("/products/2");
  await markPage(page); // a marker on window that a reload would wipe
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.locator("#cart-badge .badge")).toHaveText("1");
  await stillSamePage(page);
  // ...
});
```

> [!TAKE]
> Most of a yerd app is tested without a browser: forms are plain posts and pages are HTML, so `app.client()` covers them. Keep the browser suite for what only a browser does; it's the slow, flaky part.
