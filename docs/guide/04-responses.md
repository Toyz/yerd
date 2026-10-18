# Responses

What a handler can return, how to set status codes, headers and cookies, and how errors become responses.

## Return anything

Return whatever is natural; yerd picks the status, content type and body from it.

```tsx
import { get, post, route } from "@toyz/yerd";

@route("/demo")
export class Demo {
  @get page() {
    return <h1>Hi</h1>; // 200 text/html, inside your layouts
  }

  @post save() {
    return { saved: true }; // 200 application/json
  }
}
```

| You return | You get |
| --- | --- |
| JSX | 200 `text/html`, wrapped in layouts, streamed |
| A string | 200 `text/plain` |
| A plain object, array or boolean | 200 `application/json` |
| A number | That status with an empty body (`return 404`) |
| `undefined` or `null` | 204 No Content |
| A `Uint8Array` | 200 `application/octet-stream` |
| An async iterable (e.g. `async *gen()`) | 200 `text/plain`, streamed chunk by chunk |
| A promise | Whatever it resolves to, by these same rules |
| [`res(body, init)`](api:yerd.res) | `body` by these rules, with your status, headers, cookies and layouts |
| [`redirect(url)`](api:yerd.redirect) | 303 with a `Location` header |
| [`negotiate({...})`](api:yerd.negotiate) | The variant the Accept header asks for (see [routing](02-routing.md)) |
| [`bare(node)`](api:yerd.bare) | HTML with no layouts, for fragments |

- Objects become JSON: plain objects, your own class instances (a validated DTO sends its fields), anything with `toJSON` (a `Date`). `Map`, `Set` and `Error` are refused with a 500 whose log line says what to do.
- `return todos.get(id) ?? 404` sends the object or an empty 404.

## res() for full control

[`res()`](api:yerd.res) wraps any body with an explicit status, headers, cookies or layouts; the body still follows the table above.

```tsx
import { get, post, res, route } from "@toyz/yerd";

@route("/things")
export class ThingsApi {
  @get list() {
    return [{ id: 1 }];
  }

  @post create() {
    return res({ id: 2 }, {
      status: 201,
      headers: { Location: "/things/2", "Cache-Control": "no-store" },
      cookies: [{ name: "last", value: "2", maxAge: 3600 }],
    });
  }
}
```

| Option | What it does |
| --- | --- |
| `status` | The status code, 200 to 599. Default 200. |
| `headers` | Header names are lowercased, so `Content-Type` replaces the default rather than duplicating it. |
| `cookies` | `[{ name, value, ...options }]`, same options as `ctx.setCookie` (below). |
| `layout` | Layout or layouts for a JSX body, innermost in the chain. |
| `inherit` | `false` makes `layout` the whole chain, with no app or route layouts. |

See [routing](02-routing.md#layouts-anywhere) for how layout chains combine.

## Redirects

[`redirect()`](api:yerd.redirect) sends a `Location` header and no body, 303 by default (right after a form post).

```tsx
import { get, query, redirect, route } from "@toyz/yerd";
import { safeNext } from "@toyz/yerd/auth";

@route("/old-path")
export class OldPath {
  @get go() {
    return redirect("/new-path", 301);
  }
}

@route("/go")
export class Go {
  @query("to") accessor to: string | undefined;

  @get go() {
    return redirect(safeNext(this.to)); // "/orders/7" goes through; "//evil.com" becomes "/"
  }
}
```

- The status can be 301, 302, 303, 307 or 308.
- Non-ASCII is percent-encoded (`/café` becomes `/caf%C3%A9`); a line break is refused with a 500.
- Nothing else is checked, so run targets from the request through [`safeNext()`](api:auth.safeNext).

## @status and @setHeader

Declare a fixed status or header on the method and keep returning plain values.

```tsx
import { post, route, setHeader, status } from "@toyz/yerd";

@route("/comments")
export class Comments {
  @post @status(201) @setHeader("cache-control", "no-store")
  create() {
    return { id: 7 }; // 201, JSON, Cache-Control: no-store
  }
}
```

- [`@status`](api:yerd.status) only replaces the default 200 (or 204); a status from `res()` or a returned number wins.
- [`@setHeader`](api:yerd.setHeader) adds a header unless the result set it. `Vary` values add up instead.
- Neither applies when the handler throws. Headers set with `ctx.setHeader()` do go out on errors.

## Caching headers

yerd sets a few caching headers itself so caches never mix up what different visitors see:

| Response | Header yerd adds |
| --- | --- |
| An HTML page for a visitor with a session | `Cache-Control: private, no-cache`, unless you set `Cache-Control` yourself |
| One URL answering in several formats ([`@accepts`, `negotiate()`](02-routing.md#content-negotiation)) | `Vary: Accept` |
| A route with a [variant test](02-routing.md#caching-varies) built by `varies()` (like `isBot`) | `Vary: <the header it reads>` |
| A static file with a hashed name | `Cache-Control: public, max-age=31536000, immutable` |
| Other static files and the client runtime | `Cache-Control: no-cache` and an `ETag`, so revalidating costs a 304 |

`Vary` adds up wherever you set it (`@setHeader`, `ctx.setHeader`, `res()` headers). To let caches keep a response, say so:

```tsx
import { get, route, setHeader } from "@toyz/yerd";

@route("/api/rates")
export class Rates {
  @get @setHeader("cache-control", "public, max-age=300") list() {
    return { eur: 0.92, gbp: 0.79 }; // the same for everyone, fine for five minutes
  }
}
```

> [!WARNING]
> Only mark responses that are the same for every visitor as public. A page that reads the session, or renders action forms for a visitor with one, carries that visitor's data and tokens (see [action tokens](15-security.md#action-tokens)).

## Setting things from inside a handler

[`currentContext()`](api:yerd.currentContext) sets headers, cookies and status mid-handler without changing what you return.

```tsx
import { currentContext, get, route } from "@toyz/yerd";

@route("/hello")
export class Hello {
  @get show() {
    const ctx = currentContext();
    ctx.setHeader("x-request-id", ctx.requestId);
    ctx.setCookie("seen", "yes", { maxAge: 60 * 60 * 24 });
    ctx.deleteCookie("legacy");
    ctx.status(202);
    return "queued";
  }
}
```

| Method | What it does |
| --- | --- |
| `ctx.setHeader(name, value)` | Sets a response header, replacing one the result set (`Vary` is added to instead). |
| `ctx.setCookie(name, value, options?)` | Adds a `Set-Cookie`. |
| `ctx.deleteCookie(name, options?)` | Expires a cookie. Pass the same `path` / `domain` it was set with. |
| `ctx.status(code)` | Like `@status`, decided at run time. |

- Cookie options: `maxAge` (seconds), `expires`, `path`, `domain`, `secure`, `httpOnly`, `sameSite`. Defaults: `Path=/`, `HttpOnly`, `SameSite=Lax`.
- Context cookies still go out when the handler later throws, so a "failed attempts" cookie survives the 401.

## Errors with YerdError

Throw a [`YerdError`](api:yerd.YerdError), or one of its subclasses, to answer with a status. It works anywhere in a request: a handler, a guard, a transform, a service.

```tsx
import { Conflict, NotFound, del, get, route } from "@toyz/yerd";

const orders = new Map<string, { id: string; total: number }>();

@route("/orders/:id")
export class OrderPage {
  @get show() {
    const order = orders.get("x");
    if (!order) throw new NotFound("No such order");
    return order;
  }

  @del remove() {
    throw new Conflict("Order already shipped", { details: { shippedAt: "2026-10-01" } });
    // -> 409 {"error":"Order already shipped","code":"conflict","shippedAt":"2026-10-01"}
  }
}
```

- Exposed errors (below 500) send `{ "error": message, "code": code, ...details }` as JSON. One with no code and no details sends its message as text.
- 5xx errors aren't exposed: the body is the status text alone. Pass `expose: true` to send the rest.
- The error's `headers` go out either way, on error pages too.
- Any other thrown error is a 500 with the body `Internal Server Error`, and is logged.

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
| `code` | Replaces the class's code in the body. |
| `expose` | Default `true` below 500. |
| `details` | Extra fields in the JSON body. |
| `headers` | Headers for the error response. |
| `cause` | The underlying error, for your logs. |

yerd's own failures are these classes too: an unknown path is a `NotFound`, a wrong method a `MethodNotAllowed`, a failed DTO a `ValidationFailed`. `@catches` and `instanceof` see them like yours.

### Your own errors

Extend the closest class:

```ts
import { Conflict, YerdError } from "@toyz/yerd";

class OutOfStock extends Conflict {
  constructor(readonly sku: string) {
    super(`${sku} is out of stock`, { code: "out_of_stock", details: { sku } });
  }
}

// A different body shape: override toJSON().
class Problem extends YerdError {
  override toJSON() {
    return { type: `https://example.com/problems/${this.code}`, title: this.message, status: this.status };
  }
}

throw new Problem(422, "Quantity must be positive", { code: "bad_qty", headers: { "content-type": "application/problem+json" } });
```

- `@catches(Conflict)` catches an `OutOfStock`, and `error.name` is `"OutOfStock"`.
- An overridden `toJSON()` is used even without a code or details.

## Handling errors with @catches

[`@catches`](api:yerd.catches) marks a method that handles errors from the route's handlers, guards and actions, returning anything a handler can.

```tsx
import { NotFound, catches, get, res, route } from "@toyz/yerd";

class PetNotFound extends NotFound {
  constructor(readonly what: string) {
    super(`${what} not found`);
  }
}

@route("/pets/:name")
export class Pet {
  @get show(): never {
    throw new PetNotFound("cat");
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

[`app.errorPage()`](api:yerd.YerdApp.errorPage) renders errors as a page inside your root layouts; writing one is covered in [pages and layouts](05-pages-and-layouts.md#error-pages).

- It applies only when Accept includes `text/html`, and not to actions posted by the client runtime, which shows the message in the form.
- API clients get plain text, or JSON for errors with `details`.
- The full order: the route's `@catches`, `app.onError`, the error page, then the plain response.

## Streaming

Returning an async iterable streams text. For Server-Sent Events, NDJSON and live updates, see [streaming and live](07-streaming-and-live.md).
