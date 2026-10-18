# Responses

The shop answers in HTML, JSON, redirects and errors, all from what its handlers return.

## Return anything

A handler returns whatever is natural, and yerd picks the status, content type and body from it. The shop returns four kinds of thing:

```tsx tab="JSX"
// src/routes/products.tsx
@get page() {
  const product = this.catalog.find(this.id);
  setMeta({ title: product.name, description: product.description });
  return (
    <article class="product">
      <h1>{product.name}</h1>
      {/* ... */}
    </article>
  );
}
```

```answer
GET /products/7
200 OK
content-type: text/html; charset=utf-8

<!doctype html><html lang="en"><head><!-- ... --><title>Field notebook · Paperyard</title><!-- ... --></head><body><!-- ... --><main><article class="product"><h1>Field notebook</h1><!-- ... --></article></main></body></html>
```

```ts tab="An array"
// src/routes/api.ts
@get list() {
  // An array becomes JSON.
  return this.catalog.search({ q: this.q, category: this.category });
}
```

```answer
GET /api/products?q=lamp
200 OK
content-type: application/json; charset=utf-8

[{"id":4,"name":"Desk lamp","category":"desk","price":6500,"stock":3,"description":"Warm light, one arm, no app."}]
```

```ts tab="An object, or an error"
// src/routes/api.ts
@get show() {
  // An object becomes JSON. A returned error counts as thrown: a JSON 404 with the id.
  return this.catalog.get(this.id) ?? new ProductNotFound(this.id);
}
```

```answer
GET /api/products/7
200 OK
content-type: application/json; charset=utf-8

{"id":7,"name":"Field notebook","category":"notebooks","price":2400,"stock":12,"description":"Waterproof paper for notes in the rain."}
---
GET /api/products/99
404 Not Found
content-type: application/json; charset=utf-8

{"error":"No product 99","code":"not_found","id":99}
```

```ts tab="redirect()"
// src/routes/auth.tsx
@post async leave() {
  await auth.logout();
  return redirect("/");
}
```

```answer
POST /logout
303 See Other
location: /
set-cookie: yerd_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax
```

- Returning a `YerdError` works like throwing it: same status, same body, same [@catches](#handling-errors-with-catches) and error page. It's how you use one in an expression, since TypeScript has no `?? throw`.
- Errors are the named classes (`NotFound`, `Conflict`, [the list](#the-ready-made-classes)). A status alone is for an answer without a body: `return HttpStatus.NoContent` after a delete. [HttpStatus](api:yerd.HttpStatus) names every code; a plain number works too.
- Objects become JSON: plain objects, your own class instances (a validated DTO sends its fields), anything with `toJSON` (a `Date`). `Map` and `Set` are refused with a 500 whose log line says what to do.

> [!TAKE]
> Handlers return; they don't call `res.send()`. A returned value can be tested without a server, negotiated, wrapped in layouts and given headers by decorators, because nothing has been sent yet. You give up writing to the socket mid-handler; for that, return a stream.

| You return | You get |
| --- | --- |
| JSX | 200 `text/html`, wrapped in layouts, streamed |
| a string | 200 `text/plain` |
| a plain object, array or boolean | 200 `application/json` |
| a `YerdError` | as if thrown: its status, and its JSON body ([below](#errors-with-yerderror)) |
| a status | that status with an empty body (`return HttpStatus.NoContent`, or `return 204`) |
| `undefined` or `null` | 204 No Content |
| a `Uint8Array` | 200 `application/octet-stream` |
| an async iterable (e.g. `async *gen()`) | 200 `text/plain`, streamed chunk by chunk |
| a promise | whatever it resolves to, by these same rules |
| [res(body, init)](api:yerd.res) | `body` by these rules, with your status, headers, cookies and layouts |
| [redirect(url)](api:yerd.redirect) | 303 with a `Location` header |
| [negotiate({...})](api:yerd.negotiate) | the variant the Accept header asks for ([routing](02-routing.md#content-negotiation)) |
| [bare(node)](api:yerd.bare) | HTML with no layouts, for fragments |

## res() for full control

[res()](api:yerd.res) wraps any body with an explicit status, headers, cookies or layouts; the body still follows the table above.

```tsx
@post create() {
  return res({ id: 2 }, {
    status: HttpStatus.Created,
    headers: { Location: "/things/2", "Cache-Control": "no-store" },
    cookies: [{ name: "last", value: "2", maxAge: 3600 }],
  });
}
```

| Option | What it does |
| --- | --- |
| `status` | the status code, 200 to 599. Default 200 |
| `headers` | header names are lowercased, so `Content-Type` replaces the default rather than duplicating it |
| `cookies` | `[{ name, value, ...options }]`, same options as `ctx.setCookie` ([below](#setting-things-from-inside-a-handler)) |
| `layout` | layout or layouts for a JSX body, innermost in the chain |
| `inherit` | `false` makes `layout` the whole chain, with no app or route layouts |

See [routing](02-routing.md#layouts-anywhere) for how layout chains combine.

## Redirects

After signing in, the visitor goes back where they were headed. [redirect()](api:yerd.redirect) sends a `Location` header and no body, 303 by default (right after a form post).

```tsx
// src/routes/auth.tsx
@action async submit(_: {}, form: ActionForm) {
  // ...check the password
  // Rotates the session id and keeps a guest's data: the cart comes along.
  await auth.login(user);
  return redirect(safeNext(this.next));
}
```

```answer
POST /login?next=/checkout
_yx=(the form's token)&name=ada&password=analytical-engine
>>>
303 See Other
location: /checkout
set-cookie: yerd_session=f4O1VWdg...; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax
---
POST /login?next=/checkout
_yx=(the form's token)&name=ada&password=analytical-engine
>>>
200 OK
yx-location: /checkout
set-cookie: yerd_session=vgHbzfh-...; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax
```

- The first is a plain form post; the second is the client runtime's (it sends a `yx` header). The runtime gets `yx-location` instead of a 303 and navigates itself.
- [safeNext()](api:auth.safeNext) passes same-site paths only: `/checkout` goes through, `//evil.com` becomes `/`. Run every target from the request through it.
- The status can be 301, 302, 303, 307 or 308: `redirect("/new-path", 301)`.
- Non-ASCII is percent-encoded (`/café` becomes `/caf%C3%A9`); a line break is refused with a 500.

## @status and @setHeader

Declare a fixed status or header on the method and keep returning plain values.

```tsx
import { HttpStatus, post, route, setHeader, status } from "@toyz/yerd";

@route("/comments")
export class Comments {
  @post @status(HttpStatus.Created) @setHeader("cache-control", "no-store")
  create() {
    return { id: 7 }; // 201, JSON, Cache-Control: no-store
  }
}
```

- [@status](api:yerd.status) only replaces the default 200 (or 204); a status from `res()` or a returned number wins.
- [@setHeader](api:yerd.setHeader) adds a header unless the result set it. `Vary` values add up instead.
- Neither applies when the handler throws. Headers set with `ctx.setHeader()` do go out on errors.

## Caching headers

A product page shows the visitor's cart count, so a shared cache must never hand one visitor's page to another. yerd marks it once there's a session. A first visit, then the same page after adding to the cart:

```answer
GET /products/7
200 OK
content-type: text/html; charset=utf-8

<!doctype html><!-- ... --><a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">0</span></a><!-- ... -->
---
GET /products/7
200 OK
cache-control: private, no-cache
content-type: text/html; charset=utf-8

<!doctype html><!-- ... --><a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">1</span></a><!-- ... -->
```

| Response | Header yerd adds |
| --- | --- |
| an HTML page for a visitor with a session | `Cache-Control: private, no-cache`, unless you set `Cache-Control` yourself |
| one URL answering in several formats ([@accepts, negotiate()](02-routing.md#content-negotiation)) | `Vary: Accept` |
| a route with a [variant test](02-routing.md#caching-varies) built by `varies()` (like `isBot`) | `Vary: <the header it reads>` |
| a static file with a hashed name | `Cache-Control: public, max-age=31536000, immutable` |
| other static files and the client runtime | `Cache-Control: no-cache` and an `ETag`, so revalidating costs a 304 |

`Vary` adds up wherever you set it (`@setHeader`, `ctx.setHeader`, `res()` headers). To let caches keep a response, say so: `@get @setHeader("cache-control", "public, max-age=300") list()`.

> [!WARNING]
> Only mark responses that are the same for every visitor as public. A page that reads the session, or renders action forms for a visitor with one, carries that visitor's data and tokens (see [action tokens](15-security.md#action-tokens)).

## Setting things from inside a handler

[currentContext()](api:yerd.currentContext) sets headers, cookies and status mid-handler without changing what you return.

```tsx
@get show() {
  const ctx = currentContext();
  ctx.setHeader("x-request-id", ctx.requestId);
  ctx.setCookie("seen", "yes", { maxAge: 60 * 60 * 24 });
  ctx.deleteCookie("legacy");
  ctx.status(202);
  return "queued";
}
```

| Method | What it does |
| --- | --- |
| `ctx.setHeader(name, value)` | sets a response header, replacing one the result set (`Vary` is added to instead) |
| `ctx.setCookie(name, value, options?)` | adds a `Set-Cookie` |
| `ctx.deleteCookie(name, options?)` | expires a cookie. Pass the same `path` / `domain` it was set with |
| `ctx.status(code)` | like `@status`, decided at run time |

- Cookie options: `maxAge` (seconds), `expires`, `path`, `domain`, `secure`, `httpOnly`, `sameSite`. Defaults: `Path=/`, `HttpOnly`, `SameSite=Lax`.
- Context cookies still go out when the handler later throws, so a "failed attempts" cookie survives the 401.

## Errors with YerdError

A missing product is a 404; one more than the shelf holds is a 409. Throw (or return) a [YerdError](api:yerd.YerdError) subclass, anywhere in a request: a handler, a guard, a transform, a service.

```ts
// src/catalog.ts
/** A NotFound, so pages get the error page and the API a JSON 404 carrying the id. */
export class ProductNotFound extends NotFound {
  constructor(readonly id: number) {
    super(`No product ${id}`, { details: { id } });
  }
}
```

```tsx
// src/routes/products.tsx, in the add action
if (inCart >= product.stock) throw new Conflict(product.stock === 0 ? "Sold out." : `Only ${product.stock} in stock.`);
```

```answer
GET /api/products/99
404 Not Found
content-type: application/json; charset=utf-8

{"error":"No product 99","code":"not_found","id":99}
---
POST /products/8
_yx=(the form's token)
>>>
409 Conflict
content-type: application/json; charset=utf-8

{"error":"Sold out.","code":"conflict"}
```

- Exposed errors (below 500) send `{ "error": message, "code": code, ...details }` as JSON. One with no code and no details sends its message as text.
- 5xx errors aren't exposed: the body is the status text alone. Pass `expose: true` to send the rest.
- The error's `headers` go out either way, on error pages too.
- Any other thrown error is a 500 with the body `Internal Server Error`, and is logged.
- The client runtime shows an action's error message in the form (the 409 above), and browsers get the [error page](#error-pages).

### The ready-made classes

| Class | Status | Code | Its own option |
| --- | --- | --- | --- |
| `BadRequest` | 400 | `bad_request` | |
| `Unauthorized` | 401 | `unauthorized` | `challenge`: the WWW-Authenticate header |
| `Forbidden` | 403 | `forbidden` | |
| `NotFound` | 404 | `not_found` | |
| `MethodNotAllowed` | 405 | `method_not_allowed` | `allow`: the Allow header |
| `NotAcceptable` | 406 | `not_acceptable` | |
| `Conflict` | 409 | `conflict` | |
| `Gone` | 410 | `gone` | |
| `PayloadTooLarge` | 413 | `payload_too_large` | |
| `UnsupportedMediaType` | 415 | `unsupported_media_type` | |
| `ValidationFailed` | 400 | `validation_failed` | `issues`: sent in the body |
| `TooManyRequests` | 429 | `too_many_requests` | `retryAfter`: seconds or a Date, the Retry-After header |
| `ServiceUnavailable` | 503 | `service_unavailable` | `retryAfter`, as above |

Each takes `(message?, options?)`. For any other status, `new YerdError(status, message?, options?)` has no code unless you give one.

| Option | What it does |
| --- | --- |
| `code` | replaces the class's code in the body |
| `expose` | default `true` below 500 |
| `details` | extra fields in the JSON body |
| `headers` | headers for the error response |
| `cause` | the underlying error, for your logs |

yerd's own failures are these classes too: an unknown path is a `NotFound`, a wrong method a `MethodNotAllowed`, a failed DTO a `ValidationFailed`. `@catches` and `instanceof` see them like yours.

### Your own errors

Extend the closest class, as `ProductNotFound` does. For a different body shape, override `toJSON()`:

```ts
import { YerdError } from "@toyz/yerd";

class Problem extends YerdError {
  override toJSON() {
    return { type: `https://example.com/problems/${this.code}`, title: this.message, status: this.status };
  }
}

throw new Problem(422, "Quantity must be positive", { code: "bad_qty", headers: { "content-type": "application/problem+json" } });
```

- `@catches(NotFound)` catches a `ProductNotFound`, and `error.name` is `"ProductNotFound"`.
- An overridden `toJSON()` is used even without a code or details.

## Handling errors with @catches

[@catches](api:yerd.catches) marks a method that handles errors from the route's handlers, guards and actions, returning anything a handler can.

```tsx
import { NotFound, catches, get, res, route } from "@toyz/yerd";

class PetNotFound extends NotFound {
  constructor(readonly what: string) {
    super(`${what} not found`);
  }
}

@route("/pets/:name")
export class Pet {
  @get show() {
    return new PetNotFound("cat");
  }

  @catches(PetNotFound)
  missing(error: PetNotFound) {
    return res(<p>No {error.what} here.</p>, { status: 404 });
  }

  @catches()
  anythingElse(error: unknown) {
    if (error instanceof TypeError) return "try again later";
    return undefined; // not mine: pass it on
  }
}
```

- With error classes it handles only those; with none, everything. Methods are tried in written order.
- JSX renders inside the route's layouts.
- The error's status (a `YerdError`'s, else 500) sticks unless you return `res(..., { status })` or a number.
- `undefined` passes the error on to the next `@catches`, then `app.onError`, then the error page.

## app.onError

`app.onError` is the app-wide version, seeing every unhandled error including 404s and 405s that never reached a route.

```tsx
import { NotFound, res, yerd } from "@toyz/yerd";

class DbDown extends Error {}
const Maintenance = () => <h1>Back soon</h1>;

export default yerd().onError((error, ctx) => {
  if (error instanceof DbDown) return res(<Maintenance />, { status: 503 });
  if (error instanceof NotFound && ctx.path.startsWith("/api/")) return { error: "no such endpoint" };
  return undefined;
});
```

Same rules as `@catches`, with JSX rendered in the app's root layouts.

## Error pages

The shop's errors reach browsers as a page and curl as JSON, from one `throw`. First a browser (`Accept: text/html`), then curl:

```answer
GET /products/99
404 Not Found
content-type: text/html; charset=utf-8

<!doctype html><html lang="en"><head><!-- ... --><title>No product 99 · Paperyard</title><!-- ... --></head><body><!-- ... --><main><section class="error-page"><p class="status">404</p><h1>Not on the shelves</h1><p>No product 99</p><a href="/">Back to the shop</a></section></main></body></html>
---
GET /products/99
404 Not Found
content-type: application/json; charset=utf-8

{"error":"No product 99","code":"not_found","id":99}
```

[app.errorPage()](api:yerd.YerdApp.errorPage) renders errors inside your root layouts; writing one is in [pages and layouts](05-pages-and-layouts.md#error-pages).

- It applies only when Accept includes `text/html`, and not to actions posted by the client runtime, which shows the message in the form.
- API clients get plain text, or JSON for errors with a code or details.
- The full order: the route's `@catches`, `app.onError`, the error page, then the plain response.

## Streaming

The product page listens for stock changes. Returning an async iterable streams it; [@sse](api:yerd.sse) sends it as Server-Sent Events:

```tsx
// src/routes/products.tsx
@get @sse feed() {
  this.catalog.find(this.id); // a 404 before the stream starts
  return this.channels.subscribe(stockChannel(this.id), this.stop);
}
```

```answer
GET /products/7/stock
200 OK
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-transform

data: {"id":7,"stock":8}
```

The response starts at once and stays open; each sale adds a `data:` line. SSE, NDJSON and channels are in [streaming and live](07-streaming-and-live.md).
