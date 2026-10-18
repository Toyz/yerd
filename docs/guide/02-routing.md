# Routing

The shop gets its URLs: a page per product, an API beside it, and a signed-in area for checkout.

## How a request is answered

Every request takes the same path through the app. Here's a guest asking for the checkout:

```diagram lifecycle
GET /checkout
  -> match the route   /checkout is CheckoutPage (no match: 404, wrong method: 405)
  -> middleware        app.use(auth) loads the signed-in user: nobody
  -> guards            auth.required: nobody signed in, so a 303 to /login
  -> handler           (for a signed-in user) CheckoutPage.page() returns JSX
  -> layouts           RootLayout > Narrow wrap it
  -> session commit    the cookie is written if the session changed
  -> response
```

Middleware and guards can answer early; everything after them is skipped. This guide covers each step up to the handler.

## Routes and verbs

[@route](api:yerd.route) puts a class at a path; verb decorators mark which method answers which HTTP method.

```tsx
// src/routes/api.ts
@route("/api/products/:id", { session: false })
export class ProductApi {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id", { transform: toInt }) accessor id!: number;

  @get show() {
    // An object becomes JSON. A returned error counts as thrown: a JSON 404 with the id.
    return this.catalog.get(this.id) ?? new ProductNotFound(this.id);
  }
}
```

```answer
GET /api/products/7
200 OK
content-type: application/json; charset=utf-8

{"id":7,"name":"Field notebook","category":"notebooks","price":2400,"stock":12,"description":"Waterproof paper for notes in the rain."}
---
DELETE /api/products/7
405 Method Not Allowed
allow: GET, HEAD
content-type: application/json; charset=utf-8

{"error":"Method Not Allowed","code":"method_not_allowed"}
```

- A known path with the wrong method is a 405 with an `Allow` header. `@get` answers HEAD too.
- Verb decorators take no path: one class is one path. `/products/:id` (the page) and `/api/products/:id` are two classes sharing nothing but the catalog they inject.
- Two handlers for one verb on one path are a boot error, unless one uses [@accepts](#content-negotiation) or a [variant test](#variants-per-request-getwhen).

> [!TAKE]
> Routes are classes, not functions in a table. The path's data (params, query, session, services) is declared once on the class and read by every handler and action on it, and the page's actions live next to the page. You write a class per path, and a URL can't be given a handler from somewhere else.

| Decorator | Handles |
| --- | --- |
| [@get](api:yerd.get) | GET, and HEAD automatically (same handler, no body sent) |
| [@post](api:yerd.post) / [@put](api:yerd.put) / [@patch](api:yerd.patch) | POST / PUT / PATCH |
| [@del](api:yerd.del) | DELETE (`delete` is a reserved word) |
| [@head](api:yerd.head) / [@options](api:yerd.options) | HEAD / OPTIONS, when you want to handle them yourself |
| [@all](api:yerd.all) | any method no other handler on the path claims |

The shop's sign-out is a plain `@post`:

```tsx
// src/routes/auth.tsx
@route("/logout")
export class Logout {
  @post async leave() {
    await auth.logout();
    return redirect("/");
  }
}
```

## Params

The product page needs the id from `/products/7`. A `:name` segment captures one path segment:

```tsx
// src/routes/products.tsx
@route("/products/:id")
export class ProductPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id", { transform: toInt }) accessor id!: number;
  // ...
}
```

```answer
GET /products/abc
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Expected an integer, got \"abc\"","code":"validation_failed","issues":[{"path":"id","message":"Expected an integer, got \"abc\""}]}
```

- Values are URL-decoded strings; a transform like [toInt](api:yerd.toInt) converts them ([Request data](03-request-data.md)).
- A trailing `*name` captures the rest of the path: `/files/*path` gives `path` = `"a/b.txt"` for `/files/a/b.txt`, and `""` for `/files`. A bare `*` is captured as `wildcard`.
- Static segments win over params whatever the order: `/products/new` beats `/products/:id`.
- [@params](api:yerd.params) gives them all as a `Record<string, string>`.
- `@param("nope")` on a route without `:nope` stops the boot, naming the class and field.

## Groups

Checkout and the order page both need a signed-in user and the same narrow layout. A [@group](api:yerd.group) class holds shared settings; routes join with the `group` option.

```tsx
// src/routes/checkout.tsx
/** Everything here needs a signed-in user, in a narrow column. No URL prefix. */
@group("/", { guards: [auth.required], layout: Narrow })
export class Account {}

@route("/checkout", { group: Account, meta: { title: "Check out" } })
export class CheckoutPage {
  // ...
}

@route("/orders/:id", { group: Account, meta: { title: "Thank you" } })
export class OrderPage {
  // ...
}
```

```answer
GET /checkout
303 See Other
location: /login?next=%2Fcheckout
```

- `@group("/", ...)` shares guards and layouts without a URL prefix. `@group("/account", ...)` would also prefix every member's path.
- The guard runs before every member's handlers and actions: a guest never reaches `CheckoutPage`.

| Option | What it does |
| --- | --- |
| `layout` | one layout or an array, outermost first, wrapping every member route |
| `guards` | guards that run before every member route |
| `meta` | page metadata members inherit; a route's own `meta` wins per key |
| `group` | a parent group, for nesting |
| `inheritLayouts` | `false` starts the layout chain fresh (below). Default `true` |
| `session` | `false`: member routes have no session (see [routes without a session](09-sessions-and-auth.md#routes-without-a-session)). `@route` takes it too |

Groups nest: prefixes join, layouts nest outer to inner, meta merges (deeper wins), guards run outer first, and the deepest `session` wins.

```tsx
@group("/admin", { layout: AdminLayout, guards: [auth.role("staff")] })
export class Admin {}

@group("/reports", { group: Admin, layout: ReportsNav })
export class Reports {}

@route("/q3", { group: Reports })
export class Q3 {
  @get page() {
    return <h1>Q3</h1>; // GET /admin/reports/q3, in RootLayout > AdminLayout > ReportsNav
  }
}
```

- `inheritLayouts: false` gives an area its own document: the group's layouts replace the app's and outer groups', and inner groups still nest inside.
- `@layout(...)` and `@guards(...)` on the group class work like the options.

## Layouts anywhere

[@layout](api:yerd.layout) adds layouts on a route class (every handler), a handler method, or a group class; the shop's sign-in page uses one (see [nested layouts](05-pages-and-layouts.md#nested-layouts)).

- The chain, outermost first: `app.layout()`, group layouts (outer first), the class's `@layout`, the method's `@layout`, then any layout picked in `res()`.
- Several layouts in one decorator (`@layout(RootLayout, MarketingLayout)`), or stacked `@layout`s, read top to bottom.
- A layout already in the chain isn't applied again, so naming `RootLayout` twice still gives one `<html>`.
- `{ inherit: false }` makes a layout the whole chain; [@noLayout](api:yerd.noLayout) drops all of them.
- [res()](api:yerd.res) picks layouts at return time, when the choice depends on data: `res(<Receipt />, { layout: PrintLayout, inherit: false })`.

## Guards

A guard runs before a handler and decides whether it runs. The shop's `auth.required` comes from [createAuth](09-sessions-and-auth.md#sign-in-with-createauth); your own are made with [createGuard](api:yerd.createGuard), a function of the request context.

```tsx
import { Forbidden, HttpStatus, createGuard, get, post, route } from "@toyz/yerd";

const businessHours = createGuard("businessHours", () => {
  const hour = new Date().getHours();
  return (hour >= 9 && hour < 17) || new Forbidden("Come back during business hours");
});

@route("/support")
export class Support {
  @get page() {
    return <h1>Support</h1>;
  }

  @post @businessHours open() {
    return HttpStatus.Created;
  }
}
```

| The guard returns | Effect |
| --- | --- |
| `true` or nothing | continue to the next guard, then the handler |
| `false` | 403 Forbidden |
| a string | 303 redirect to that URL |
| an `Error` (returned or thrown) | handled like a thrown error, e.g. a `YerdError`'s status |
| anything else | used as the response, like a handler's return value |

- A `createGuard` guard is a decorator for a class (every handler and action) or a method (`@post @businessHours open()`, `@action` methods too).
- Also attach guards with [@guards(a, b)](api:yerd.guards), a `guards: [...]` option on `@route` or `@group`, or `app.guard(...)` for every route.
- Order: app guards, group guards (outer first), the route's `guards` option, class guards, method guards; stacked decorators in written order. The first that doesn't continue decides.
- Guards also run in front of [actions](06-interactivity.md). Roles and named guards backed by services are in [sessions and auth](09-sessions-and-auth.md#guards).

## Middleware

Middleware wraps the whole request: it runs before the guards, calls `next()` for everything after, and sees the response on its way out. The shop has one, from `createAuth`:

```ts
// src/app.ts
export function createApp(options?: YerdOptions) {
  return yerd(options)
    .layout(RootLayout)
    .errorPage(ErrorPage)
    .sessions()
    .use(auth); // loads the signed-in user once per request
}
```

Your own is a function of the context and `next`:

```ts
import { type Middleware } from "@toyz/yerd";

/** How long the app took, as a Server-Timing header (dev tools show it under Timing). */
const timing: Middleware = async (ctx, next) => {
  const started = performance.now();
  const out = await next();
  out.headers["server-timing"] = `app;dur=${(performance.now() - started).toFixed(1)};desc="${ctx.route.className}"`;
  return out;
};
```

- `next()` resolves to the response (`status`, lowercase `headers`, `body`, `cookies`); change it and return it.
- Several run in `use()` order, the first outermost.
- Only requests that matched a route reach it: not 404s for unknown paths, 405s, static files or refused cross-site posts.
- `currentContext()`, `resolve()` and `ctx.session` work.
- Handler errors come out of `next()`, so `try`/`catch` sees them. A throw from the middleware itself goes through `@catches`, `app.onError`, then the error page.
- To turn a request away, prefer a guard; middleware can throw a [YerdError](api:yerd.YerdError).
- `app.use()` also takes anything with a `middleware` function, which is how `auth` plugs in.

## Content negotiation

The shop serves JSON from its own `/api` paths. To serve HTML and JSON from one URL instead, put [@accepts](api:yerd.accepts) on a second handler for the verb:

```tsx
import { accepts, get, route } from "@toyz/yerd";

@route("/todos")
export class Todos {
  @get page() {
    return <ul><li>milk</li></ul>;
  }

  @get @accepts("json") data() {
    return { todos: ["milk"] };
  }
}
```

Shorthands are `html`, `json`, `ndjson`, `text`, `csv`, `xml` and `sse`, or pass a full mime type. To branch inside one handler, return [negotiate()](api:yerd.negotiate); the first key is the default and only the chosen function runs:

```tsx
@get show() {
  const todo = { id: this.id, title: "milk" };
  return negotiate({
    html: () => <h1>{todo.title}</h1>,
    json: () => todo,
  });
}
```

- A bare `*/*` never beats the default (the handler without `@accepts`, or the first key), so browsers get HTML.
- If every handler has `@accepts` and none fits, the response is 406.
- Negotiated responses get `Vary: Accept`.

## Variants per request: @get(when)

A verb decorator can take a test: that handler serves the requests it accepts, and a plain `@get` serves everyone else. The classic use is giving crawlers a complete, script-free page.

```tsx
import { get, isBot, route } from "@toyz/yerd";

@route("/products/:id")
export class Product {
  @get page() {
    return <ProductApp />; // people: the interactive page
  }

  @get(isBot) crawlable() {
    return <ProductDetails />; // search engines and link previews: everything in the HTML
  }
}
```

- Variants are tried in declaration order, then the plain handler. No plain handler and no match is a 404.
- A test is any (possibly async) function of the request context, or a [createGuard](api:yerd.createGuard) guard.
- Variants combine with `@accepts`: `@get(isBot) @accepts("json")`.
- Prerendering has no request, so the plain handler is prerendered.
- [isBot](api:yerd.isBot) works inside any handler too: `if (isBot(ctx)) ...`.

> [!NOTE]
> `@get(beta)` is a **variant test**: when it fails, the next handler answers. `@get @beta` is a **gate**: when it fails, its result (a redirect, a 403) is the response.

### Caching: varies()

When a test reads a request header, build it with [varies](api:yerd.varies) so the route's responses carry `Vary: <header>` and caches keep one copy per value. `isBot` does this (`Vary: User-Agent`).

```tsx
import { get, route, varies } from "@toyz/yerd";

// This test reads the x-client header, and says so.
const fromApp = varies("x-client", (ctx) => ctx.headers["x-client"] === "app");

@route("/feed")
export class Feed {
  @get(fromApp) forApp() {
    return { items: [] }; // the mobile app gets JSON
  }

  @get page() {
    return <h1>Feed</h1>; // browsers get the page
  }
}
```
