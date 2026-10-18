# Your first app

The shop's spine, from an empty folder: a catalog, a page per product and a cart.

We're building Paperyard, a small stationery shop. The finished version is [`examples/shop`](https://github.com/Toyz/yerd/tree/main/examples/shop); every step here is a piece of it. Data lives in memory, so there's no database to set up.

## 1. Set up the project

An empty folder, yerd, and the tools it compiles with ([Getting started](01-getting-started.md) explains each piece).

```sh
mkdir paperyard && cd paperyard
npm init -y
npm pkg set type=module
npm install @toyz/yerd
npm install -D typescript @types/node vite esbuild vitest
```

Copy the `tsconfig.json` from [Getting started](01-getting-started.md#configure-typescript). Then the Vite config and the entry module, which default-exports the app:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import yerd from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerd({ entry: "/src/main.ts", client: ["src/styles.css"] })],
});
```

```ts
// src/main.ts
/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";

export default yerd().discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

Run `npx vite` and ask for the front page:

```answer
GET /
404 Not Found
content-type: application/json; charset=utf-8

{"error":"Not Found","code":"not_found"}
```

- The server is up and has no routes yet. Leave it running: it reloads as you save.
- `discover()` registers every route under `src/routes/`, so new files need no wiring.

## 2. A catalog and a product list

The shop needs products, and a page that lists them. The products live in a [@service](api:yerd.service): one instance for the whole app, handed to whoever asks.

```ts
// src/catalog.ts
import { service } from "@toyz/yerd";

export const CATEGORIES = ["pens", "notebooks", "desk"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Product {
  id: number;
  name: string;
  category: Category;
  /** In cents: money is never a float. */
  price: number;
  stock: number;
  description: string;
}

const PRODUCTS: Product[] = [
  { id: 1, name: "Fountain pen", category: "pens", price: 4800, stock: 5, description: "Steel nib, fine point, refillable." },
  // ...seven more
];

/** The shelves, in memory. A singleton: every request sees the same stock. */
@service
export class Catalog {
  #products = PRODUCTS.map((p) => ({ ...p }));

  /** Products whose name or description contains `q`, optionally in one category. */
  search({ q = "", category }: { q?: string; category?: Category | undefined } = {}): Product[] {
    const needle = q.toLowerCase();
    return this.#products.filter(
      (p) => (!category || p.category === category) && (!needle || `${p.name} ${p.description}`.toLowerCase().includes(needle)),
    );
  }

  get(id: number): Product | undefined {
    return this.#products.find((p) => p.id === id);
  }
}

/** 2400 -> "$24.00". */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
```

Components are functions from props to JSX:

```tsx
// src/components.tsx
import { formatPrice, type Product } from "./catalog.js";

export function Price({ cents }: { cents: number }) {
  return <span class="price">{formatPrice(cents)}</span>;
}

export function ProductCard({ product }: { product: Product }) {
  return (
    <li class="card">
      <a href={`/products/${product.id}`}>{product.name}</a>
      <Price cents={product.price} />
      {product.stock === 0 ? <span class="sold-out">Sold out</span> : null}
    </li>
  );
}
```

A route is a class: [@route](api:yerd.route) gives it a path, [@get](api:yerd.get) marks the method that answers, and [@inject](api:yerd.inject) hands it the catalog.

```tsx
// src/routes/products.tsx
import { get, inject, route } from "@toyz/yerd";
import { Catalog } from "../catalog.js";
import { ProductCard } from "../components.js";

@route("/", { meta: { title: "Shop" } })
export class ProductList {
  @inject(Catalog) accessor catalog!: Catalog;

  @get page() {
    const products = this.catalog.search();
    return <ul class="grid">{products.map((p) => <ProductCard product={p} />)}</ul>;
  }
}
```

```answer
GET /
200 OK
content-type: text/html; charset=utf-8

<ul class="grid"><li class="card"><a href="/products/1">Fountain pen</a><span class="price">$48.00</span></li><li class="card"><a href="/products/2">Gel pens, 3 pack</a><span class="price">$7.50</span></li><!-- ... --><li class="card"><a href="/products/8">Dot grid journal</a><span class="price">$32.00</span><span class="sold-out">Sold out</span></li></ul>
```

- Returning JSX makes an HTML response. Returning an object would make JSON ([Responses](04-responses.md)).
- Injected fields and request data sit on `accessor` fields; the keyword is required.
- Imports end in `.js` even for `.tsx` files: with `nodenext` you import the file the compiler emits.

## 3. A layout

A bare `<ul>` isn't a page. A layout wraps every HTML response in the same document.

```tsx
// src/layouts.tsx
import { Scripts, Stylesheet, type LayoutProps } from "@toyz/yerd";

/** The document. Every HTML response goes through it, error pages included. */
export function RootLayout({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{meta.title ? `${meta.title} · Paperyard` : "Paperyard"}</title>
        <Stylesheet href="src/styles.css" />
        <Scripts />
      </head>
      <body>
        <header class="top">
          <a class="brand" href="/">Paperyard</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
```

The app setup moves to its own file, so tests can build the same app later:

```ts
// src/app.ts
import { yerd, type YerdOptions } from "@toyz/yerd";
import { RootLayout } from "./layouts.js";

/** The app, without routes: main.ts discovers them, tests import the ones they need. */
export function createApp(options?: YerdOptions) {
  return yerd(options).layout(RootLayout);
}
```

```ts
// src/main.ts
/// <reference types="vite/client" />
import { createApp } from "./app.js";

// Vite entry: the plugin serves this app, so no listen() here.
export default createApp().discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

Copy [`styles.css`](https://github.com/Toyz/yerd/blob/main/examples/shop/src/styles.css) into `src/` and reload:

```answer
GET /
200 OK
content-type: text/html; charset=utf-8

<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop · Paperyard</title><link rel="stylesheet" href="/src/styles.css"><script type="module" src="/_yerd/runtime.js"></script></head><body><header class="top"><a class="brand" href="/">Paperyard</a></header><main><ul class="grid"><!-- ... --></ul></main></body></html>
```

- `<!doctype html>` is added because the outermost element is `<html>`.
- The title comes from the route's `meta`. [Pages and layouts](05-pages-and-layouts.md) covers metadata and nested layouts.
- [Stylesheet](api:yerd.Stylesheet) links the source file in dev and the hashed one after `vite build` (that's what `client` in the Vite config is for). [Scripts](api:yerd.Scripts) loads the small client runtime step 6 uses.

## 4. A page per product

Each product needs a page at `/products/<id>`, and a 404 when the id is wrong. First the error, and a `find()` that throws it:

```ts
// src/catalog.ts
import { NotFound, service } from "@toyz/yerd";

/** A NotFound, so pages get the error page and the API a JSON 404 carrying the id. */
export class ProductNotFound extends NotFound {
  constructor(readonly id: number) {
    super(`No product ${id}`, { details: { id } });
  }
}

@service
export class Catalog {
  // ...

  /** Like get(), but a missing product answers the request with a 404. */
  find(id: number): Product {
    const product = this.get(id);
    if (!product) throw new ProductNotFound(id);
    return product;
  }
}
```

A `:id` segment captures part of the path; [@param](api:yerd.param) reads it, and [toInt](api:yerd.toInt) makes it a number.

```tsx
// src/routes/products.tsx
import { get, inject, param, route, setMeta, toInt } from "@toyz/yerd";
import { Price, ProductCard } from "../components.js";

// ...ProductList

/** One product. An unknown id is the catalog's ProductNotFound: a 404. */
@route("/products/:id")
export class ProductPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id", { transform: toInt }) accessor id!: number;

  @get page() {
    const product = this.catalog.find(this.id);
    setMeta({ title: product.name, description: product.description });
    return (
      <article class="product">
        <h1>{product.name}</h1>
        <p>{product.description}</p>
        <Price cents={product.price} />
      </article>
    );
  }
}
```

A thrown error answers with its status. For browsers, give it a page:

```tsx
// src/layouts.tsx
import { Scripts, Stylesheet, type ErrorPageProps, type LayoutProps } from "@toyz/yerd";

/** app.errorPage(): 404s and crashes render here, inside RootLayout. */
export function ErrorPage({ status, message }: ErrorPageProps) {
  return (
    <section class="error-page">
      <p class="status">{status}</p>
      <h1>{status === 404 ? "Not on the shelves" : "Something went wrong"}</h1>
      <p>{message}</p>
      <a href="/">Back to the shop</a>
    </section>
  );
}
```

```ts
// src/app.ts
export function createApp(options?: YerdOptions) {
  return yerd(options).layout(RootLayout).errorPage(ErrorPage);
}
```

```answer
GET /products/7
200 OK
content-type: text/html; charset=utf-8

<!doctype html><html lang="en"><head><!-- ... --><title>Field notebook · Paperyard</title><!-- ... --></head><body><!-- ... --><main><article class="product"><h1>Field notebook</h1><p>Waterproof paper for notes in the rain.</p><span class="price">$24.00</span></article></main></body></html>
---
GET /products/99
404 Not Found
content-type: text/html; charset=utf-8

<!doctype html><html lang="en"><head><!-- ... --><title>No product 99 · Paperyard</title><!-- ... --></head><body><!-- ... --><main><section class="error-page"><p class="status">404</p><h1>Not on the shelves</h1><p>No product 99</p><a href="/">Back to the shop</a></section></main></body></html>
---
GET /products/abc
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Expected an integer, got \"abc\"","code":"validation_failed","issues":[{"path":"id","message":"Expected an integer, got \"abc\""}]}
```

- The error page is for browsers (`Accept: text/html`). curl and API clients get the JSON.
- `toInt` rejects `abc` before your handler runs.
- [setMeta](api:yerd.setMeta) sets the title from inside the handler, once the product is known.

## 5. Search and filter

The list needs a search box and category links. Both are query parameters, read with [@query](api:yerd.query):

```tsx
// src/routes/products.tsx
import { get, inject, oneOf, param, query, route, setMeta, toInt, trim } from "@toyz/yerd";
import { CATEGORIES, Catalog, type Category } from "../catalog.js";

/** The shop's front page: every product, narrowed by ?q= and ?category=. */
@route("/", { meta: { title: "Shop" } })
export class ProductList {
  @inject(Catalog) accessor catalog!: Catalog;
  @query("q", { transform: trim }) accessor q = "";
  // Anything but a known category is a 400, before the handler runs.
  @query("category", { transform: oneOf(...CATEGORIES) }) accessor category: Category | undefined;

  @get page() {
    const products = this.catalog.search({ q: this.q, category: this.category });
    return (
      <>
        {/* A GET form: the search is a URL you can share and reload. */}
        <form class="search" method="get" role="search">
          <input type="search" name="q" value={this.q} placeholder="Search" aria-label="Search" />
          {this.category ? <input type="hidden" name="category" value={this.category} /> : null}
          <button>Search</button>
        </form>
        <nav class="categories" aria-label="Categories">
          <a href="/" aria-current={this.category ? undefined : "page"}>All</a>
          {CATEGORIES.map((c) => (
            <a href={`/?category=${c}`} aria-current={c === this.category ? "page" : undefined}>{c}</a>
          ))}
        </nav>
        {products.length === 0 ? (
          <p class="empty">Nothing matches "{this.q}".</p>
        ) : (
          <ul class="grid">{products.map((p) => <ProductCard product={p} />)}</ul>
        )}
      </>
    );
  }
}
```

```answer
GET /?q=notebook
200 OK
content-type: text/html; charset=utf-8

<!-- ... --><ul class="grid"><li class="card"><a href="/products/6">Pocket notebook</a><span class="price">$9.00</span></li><li class="card"><a href="/products/7">Field notebook</a><span class="price">$24.00</span></li></ul><!-- ... -->
---
GET /?category=hats
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Expected one of pens, notebooks, desk, got \"hats\"","code":"validation_failed","issues":[{"path":"category","message":"Expected one of pens, notebooks, desk, got \"hats\""}]}
```

- A missing parameter falls back to the field's initializer (`q = ""`), or `undefined`.
- `oneOf` makes the field's type the union of the categories, and refuses anything else.
- JSX text is escaped: `?q=<b>` shows as typed. [Request data](03-request-data.md) has every transform and validator.

## 6. A cart in the session

Visitors need a cart that survives between pages, without an account. It goes in the session: a sealed cookie, so the server stores nothing. The cart is a class whose fields are stored and whose methods work on them:

```ts
// src/cart.ts
export interface CartLine {
  id: number;
  qty: number;
}

const MAX_QTY = 99;

/**
 * The cart, as a session shape: `@session(Cart) accessor cart!: Session<Cart>`.
 * Only `lines` is stored, ids and quantities: names and prices come from the
 * catalog at render, so a price change can't leave stale copies in cookies.
 * `this` is the session, so a new visitor gets no cookie until they add something.
 */
export class Cart {
  lines: CartLine[] = [];

  get count(): number {
    return this.lines.reduce((sum, line) => sum + line.qty, 0);
  }

  add(id: number, qty = 1): void {
    const line = this.lines.find((l) => l.id === id);
    // In-place changes are noticed and saved, like assignments.
    if (line) line.qty = Math.min(MAX_QTY, line.qty + qty);
    else this.lines.push({ id, qty: Math.min(MAX_QTY, qty) });
  }

  // ...setQty, remove, empty
}
```

Turn sessions on in `src/app.ts` (`.sessions()` after `.errorPage(ErrorPage)`). Then the product page gets the cart with [@session](api:yerd.session) and an [@action](api:yerd.action): a method a form can call.

```tsx
// src/routes/products.tsx
import { Conflict, Region, action, session, type Session /* , ... */ } from "@toyz/yerd";
import { Cart } from "../cart.js";
import { CartBadge } from "../layouts.js";

/** Stock left, as a Region: live updates and the add action refresh it. */
function Stock({ stock }: { stock: number }) {
  return (
    <Region id="stock" as="p" class="stock" aria-live="polite">
      {stock === 0 ? "Sold out" : `${stock} in stock`}
    </Region>
  );
}

@route("/products/:id")
export class ProductPage {
  // ...catalog and id
  @session(Cart) accessor cart!: Session<Cart>;

  @get page() {
    // ...
        <Price cents={product.price} />
        <Stock stock={product.stock} />
        <form action={this.add}>
          <button disabled={product.stock === 0}>Add to cart</button>
        </form>
    // ...
  }

  /** @param works in actions too: this.id is the product on the page. */
  @action add() {
    const product = this.catalog.find(this.id);
    const inCart = this.cart.lines.find((line) => line.id === product.id)?.qty ?? 0;
    // A 409: the runtime shows its message; checkout checks the stock again anyway.
    if (inCart >= product.stock) throw new Conflict(product.stock === 0 ? "Sold out." : `Only ${product.stock} in stock.`);
    this.cart.add(product.id);
    // With the runtime, these morph in; without it, the browser is sent back to the page.
    return (
      <>
        <CartBadge count={this.cart.count} />
        <Stock stock={product.stock} />
      </>
    );
  }
}
```

The header shows the count. A [Region](api:yerd.Region) is a part of the page that an action's response can replace:

```tsx
// src/layouts.tsx
import { Region, Scripts, Stylesheet, currentContext, type ErrorPageProps, type LayoutProps } from "@toyz/yerd";
import { Cart } from "./cart.js";

/** The cart link in the header. A Region, so cart actions can send a new count. */
export function CartBadge({ count }: { count: number }) {
  return (
    <Region id="cart-badge" as="a" href="/cart" class="cart-badge">
      Cart <span class="badge">{count}</span>
    </Region>
  );
}

/** Items in the visitor's cart; 0 on routes without a session (the API, the stock feed). */
function cartCount(): number {
  const ctx = currentContext();
  return ctx.route.session === false ? 0 : ctx.session.as(Cart).count;
}

// in RootLayout's header, after the brand:
//   <CartBadge count={cartCount()} />
```

```answer
POST /products/7
_yx=(the form's token)
>>>
200 OK
content-type: text/html; charset=utf-8
cache-control: private, no-cache
set-cookie: yerd_session=xmxwsb3x...; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax

<a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">1</span></a><p class="stock" aria-live="polite" id="stock" data-yx-region>12 in stock</p>
---
POST /products/7
_yx=(the form's token)
>>>
303 See Other
location: /products/7
set-cookie: yerd_session=YJe0HAZg...; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax
```

- The first post is the runtime's (it sends a `yx` header): it gets the Regions and morphs them in, no reload. The second is a plain form with JavaScript off: it's sent back to the page.
- The form posts to the page's own URL with a signed `_yx` field naming the action. Nobody can call a method you didn't render.
- The session cookie appears on the first change, not the first visit.

> [!TAKE]
> Actions are forms first. Every one works with JavaScript off, and the runtime only makes it faster. You think in forms and Regions instead of client state, and you give up nothing when a script fails to load.

## 7. The cart page

The cart needs a page where quantities change and lines go. Prices come from the catalog:

```ts
// src/cart.ts
import { between, is } from "@toyz/yerd";
import type { Catalog, Product } from "./catalog.js";

/** The quantity box on the cart page. */
export class QtyForm {
  @is.int({ validate: between(0, MAX_QTY) }) qty!: number;
}

/** The cart's lines with their products and prices. Products gone from the catalog drop out. */
export function priceCart(lines: CartLine[], catalog: Catalog): { lines: PricedLine[]; total: number } {
  // ...
}
```

```tsx
// src/routes/cart.tsx
import { ActionForm, Region, action, get, inject, route, session, type Session } from "@toyz/yerd";
import { Cart, QtyForm, priceCart } from "../cart.js";
import { Catalog } from "../catalog.js";
import { Price } from "../components.js";
import { CartBadge } from "../layouts.js";

@route("/cart", { meta: { title: "Your cart" } })
export class CartPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @session(Cart) accessor cart!: Session<Cart>;

  @get page() {
    return (
      <>
        <h1>Your cart</h1>
        {this.lines()}
      </>
    );
  }

  /** The lines and the total: one Region, so every cart action can send it back. */
  lines() {
    const { lines, total } = priceCart(this.cart.lines, this.catalog);
    // ...an empty cart says so
    return (
      <Region id="cart">
        <ul class="lines">
          {lines.map(({ product, qty, subtotal }) => (
            <li key={product.id}>
              <a href={`/products/${product.id}`}>{product.name}</a>
              {/* The id is signed into the action; the quantity is a form field. */}
              <form action={({ form }) => this.setQty({ id: product.id }, form)}>
                {/* ...label */}
                <input id={`qty-${product.id}`} name="qty" type="number" min="0" max="99" value={qty} data-yx-submit />
                <button>Update</button>
                <span class="field-error" data-yx-error="qty"></span>
              </form>
              <Price cents={subtotal} />
              <form action={() => this.remove({ id: product.id })}>
                <button aria-label={`Remove ${product.name}`}>Remove</button>
              </form>
            </li>
          ))}
        </ul>
        <p class="total">Total <Price cents={total} /></p>
        <a class="button" href="/checkout">Check out</a>
      </Region>
    );
  }

  /** Every Region a cart change touches. */
  regions() {
    return (
      <>
        {this.lines()}
        <CartBadge count={this.cart.count} />
      </>
    );
  }

  @action setQty({ id }: { id: number }, form: ActionForm) {
    const { qty } = form.parse(QtyForm);
    this.cart.setQty(id, qty);
    return this.regions();
  }

  @action remove({ id }: { id: number }) {
    this.cart.remove(id);
    return this.regions();
  }
}
```

```answer
POST /cart
_yx=(the quantity form's token)&qty=3
>>>
200 OK
content-type: text/html; charset=utf-8

<div id="cart" data-yx-region><ul class="lines"><li data-key="7"><a href="/products/7">Field notebook</a><form action="/cart" method="post" data-yx><!-- ... --><input id="qty-7" name="qty" type="number" min="0" max="99" value="3" data-yx-submit><!-- ... --></form><span class="price">$72.00</span><!-- ... --></li></ul><p class="total">Total <span class="price">$72.00</span></p><a class="button" href="/checkout">Check out</a></div><a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">3</span></a>
---
POST /cart
_yx=(the quantity form's token)&qty=-1
>>>
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Validation failed","code":"validation_failed","issues":[{"path":"qty","message":"Must be from 0 to 99 (got -1)"}]}
```

- `() => this.remove({ id })` binds arguments to the action. They're signed into the token, so nobody can edit them.
- `({ form }) => this.setQty({ id }, form)` binds the id and passes the submitted fields on.
- [form.parse()](api:yerd.ActionForm) validates against a DTO. The runtime puts the message into `[data-yx-error="qty"]` and marks the input.
- `key` lets the morph match list items; `data-yx-submit` submits the form when the number changes.

## 8. A test

Tests send requests straight into the app, no port. Every answer in these guides came from a request like these.

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { yerdDecorators } from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerdDecorators()],
});
```

```ts
// test/shop.test.ts
import { afterAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import "../src/routes/products.js";
import "../src/routes/cart.js";

const app = createApp({ handleSignals: false });
afterAll(() => app.stop());

it("is a 404 for an unknown product", async () => {
  const res = await app.request("/products/99");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "No product 99", code: "not_found", id: 99 });
});

it("adds to the cart", async () => {
  const client = app.client(); // keeps cookies, like a browser
  const res = await client.action("/products/7", {}); // the page's first action, posted like the runtime
  expect(await res.text()).toContain('<span class="badge">1</span>');
  expect(await client.page("/cart")).toContain("Field notebook");
});
```

- [app.request()](api:yerd.YerdApp/request) runs the whole pipeline in-process; `app.client()` keeps cookies and can submit a page's action forms.
- `handleSignals: false` leaves Ctrl-C to vitest. [Testing](12-testing.md) has the rest; the shop's own suite is `test/unit/shop-example.test.tsx`.

## Build it

```sh
npx vite build
YERD_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))") node dist/server/server.js
```

Without `YERD_SECRET`, each process signs cookies and forms with a random secret, so a restart empties every cart. Keep a real one out of git. [Deploying](11-deploying.md) covers the rest.

## Where the shop goes next

The finished shop has more than this. Each guide adds a piece:

| Guide | The shop gains |
| --- | --- |
| [Routing](02-routing.md) | a signed-in area for checkout, behind a guard |
| [Request data](03-request-data.md) | the checkout form, validated field by field |
| [Responses](04-responses.md) | the JSON API, redirects, errors with a status |
| [Pages and layouts](05-pages-and-layouts.md) | a narrow layout for forms, the error page, assets |
| [Interactivity](06-interactivity.md) | more on actions, Regions and field errors |
| [Streaming and live](07-streaming-and-live.md) | stock that updates live on every open product page |
| [Sessions and auth](09-sessions-and-auth.md) | sign-in that keeps the guest's cart |
| [Events](14-events.md) | `OrderPlaced`, and a receipt sent after the response |
| [Client code](17-client-code.md) | "Recently viewed" on the product page, in an island |
| [Services](08-services.md), [Logging](10-logging.md), [Testing](12-testing.md), [Deploying](11-deploying.md) | the rest of running it |
