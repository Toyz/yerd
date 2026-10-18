# Responses

This page covers what a handler can return, how to set status codes, headers and cookies, and how errors become responses.

## Return anything

A handler returns whatever is natural, and yerd picks the status, content type and body from what it gets.

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

> [!NOTE]
> Objects become JSON: plain objects, instances of your own classes (a DTO you just validated sends its fields), and anything with `toJSON` (a `Date` sends its ISO string). Built-ins JSON can't represent, like `Map`, `Set` or an `Error`, are refused with a 500 whose log line says what to do instead.

`return todos.get(id) ?? 404` is a common idiom: the object as JSON when it exists, an empty 404 when it doesn't.

## res() for full control

[`res()`](api:yerd.res) wraps any body with an explicit status, headers, cookies or layouts. The body still goes through the table above.

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

So `res(<Receipt />, { layout: PrintLayout, inherit: false })` renders a page in just `PrintLayout`. The [routing guide](02-routing.md) explains how layout chains combine.

## Redirects

[`redirect()`](api:yerd.redirect) sends a `Location` header and no body. The default status is 303, which is what you want after a form post.

```tsx
import { get, redirect, route } from "@toyz/yerd";

@route("/old-path")
export class OldPath {
  @get go() {
    return redirect("/new-path", 301);
  }
}
```

The second argument can be 301, 302, 303, 307 or 308. Non-ASCII characters in the location are percent-encoded as UTF-8 (`/café` goes out as `/caf%C3%A9`); everything else is sent as given, so check targets that come from the request before redirecting to them: [`safeNext(value)`](api:auth.safeNext) lets only same-site paths through. A location with a line break is refused (a 500), so request data can't add headers.

```tsx
import { get, query, redirect, route } from "@toyz/yerd";
import { safeNext } from "@toyz/yerd/auth";

@route("/go")
export class Go {
  @query("to") accessor to: string | undefined;

  @get go() {
    return redirect(safeNext(this.to)); // "/orders/7" goes through; "//evil.com" becomes "/"
  }
}
```

## @status and @setHeader

When a handler always answers the same way, declare it on the method and keep returning plain values.

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

- [`@status`](api:yerd.status) only replaces the default 200 (or 204 for an empty result). A status from `res()` or a returned number wins.
- [`@setHeader`](api:yerd.setHeader) adds a header unless the result already set the same one. `Vary` is the exception for both: values add up, so the `Accept` or `User-Agent` that negotiation and variants rely on is never lost.
- Neither applies when the handler throws: an error response keeps its own status and headers. Headers you set with `ctx.setHeader()` do go out on errors.

## Caching headers

yerd sets a few caching headers itself, so that caches in front of you (a CDN, the browser) never mix up what different visitors should see:

| Response | Header yerd adds |
| --- | --- |
| An HTML page for a visitor with a session | `Cache-Control: private, no-cache`, unless you set `Cache-Control` yourself |
| One URL answering in several formats ([`@accepts`, `negotiate()`](02-routing.md#content-negotiation)) | `Vary: Accept` |
| A route with a [variant test](02-routing.md#caching-varies) built by `varies()` (like `isBot`) | `Vary: <the header it reads>` |
| A static file with a hashed name | `Cache-Control: public, max-age=31536000, immutable` |
| Other static files and the client runtime | `Cache-Control: no-cache` and an `ETag`, so revalidating costs a 304 |

`Vary` adds up wherever it's set: `@setHeader("vary", "Cookie")`, `ctx.setHeader("vary", ...)` and `res(body, { headers: { vary } })` add to the values yerd needs instead of replacing them.

To let caches keep a response, say so:

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
> Don't make a page public-cacheable if it renders an action form or reads the session. With sessions on, a page with action forms carries tokens bound to one visitor's session, and a first visit sets that visitor's session cookie: a shared cache would hand both to everyone. Mark only responses that are the same for every visitor (an API answer, a [prerendered](05-pages-and-layouts.md#prerendering) page).

## Setting things from inside a handler

Sometimes you only know a header or cookie halfway through. [`currentContext()`](api:yerd.currentContext) returns the request context, which can set them without changing what you return.

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

Cookie options are `maxAge` (seconds), `expires`, `path`, `domain`, `secure`, `httpOnly` and `sameSite`. The defaults are `Path=/`, `HttpOnly` and `SameSite=Lax`.

> [!TIP]
> Cookies set through the context still go out when the handler later throws, so a "failed attempts" cookie survives the 401.

## Errors with HttpError

Throw an [`HttpError`](api:yerd.HttpError) to answer with a status. Anywhere in the request works: a handler, a guard, a transform, a service.

```tsx
import { HttpError, del, get, route } from "@toyz/yerd";

const orders = new Map<string, { id: string; total: number }>();

@route("/orders/:id")
export class OrderPage {
  @get show() {
    const order = orders.get("x");
    if (!order) throw new HttpError(404, "No such order");
    return order;
  }

  @del remove() {
    throw new HttpError(409, "Order already shipped", { details: { shippedAt: "2026-10-01" } });
  }
}
```

| Argument | What it does |
| --- | --- |
| `status` | The response status. |
| `message` | Sent to the client when exposed. |
| `expose` | Default `true` below 500, `false` from 500 up, so server error messages stay private. |
| `details` | Makes the response JSON: `{ "error": message, ...details }`. |
| `cause` | The underlying error, for your logs. |

Any other thrown error is a 500 with the body `Internal Server Error`, and the error is logged. Its message never reaches the client.

## Handling errors with @catches

[`@catches`](api:yerd.catches) marks a route method as the handler for errors thrown by that route's handlers, guards and actions. It gets the error and returns anything a handler can.

```tsx
import { catches, get, res, route } from "@toyz/yerd";

class NotFound extends Error {
  constructor(readonly what: string) {
    super(`${what} not found`);
  }
}

@route("/pets/:name")
export class Pet {
  @get show(): never {
    throw new NotFound("cat");
  }

  @catches(NotFound)
  missing(error: NotFound) {
    return res(<p>No {error.what} here.</p>, { status: 404 });
  }

  @catches()
  anythingElse(error: unknown) {
    if (error instanceof TypeError) return "try again later";
    return undefined; // not mine: pass it on
  }
}
```

- With error classes, it handles only those; with none, it handles everything. Methods are tried in the order written.
- JSX renders inside the route's layouts.
- The response keeps the error's status (an `HttpError`'s, else 500) unless you return `res(..., { status })` or a number.
- Returning `undefined` passes the error on to the next `@catches`, then `app.onError`, then the error page.

## app.onError

`app.onError` is the app-wide version. It sees every error a route didn't handle, including 404s and 405s that never reached a route.

```tsx
import { HttpError, res, yerd } from "@toyz/yerd";

class DbDown extends Error {}
const Maintenance = () => <h1>Back soon</h1>;

export default yerd().onError((error, ctx) => {
  if (error instanceof DbDown) return res(<Maintenance />, { status: 503 });
  if (error instanceof HttpError && error.status === 404 && ctx.path.startsWith("/api/")) return { error: "no such endpoint" };
  return undefined;
});
```

Same rules as `@catches`: JSX renders in the app's root layouts, the error's status sticks unless you pick one, and `undefined` falls through to the error page.

## Error pages

[`app.errorPage()`](api:yerd.YerdApp.errorPage) renders errors as a page for browsers. The component gets the status, a message that's safe to show, and the thrown `error` (see [error pages](05-pages-and-layouts.md#error-pages) for showing details in development only). It renders inside your root layouts.

```tsx
import { yerd, type ErrorPageProps } from "@toyz/yerd";
import { RootLayout } from "./layouts.js";

function ErrorPage({ status, message }: ErrorPageProps) {
  return (
    <section class="error">
      <h1>{status}</h1>
      <p>{message}</p>
    </section>
  );
}

export default yerd().layout(RootLayout).errorPage(ErrorPage);
```

It applies only when the request's Accept header includes `text/html`, and not to actions posted by the client runtime, which get the plain error so the runtime can show its message in the form. API clients keep getting plain text, or JSON for errors with `details`. The `message` is an exposed `HttpError`'s message, otherwise the standard status text ("Not Found", "Internal Server Error").

The full order for any error: the route's `@catches` methods, then `app.onError`, then the error page, then the plain response.

## Streaming

Returning an async iterable already streams text. For Server-Sent Events, NDJSON feeds and live updates pushed to every open tab, see [streaming and live updates](07-streaming-and-live.md).
