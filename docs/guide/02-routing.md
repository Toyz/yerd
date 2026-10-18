# Routing

This page covers how URLs map to classes: paths, verbs, params, groups, layouts, guards and content negotiation.

## Routes and verbs

[`@route`](api:yerd.route) puts a class at a path. Verb decorators mark which method answers which HTTP method.

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

The verb decorators:

| Decorator | Handles |
| --- | --- |
| `@get` | GET, and HEAD automatically (same handler, no body sent) |
| `@post` / `@put` / `@patch` | POST / PUT / PATCH |
| `@del` | DELETE (`delete` is a reserved word) |
| `@head` / `@options` | HEAD / OPTIONS, when you want to handle them yourself |
| `@all` | Any method no other handler on the path claims |

A request for a path that exists with the wrong method gets a 405 with an `Allow` header listing what the path does support.

> [!NOTE]
> Verb decorators take no arguments: there is no `@get("/sub-path")`. One class is one path, so `/posts` and `/posts/:id` are two classes. This keeps every handler in a class sharing the same params and accessors.

Two handlers for the same verb on one path are a boot error, unless one of them uses `@accepts` (see [content negotiation](#content-negotiation)).

## Params

A `:name` segment captures one path segment; a `*name` segment at the end captures the rest of the path.

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

- Values are URL-decoded strings. Use a transform like [`toInt`](api:yerd.toInt) to convert them (see [request data](03-request-data.md)).
- Static segments win over params, whatever order you define routes in: `/users/new` beats `/users/:id`.
- A bare `*` is captured as `wildcard`. A splat also matches zero segments, so `/files/*path` matches `/files` with `path` set to `""`.
- `@param("nope")` on a route without `:nope` stops the app from booting, with an error naming the class and field.

## Groups

A [`@group`](api:yerd.group) is a class that holds shared settings: a path prefix, layouts, guards and metadata. Routes join it with the `group` option.

```tsx
import { HttpError, createGuard, get, group, route, type LayoutProps } from "@toyz/yerd";

const AdminLayout = ({ children }: LayoutProps) => <div class="admin">{children}</div>;
const staffOnly = createGuard("staffOnly", (ctx) => ctx.headers["x-staff"] === "yes" || new HttpError(403, "Staff only"));

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

The group's options:

| Option | What it does |
| --- | --- |
| `layout` | One layout or an array, outermost first, wrapping every member route. |
| `guards` | Guards run before every member route. |
| `meta` | Page metadata inherited by members; a route's own `meta` wins per key. |
| `group` | A parent group, for nesting. |
| `inheritLayouts` | `false` starts the layout chain fresh (see below). Default `true`. |

Groups nest: prefixes join, layouts nest outer to inner, meta merges with the deeper value winning, and guards run outer first.

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

> [!TIP]
> Want shared layouts or guards without a URL prefix? Use `@group("/", ...)`. Member routes keep their own paths.

For an area with its own document (an admin with its own `<head>` and styles), set `inheritLayouts: false`. The group's layouts replace the app's root layouts and any outer group's; inner groups still nest inside it.

```tsx
@group("/console", { layout: AdminDocument, inheritLayouts: false })
export class Console {}
```

`@layout(...)` and `@guards(...)` written on the group class itself work the same as the options.

## Layouts anywhere

[`@layout`](api:yerd.layout) adds layouts at the level you put it: on a route class (every handler), on a handler method (just that one), or on a group class.

```tsx
import { get, layout, route } from "@toyz/yerd";

@route("/about")
@layout(RootLayout, MarketingLayout, Hero)
export class About {
  @get page() {
    return <p>About us</p>;
  }
}

@route("/team")
@layout(MarketingLayout)
export class Team {
  @get @layout(Card) page() {
    return <p>team</p>; // Root > Marketing > Card
  }
}
```

The full chain, outermost first: app layouts (`app.layout()`), group layouts (outer group first), the route class's `@layout`, the method's `@layout`, then any layout picked in `res()`. Several layouts in one decorator, or stacked `@layout`s, read top to bottom, outermost first.

A layout that is already in the chain is not applied again. That is why `About` above can name `RootLayout` even though the app already applies it: you get one `<html>`, not two.

To make a layout the whole chain, with no app or group layouts, pass `{ inherit: false }`:

```tsx
@route("/report")
export class Report {
  @get @layout(PrintLayout, { inherit: false }) page() {
    return <p>numbers</p>; // just <pre>...</pre>, no root document
  }
}
```

You can also pick layouts at return time with [`res()`](api:yerd.res), which helps when the choice depends on data:

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

`res(node, { layout: PrintLayout, inherit: false })` replaces the chain for that one response. For a fragment with no layouts at all, put [`@noLayout`](api:yerd.noLayout) on the method. The [pages and layouts guide](05-pages-and-layouts.md) covers writing layouts and using `meta`.

## Guards

A guard runs before a handler and decides whether it runs. Make one with [`createGuard`](api:yerd.createGuard); the function gets the request context.

```tsx
import { HttpError, createGuard, get, guards, post, route } from "@toyz/yerd";

const businessHours = createGuard("businessHours", () => {
  const hour = new Date().getHours();
  return (hour >= 9 && hour < 17) || new HttpError(403, "Come back during business hours");
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

Guards go on the class (every handler and action in it) or on one method. On a method, write the guard as its own decorator next to the verb, `@post @signedIn open()`, or list several with `@guards(signedIn, businessHours)`. That works on `@action` methods too.

What a guard can return:

| Return | Effect |
| --- | --- |
| `true` or nothing | Continue to the next guard, then the handler. |
| `false` | 403 Forbidden. |
| A string | 303 redirect to that URL. |
| An `Error` (returned or thrown) | Handled like a thrown error, e.g. an `HttpError`'s status. |
| Anything else | Used as the response, like a handler's return value. |

A guard made with `createGuard` is itself a decorator (`@businessHours`) for a class or method. You can also list guards with [`@guards(a, b)`](api:yerd.guards), in a `guards: [...]` option on `@route` or `@group`, or for every route with `app.guard(...)`.

Guards run top to bottom, and the first one that doesn't continue decides the response:

1. App guards (`app.guard(...)`)
2. Group guards, outer group first
3. The route's `guards` option
4. Guards on the route class
5. Guards on the handler method

Stacked decorators run in the order written. Guards also run in front of [actions](06-interactivity.md). For login, roles and named guards backed by services, see [sessions and auth](09-sessions-and-auth.md).

## Content negotiation

One URL can serve HTML to browsers and JSON to API clients. Put [`@accepts`](api:yerd.accepts) on a second handler for the same verb:

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

`curl -H 'accept: application/json' /todos` gets JSON; a browser keeps getting the page. Shorthands are `html`, `json`, `ndjson`, `text`, `csv`, `xml` and `sse`, or pass a full mime type.

To branch inside one handler instead, return [`negotiate()`](api:yerd.negotiate). The first key is the default, and only the chosen function runs:

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

A bare `*/*` in the Accept header never beats the default (the handler without `@accepts`, or the first `negotiate()` key), so browsers get HTML. If every handler has `@accepts` and none fits, the response is 406. Negotiated responses get `Vary: Accept`.

## Variants per request: @get(when)

A verb decorator can take a test. That handler serves the requests the test accepts, and a plain `@get` on the same route serves everyone else. The classic use is SEO: give crawlers a complete, script-free page and people the interactive one.

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

- Variants are tried in the order they're declared; the first whose test passes wins, then the plain handler. With no plain handler and no match, the response is 404.
- A test is any function of the request context (it may be async), or a guard from [`createGuard`](api:yerd.createGuard): `@get(beta)`.

> [!NOTE]
> `@get(beta)` and `@get @beta` look alike but do different things. In the parentheses the guard is a **variant test**: when it fails, yerd moves on to the next handler, and nobody is turned away. As its own decorator it's a **gate**: when it fails, its result is the response (a redirect, a 403). Use the first to answer differently, the second to keep people out.
- Variants combine with `@accepts`: `@get(isBot) @accepts("json")` answers crawlers that ask for JSON.
- Prerendering has no request to test, so the plain handler is what gets prerendered.
- [`isBot`](api:yerd.isBot) also works on its own, inside any handler: `if (isBot(ctx)) ...`.

### Caching: varies()

A cache in front of your server (a CDN, the browser) keeps one copy per URL unless the response says otherwise, so it could serve the crawler page to people. When a test reads a request header, build it with [`varies`](api:yerd.varies) and every response from that route carries `Vary: <header>`, telling caches to keep one copy per value. `isBot` is built this way (`Vary: User-Agent`).

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

