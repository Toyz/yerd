# Routing

How URLs map to classes: paths, verbs, params, groups, layouts, guards, middleware and content negotiation.

## Routes and verbs

[`@route`](api:yerd.route) puts a class at a path; verb decorators mark which method answers which HTTP method.

```tsx
import { del, get, param, patch, post, put, res, route, toInt } from "@toyz/yerd";

const posts = [{ id: 1, title: "Hello" }];

@route("/posts")
export class Posts {
  @get list() {
    return { posts };
  }

  @post create() {
    return res({ id: 2 }, { status: 201 });
  }
}

@route("/posts/:id")
export class PostPage {
  @param("id", { transform: toInt }) accessor id!: number;

  @get show() {
    return posts.find((p) => p.id === this.id) ?? 404;
  }

  @put replace() { return 204; }
  @patch update() { return 204; }
  @del remove() { return 204; }
}
```

| Decorator | Handles |
| --- | --- |
| `@get` | GET, and HEAD automatically (same handler, no body sent) |
| `@post` / `@put` / `@patch` | POST / PUT / PATCH |
| `@del` | DELETE (`delete` is a reserved word) |
| `@head` / `@options` | HEAD / OPTIONS, when you want to handle them yourself |
| `@all` | Any method no other handler on the path claims |

- A known path with the wrong method gets a 405 with an `Allow` header.
- Verb decorators take no path: one class is one path, so `/posts` and `/posts/:id` are two classes sharing nothing but what you share.
- Two handlers for one verb on one path are a boot error, unless one uses `@accepts` (see [content negotiation](#content-negotiation)) or a [variant test](#variants-per-request-getwhen).

## Params

A `:name` segment captures one path segment; a trailing `*name` captures the rest.

```tsx
import { get, param, params, route } from "@toyz/yerd";

@route("/files/*path")
export class Files {
  @param("path") accessor path!: string;
  @params accessor all!: Record<string, string>;

  @get show() {
    return `you asked for ${this.path}`; // /files/a/b.txt -> "a/b.txt"
  }
}
```

- Values are URL-decoded strings; convert them with a transform like [`toInt`](api:yerd.toInt) (see [request data](03-request-data.md)).
- Static segments win over params regardless of definition order: `/users/new` beats `/users/:id`.
- A bare `*` is captured as `wildcard`. A splat also matches zero segments (`/files` gives `path` = `""`).
- `@param("nope")` on a route without `:nope` stops the boot, naming the class and field.

## Groups

A [`@group`](api:yerd.group) class holds shared settings (path prefix, layouts, guards, metadata); routes join with the `group` option.

```tsx
import { Forbidden, createGuard, get, group, route, type LayoutProps } from "@toyz/yerd";

const AdminLayout = ({ children }: LayoutProps) => <div class="admin">{children}</div>;
const staffOnly = createGuard("staffOnly", (ctx) => ctx.headers["x-staff"] === "yes" || new Forbidden("Staff only"));

@group("/admin", { layout: AdminLayout, guards: [staffOnly], meta: { section: "admin" } })
export class Admin {}

@route("/users", { group: Admin, meta: { title: "Users" } })
export class AdminUsers {
  @get list() {
    return <h1>Users</h1>; // GET /admin/users
  }
}

@route("/", { group: Admin })
export class AdminHome {
  @get page() {
    return <h1>Admin</h1>; // GET /admin
  }
}
```

| Option | What it does |
| --- | --- |
| `layout` | One layout or an array, outermost first, wrapping every member route. |
| `guards` | Guards run before every member route. |
| `meta` | Page metadata inherited by members; a route's own `meta` wins per key. |
| `group` | A parent group, for nesting. |
| `inheritLayouts` | `false` starts the layout chain fresh (see below). Default `true`. |
| `session` | `false`: member routes have no session (see [routes without a session](09-sessions-and-auth.md#routes-without-a-session)). `@route` takes it too. |

Groups nest: prefixes join, layouts nest outer to inner, meta merges (deeper wins), guards run outer first, and the deepest `session` wins.

```tsx
import { get, group, route, type LayoutProps } from "@toyz/yerd";
import { Admin } from "./admin.js";

const ReportsNav = ({ children }: LayoutProps) => <section class="reports">{children}</section>;

@group("/reports", { group: Admin, layout: ReportsNav })
export class Reports {}

@route("/q3", { group: Reports })
export class Q3 {
  @get page() {
    return <h1>Q3</h1>; // GET /admin/reports/q3, in AdminLayout > ReportsNav
  }
}
```

- `@group("/", ...)` shares layouts or guards without a URL prefix.
- `inheritLayouts: false` gives an area its own document: the group's layouts replace the app's and outer groups', and inner groups still nest inside. Example: `@group("/console", { layout: AdminDocument, inheritLayouts: false })`.
- `@layout(...)` and `@guards(...)` on the group class work like the options.

## Layouts anywhere

[`@layout`](api:yerd.layout) adds layouts on a route class (every handler), a handler method, or a group class; examples are in [nested layouts](05-pages-and-layouts.md#nested-layouts).

- The chain, outermost first: `app.layout()`, group layouts (outer first), the class's `@layout`, the method's `@layout`, then any layout picked in `res()`.
- Several layouts in one decorator (`@layout(RootLayout, MarketingLayout)`), or stacked `@layout`s, read top to bottom.
- A layout already in the chain isn't applied again, so naming `RootLayout` twice still gives one `<html>`.
- `{ inherit: false }` makes a layout the whole chain; [`@noLayout`](api:yerd.noLayout) drops all of them.

Pick layouts at return time with [`res()`](api:yerd.res) when the choice depends on data:

```tsx
import { get, param, res, route } from "@toyz/yerd";

@route("/orders/:id")
export class Order {
  @param("id") accessor id!: string;

  @get show() {
    return res(<p>Order {this.id}</p>, { layout: ReceiptLayout });
  }
}
```

`res(node, { layout: PrintLayout, inherit: false })` replaces the chain for that response. Writing layouts and using `meta` is in [pages and layouts](05-pages-and-layouts.md).

## Guards

A guard runs before a handler and decides whether it runs. Make one with [`createGuard`](api:yerd.createGuard); the function gets the request context.

```tsx
import { Forbidden, createGuard, get, guards, post, route } from "@toyz/yerd";

const businessHours = createGuard("businessHours", () => {
  const hour = new Date().getHours();
  return (hour >= 9 && hour < 17) || new Forbidden("Come back during business hours");
});

const signedIn = createGuard("signedIn", (ctx) =>
  ctx.cookies.sid ? true : `/login?next=${encodeURIComponent(ctx.path)}`,
);

@route("/support")
@businessHours
export class Support {
  @get page() {
    return <h1>Support</h1>;
  }

  @post @guards(signedIn) open() {
    return 201;
  }
}
```

| Return | Effect |
| --- | --- |
| `true` or nothing | Continue to the next guard, then the handler. |
| `false` | 403 Forbidden. |
| A string | 303 redirect to that URL. |
| An `Error` (returned or thrown) | Handled like a thrown error, e.g. a `YerdError`'s status. |
| Anything else | Used as the response, like a handler's return value. |

- A `createGuard` guard is a decorator for a class (every handler and action) or method (`@post @signedIn open()`, `@action` methods too).
- Also attach guards with [`@guards(a, b)`](api:yerd.guards), a `guards: [...]` option on `@route` or `@group`, or `app.guard(...)` for every route.
- Order: app guards, group guards (outer first), the route's `guards` option, class guards, method guards; stacked decorators in written order. The first that doesn't continue decides.
- Guards also run in front of [actions](06-interactivity.md). Login, roles and named guards backed by services are in [sessions and auth](09-sessions-and-auth.md#guards).

## Middleware

Middleware wraps the whole request: it runs before the guards, calls `next()` for everything after, and sees the response on its way out. Register it with `app.use()`.

```ts
import { yerd, type Middleware } from "@toyz/yerd";

/** How long the app took, as a Server-Timing header (browser dev tools show it under Timing). */
const timing: Middleware = async (ctx, next) => {
  const started = performance.now();
  const out = await next();
  out.headers["server-timing"] = `app;dur=${(performance.now() - started).toFixed(1)};desc="${ctx.route.className}"`;
  return out;
};

export const app = yerd().use(timing);
```

- `next()` resolves to the response (`status`, lowercase `headers`, `body`, `cookies`); change it and return it.
- Several run in `use()` order, the first outermost.
- Only requests that matched a route reach it: not 404s, 405s, static files or refused cross-site posts.
- `currentContext()`, `resolve()` and `ctx.session` work.
- Handler errors come out of `next()`, so `try`/`catch` sees them. A throw from the middleware itself goes through `@catches`, `app.onError`, then the error page.
- To turn a request away, prefer a guard; middleware can throw an [`YerdError`](api:yerd.YerdError).
- `app.use()` also takes anything with a `middleware` function, which is how [`createAuth`](09-sessions-and-auth.md#sign-in-with-createauth) plugs in.

## Content negotiation

Serve HTML to browsers and JSON to API clients from one URL by putting [`@accepts`](api:yerd.accepts) on a second handler for the verb:

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

Shorthands are `html`, `json`, `ndjson`, `text`, `csv`, `xml` and `sse`, or pass a full mime type. To branch inside one handler, return [`negotiate()`](api:yerd.negotiate); the first key is the default and only the chosen function runs:

```tsx
import { get, negotiate, param, route } from "@toyz/yerd";

@route("/todos/:id")
export class TodoOne {
  @param("id") accessor id!: string;

  @get show() {
    const todo = { id: this.id, title: "milk" };
    return negotiate({
      html: () => <h1>{todo.title}</h1>,
      json: () => todo,
    });
  }
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
- A test is any (possibly async) function of the request context, or a [`createGuard`](api:yerd.createGuard) guard.
- Variants combine with `@accepts`: `@get(isBot) @accepts("json")`.
- Prerendering has no request, so the plain handler is prerendered.
- [`isBot`](api:yerd.isBot) works inside any handler too: `if (isBot(ctx)) ...`.

> [!NOTE]
> `@get(beta)` is a **variant test**: when it fails, the next handler answers. `@get @beta` is a **gate**: when it fails, its result (a redirect, a 403) is the response.

### Caching: varies()

When a test reads a request header, build it with [`varies`](api:yerd.varies) so the route's responses carry `Vary: <header>` and caches keep one copy per value. `isBot` does this (`Vary: User-Agent`).

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
