/**
 * Development only (main.tsx imports it when import.meta.env.DEV): every
 * guide extension from docs/WRITING.md on one page, for working on how they
 * look. Production builds never include it.
 */

import { LoomElement, component, css, mount, reactive, styles } from "@toyz/loom";
import { route } from "@toyz/loom/router";
import { linkContext, loadApi, loadGuides } from "../data";
import { renderMarkdown } from "../markdown";
import { onProseClick, onProseKeydown } from "../prose";

const F = "```";

const SAMPLE = `# Kitchen sink

Every guide extension in one place. Not linked from anywhere, and not in production builds.

## Answers

The product page needs a 404 when the id is wrong.

${F}tsx
import { route, get, param, inject, NotFound } from "@toyz/yerd";

@route("/products/:id")
export class ProductRoute {
  @param("id", { transform: Number }) accessor id!: number;
  @inject(Catalog) accessor catalog!: Catalog;

  @get show() {
    return this.catalog.find(this.id) ?? new NotFound("No such product");
  }
}
${F}

${F}answer
GET /products/7
200 OK
content-type: application/json; charset=utf-8

{"id":7,"name":"Field notebook","price":2400,"tags":["paper","dot grid"],"inStock":true}
---
GET /products/99
404 Not Found
content-type: application/json; charset=utf-8

{"error":"No such product","code":"not_found"}
${F}

Adding to the cart posts a form; without JavaScript it redirects back.

${F}tsx
@post add(@body(AddToCart) item: AddToCart) {
  this.cart.add(item.productId, item.quantity);
  return redirect("/cart");
}
${F}

${F}answer
POST /cart
content-type: application/x-www-form-urlencoded

productId=7&quantity=2
>>>
303 See Other
location: /cart
set-cookie: yerd.sid=...; Path=/; HttpOnly; SameSite=Lax
${F}

A page returns JSX inside its layouts:

${F}tsx
@get page() {
  return <ProductCard product={this.product} />;
}
${F}

${F}answer
GET /products/7
200 OK
content-type: text/html; charset=utf-8

<!doctype html>
<html lang="en">
<head><title>Field notebook - Shop</title></head>
<body>
  <main>
    <h1>Field notebook</h1>
    <p class="price">$24.00 <small>3 in stock</small></p>
    <form method="post" action="/cart">
      <input type="hidden" name="productId" value="7">
      <button>Add to cart</button>
    </form>
    <!-- ... -->
  </main>
  <script>document.body.style.background = "red"</script>
</body>
</html>
${F}

A standalone answer, no code above it, a plain-text body and an empty one:

${F}answer
GET /health
200 OK
content-type: text/plain; charset=utf-8

ok
---
DELETE /cart/7
204 No Content
---
GET /admin
500 Internal Server Error
content-type: text/plain

Internal Server Error
${F}

## Takes and callouts

> [!TAKE]
> Handlers return, they don't call \`res.send()\`. A returned value can be
> tested, negotiated and wrapped in layouts; a sent one already happened.

> [!NOTE]
> A note, for comparison with the take above.

> [!WARNING]
> A warning, same.

## Diagrams

${F}diagram lifecycle
request -> middleware -> guards -> handler -> return value -> coerce + layouts -> response
(on the way out: session commit + cookies; on a throw: @catches -> onError -> error page)
${F}

${F}diagram action
form or element (signed token) -> POST with yx header -> verify token -> guards -> action method -> JSX with Regions -> runtime morphs the matching Regions
(without JS: a plain POST, then a redirect back)
${F}

An unknown name shows its fallback text:

${F}diagram nonesuch
a -> b -> c
${F}

## Tabs

What the handler returns decides the response.

${F}tsx tab="A string"
@get hello() { return "hello"; }
${F}

${F}answer
GET /hello
200 OK
content-type: text/plain; charset=utf-8

hello
${F}

${F}tsx tab="An object"
@get hello() { return { hello: "world" }; }
${F}

${F}answer
GET /hello
200 OK
content-type: application/json; charset=utf-8

{"hello":"world"}
${F}

${F}tsx tab="A number"
@get hello() { return 204; }
${F}

${F}answer
GET /hello
204 No Content

${F}

The same labels again further down follow the choice made above:

${F}tsx tab="A string"
@get bye() { return "bye"; }
${F}

${F}tsx tab="An object"
@get bye() { return { bye: true }; }
${F}

${F}tsx tab="A number"
@get bye() { return 204; }
${F}

### A plain code block

${F}sh
npm install @toyz/yerd
${F}
`;

const sheet = css`
  .prose { max-width: var(--measure); }
`;

@route("/dev/kitchen")
@component("page-kitchen")
@styles(sheet)
export class PageKitchen extends LoomElement {
  @reactive accessor html = "";

  @mount async load() {
    const [api, guides] = await Promise.all([loadApi(), loadGuides()]);
    this.html = renderMarkdown(SAMPLE, linkContext(api, guides, "kitchen")).html;
  }

  update() {
    if (!this.html) return <p class="loading">Loading…</p>;
    return <div class="prose" onClick={onProseClick} onKeyDown={onProseKeydown} rawHTML={this.html}></div>;
  }
}
