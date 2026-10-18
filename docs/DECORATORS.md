# yerd decorator kit: make your own `@user`

yerd's core only understands routes, verbs, DI and responses. Everything else
(`@param`, `@query`, `@body`, `@session`, `@auth.user`, `auth.required`,
`auth.role()`, later `@status` and `@cache`) is a decorator built with the
**public** kit described here. The built-ins get no private hooks.

**Status (2026-10-17):** `createAccessor`, `@args` and `createGuard` are
built. `createWrapper`, `createMeta`, `compose`, `defineDecorator` and the
isomorphic `@toyz/yerd/kit` are still design; their sections below say so.

**The rule:** if a built-in decorator needs something the kit doesn't expose,
the kit is missing a feature. Fix the kit, don't special-case the built-in.

So yerd doesn't need to understand users. You write `@user` yourself in a few
lines, or import the one in `@toyz/yerd/auth`, which is written the same way.

## The four factories

| Factory                | Makes                  | Examples                                      |
|------------------------|------------------------|-----------------------------------------------|
| `createAccessor`       | accessor decorators that read per-request values | `@auth.user`, `@tenant`, `@locale`, `@param` |
| `createGuard`          | class/method gate, returns `true` or a response | `auth.required`, `auth.role()`, `@feature` |
| `createWrapper` (planned) | around-advice for any method, onion order | `@instrument`, `@cache`, `@timed`, `@transaction`, `@rateLimit` |
| `createMeta` (planned) | pure metadata markers other decorators read | `@public`, `@audit("billing")`      |

Plus `compose(...)` to bundle decorators, and the low-level `defineDecorator`
from PLAN.md for anything the four don't cover (both planned).

## Writing `@user` yourself

```ts
// src/decorators.ts
import { createAccessor, createGuard, resolve, HttpError, type YerdContext } from "@toyz/yerd";
import { Users, type User } from "./users.js";

// one lookup per request, shared by the accessor and the guards
function currentUser(ctx: YerdContext): Promise<User | undefined> {
  let found = ctx.memo.get(currentUser) as Promise<User | undefined> | undefined;
  if (!found) {
    const id = ctx.session.get("userId");
    ctx.memo.set(currentUser, (found = id ? resolve(Users).find(id) : Promise.resolve(undefined)));
  }
  return found;
}

// accessor: an async resolver, so the field holds a promise
export const user = createAccessor((ctx) => currentUser(ctx), { name: "user" });

// guard: true to continue, a string redirects, anything else is the response
export const authenticated = createGuard("authenticated", async (ctx) =>
  (await currentUser(ctx)) ? true : `/login?next=${encodeURIComponent(ctx.path)}`,
);

// guard with arguments: a function that makes a guard
export const roles = (...names: string[]) =>
  createGuard(`roles(${names.join(", ")})`, async (ctx) => {
    const me = await currentUser(ctx);
    return (me !== undefined && names.some((n) => me.roles.includes(n))) || new HttpError(403);
  });
```

```tsx
@route("/admin")
@authenticated
@roles("admin")                                   // runs after authenticated: top to bottom
export class Admin {
  @user accessor me!: Promise<User | undefined>;

  @get async index() {
    return <Dashboard user={(await this.me)!} />;
  }
}
```

Nothing above is special. `@toyz/yerd/auth` is the same idea (it loads the
user in a middleware instead, so `@auth.user` is a plain value).

## `createAccessor`

```ts
createAccessor<T, A extends unknown[] = []>(
  resolve: (ctx: YerdContext, ...args: A) => T,           // T may be a promise
  opts?: { name?: string; validate?: (route: RouteInfo, ...args: A) => string | void },
): (...args: A) => AccessorDecorator<T>   // or a bare decorator when A is empty
```

- **Typed against the field.** If the field's type can't hold the resolver's
  value, the decorator is a compile error at the use site, so
  `@user accessor me!: Admin` fails when the resolver returns `User | undefined`.
- **`undefined` falls back to the initializer:** `@query("tab") accessor tab = "posts"`.
- **Arguments.** `createAccessor((ctx, name: string) => ctx.headers[name])`
  gives `@header("x-request-id")`. That's literally how `@header`, `@param`,
  `@query` and `@cookie` are defined.
- **Memoized per request.** Each accessor-with-args pair resolves once per
  request, cached in the request context, no matter how many classes read it.
- **Works in every lifetime.** Values live in the request context, not on the
  instance, so the same `@user` works on scoped routes, singleton routes,
  services and class components.

**Async resolvers are promises.** A resolver may return a promise (`@body`,
`@field`, a user's `@user` that hits the database). The field then holds that
promise: created on first read, shared for the rest of the request, and never
created at all if nothing reads it. So a GET handler on a class with a `@body`
field never touches the body.

```ts
@body({ transform: parseSignup, required: true }) accessor signup!: Promise<Signup>;
@post async create() { const s = await this.signup; ... }
```

(An earlier design pre-resolved async accessors before the handler by walking
the route's `@inject` graph. Promise-valued fields replaced it: no graph walk,
no "read before loaded" failure, and it works the same in services and
components.)

### `@args`: decorators for method parameters

TC39 has no parameter decorators, so `update(@body() x)` can't exist. `@args`
takes the same resolvers on the method instead, awaits any promises, and passes
the values as arguments. The method's parameter types are checked against the
resolvers' output types.

```ts
@patch
@args(param("id", { transform: toInt }), body({ transform: parsePatch, required: true }))
update(id: number, patch: Patch) { ... }
```

Every decorator `createAccessor` makes carries its resolver, so user-made
accessors work in `@args` with no extra code.

## `createGuard`

```ts
createGuard(label: string, run: (ctx: YerdContext) => GuardResult | Promise<GuardResult>): GuardRef
```

- The `GuardRef` is a class or method decorator (`@businessHours`) and also a
  value for `guards: [...]` on routes and groups, `@guards(...)` and
  `app.guard(...)`. `label` names it in messages.
- No extra arguments: for a guard with parameters, write a function that
  returns one (`roles("admin")` above, `auth.role("admin")`).
- Result `true` (or nothing) continues. A string redirects there (303), for
  loom parity; `false` is `403`; an `Error`, thrown or returned
  (`ok || new HttpError(403)`), is thrown. Anything else goes through the
  normal coercion table as the response (`redirect()`, a number, JSX). Same
  rules for every guard, named or kit-made.
- Order: app-wide guards (`app.guard()`), then the group chain outer to inner,
  then the route's `guards` option, then class decorators, then method
  decorators. Stacked guard decorators run top to bottom as written.
- On a class, guards cover its verb handlers and its `@action` methods. An
  action runs behind the class's guards plus its own method guards (not the
  verb methods' guards).
- The loom-style named guards from PLAN.md (`@guard("auth")` on a service
  method, applied with `guards: [...]` or `@guards("auth")`) follow the same
  result rules. Only the app's own services count: a `@guard` class outside
  them is ignored unless referenced, which is a boot error with a hint. A
  `@guard` on a base class works through a registered subclass.

## `createWrapper` (planned)

```ts
createWrapper((ctx: YerdContext, next: () => unknown, ...args: A) => unknown)
```

Around-advice for **any method on any class**: route handlers, actions, service
methods, class components, island methods. On a route handler, `next()` gives
the **raw return value** (before coercion), so it can cache it, time it, retry
it or replace it. Elsewhere it's whatever the method returns.

`ctx.call` describes the invocation being wrapped:

| `ctx.call.`   | Is                                                          |
|---------------|-------------------------------------------------------------|
| `target`      | the instance (`this`)                                       |
| `className`   | `"UserRepo"`                                                |
| `method`      | `"find"`                                                    |
| `args`        | the actual arguments, mutable before `next()`               |
| `paramNames`  | `["id", "opts"]`, parsed once from the compiled method source (`fn.toString()`), destructured params become `arg0`, `arg1` |
| `async`       | whether the method returned a promise                       |

Outside a request (boot hooks, scripts, timers), `ctx.inRequest` is `false` and
the request members (`params`, `session`, ...) throw if touched. `ctx.get` and
`ctx.call` still work.

A sync method stays sync: if the wrapper doesn't await, `next()` is called and
returned directly, so wrapping a sync service method doesn't turn it into a
promise.

```ts
export const timed = createWrapper(async (ctx, next) => {
  const t = performance.now();
  try { return await next(); }
  finally { ctx.setHeader("server-timing", `handler;dur=${performance.now() - t}`); }
});

export const transaction = createWrapper(async (ctx, next) =>
  ctx.get(Db).transaction(() => next()),
);

export const cache = createWrapper(async (ctx, next, ttl: string) => {
  const store = ctx.get(Cache);
  const key = `${ctx.method} ${ctx.url}`;
  return (await store.get(key)) ?? store.set(key, await next(), ttl);
});
```

Onion order matches decorator order on the page: the topmost wrapper is outermost.

The biggest built-in wrapper is `@instrument`, yerd's Rust-`tracing`-style span
decorator: it reads `ctx.call.args` and `ctx.call.paramNames` to log arguments
as fields, times the call, and logs to whatever `ILogger` is in DI. See
[LOGGING.md](LOGGING.md).

## `createMeta` (planned)

```ts
const audit = createMeta<string>("audit");
@audit("billing") @post charge() { ... }

// anywhere with a ctx:
ctx.route.meta(audit)   // "billing" | undefined, typed
```

Metadata markers do nothing on their own. They exist for other decorators and
app-wide hooks to read, the way loom's route `meta` reaches guards.

## App-wide decorators

Guards and wrappers can apply to every route, with metadata for opting out:

```ts
yerd()
  .guard(createGuard("login", async (ctx) =>
    ctx.route.meta(publicRoute) || (await currentUser(ctx)) ? true : "/login",
  ))
  .use(timed)
  .listen(3000);
```

`@publicRoute` on the login page and the static assets route, and the whole app
requires a login by default. (`app.guard()` exists today; `ctx.route.meta()`,
`createMeta` and wrappers in `app.use()` are planned. `app.use()` takes
middleware, `(ctx, next) => Promise<Outgoing>`, which wraps guards and the
handler.)

## `YerdContext`: what a decorator can see

| Member                        | Is                                                  |
|-------------------------------|-----------------------------------------------------|
| `request` `method` `path` `url` | the request                                       |
| `params` `query` `headers` `cookies` | parsed request data                          |
| `body()` / `lines()`          | parsed body, cached / NDJSON body as a stream (one or the other) |
| `session`                     | session; throws unless `app.sessions()` is configured |
| `signal`                      | aborts on client disconnect or shutdown             |
| `memo`                        | per-request `Map` for memoized values               |
| `meta`                        | page meta for layouts (`setMeta()` adds to it)      |
| `prerendering`                | true while a `@prerender` route renders at build time (request data throws) |
| `route`                       | `RouteInfo`: `pattern`, `paramNames`, `className`   |
| `requestId`                   | the request's id (access log, `x-request-id`)       |
| `setHeader(k, v)` `setCookie(name, value, opts?)` `deleteCookie(name)` `status(code)` | response defaults from inside a handler, guard or middleware |

DI in a guard or resolver is `resolve(Key)`, which reads the same request
scope. Planned: `ctx.get(Key)`, `ctx.resolve(accessor)`, a typed `state` bag,
and `route.meta(key)`.

Same object everywhere: decorators, guards, middleware, `currentContext()` in
function components. One context, one ALS lookup.

## Boot-time validation for custom decorators

`createAccessor` takes an optional `validate(route, ...args)` that runs at
boot for every route class using the accessor (and every `@args` use).
Returning a string refuses to boot with that message, the decorator name,
class and member; returning nothing passes. Problems are collected and
reported together in one `BootError`. Built-ins use it the same way:

```ts
export const param = createAccessor(
  (ctx, name: string) => ctx.params[name],
  { name: "param", validate: (route, name) => route.paramNames.includes(name) ? undefined : `:${name} is not a parameter of ${route.pattern}` },
);
```

## `compose` (planned)

```ts
const adminApi = compose(authenticated, roles("admin"), timed, publicRoute.not());
```

Returns one decorator that applies the others in order. Works for class and
method targets; each part is applied only where its kind allows (a `createMeta`
is fine anywhere, a verb decorator isn't something you'd put in a preset).

## One kit, both sides (planned)

The kit is isomorphic. It lives in `@toyz/yerd/kit`, which imports nothing from
Node, and resolves through package `exports` conditions on the server and the
import map in the browser (same mechanism as `@toyz/yerd/client`, see DYNAMICS.md).
The same decorator can sit on a route class and on an island, and does the right
thing in each place.

`YerdContext` has a shared surface (`url`, `path`, `params`, `query`,
`cookies`, `state`, `get`, `resolve`, `route`) implemented twice: by the request
on the server, and by the page and island on the client. A resolver that only
touches the shared surface runs natively on both sides with no extra work.

### Every decorator is one of four kinds

| Kind            | Server                          | Browser (islands)                                   |
|-----------------|---------------------------------|-----------------------------------------------------|
| **isomorphic**  | resolves from the request       | resolves from the page, often **reactive**          |
| **carried**     | resolves, then serializes a projection into the island | reads the carried value          |
| **server-only** | works                           | boot error if an island uses it                     |
| **client-only** | SSR gets the initial value, no behaviour | works                                      |

### Where the built-ins land

| Decorator                              | Kind        | In the browser                                        |
|----------------------------------------|-------------|-------------------------------------------------------|
| `@param(name)`                         | isomorphic  | from the island's route pattern + `location`          |
| `@query(name, { sync? })`              | isomorphic  | reactive; updates on `popstate`/boost; with `sync`, writing it writes the URL (loom's query sync) |
| `@cookie(name)`                        | isomorphic  | non-`HttpOnly` cookies only; boot error for names configured `HttpOnly` |
| `createMeta` markers                   | isomorphic  | readable via `ctx.route.meta` / island metadata       |
| `@timed` `@debounce(ms)` `@throttle(ms)` `@retry(n)` | isomorphic wrappers | wrap island methods             |
| `@service` `@inject` `@maybe`          | isomorphic  | client container: singleton = per page, scoped = per island, transient = per resolution. Shared stores across islands. |
| `@user` (from `@toyz/yerd/auth`)             | carried     | projection set by `auth({ toClient })`                |
| `@session`                             | carried     | only what `session.carry(fn)` projects; never the raw session |
| `@flash(key)`                          | carried     | consumed on the server, delivered once to the island  |
| `@body` `@request` `@response` `@setHeader` `@status` | server-only | n/a                            |
| route guards (`createGuard` on routes) | server-only | n/a (see client guards below)                         |
| `@state`                               | client-only | trace cell, reactive                                  |
| `@persisted(key)`                      | client-only | `localStorage`-backed cell, SSR uses the default      |
| `@media(query)` `@online` `@visible`   | client-only | reactive browser state, SSR uses a declared fallback  |
| `@interval(ms)` `@hotkey(combo)`       | client-only | lifecycle-managed, cleaned up when the island unmounts |

### Carried accessors: server values in islands, safely

Some values only exist on the server: the current user, the session, a feature
flag lookup. A carried accessor resolves on the server during SSR and writes a
**projection** into the island's payload:

```html
<yerd-island data-src="/_yerd/m/components/cart.js" data-name="Cart"
             data-props='{"onCheckout":{"$a":"checkout..sig"}}'
             data-carry='{"user":{"id":7,"name":"ada"},"session.cart":[3,9]}'>
```

Projections are mandatory and explicit, so a server object never gets dumped
into HTML whole (no password hashes in `data-carry`):

```ts
// src/decorators.ts -- isomorphic file, safe for islands to import
export const user = defineAccessor<User | null>("user");
export const clientUser = user.carry((u) => u && { id: u.id, name: u.name, roles: u.roles });
//    ^ AccessorDecorator<{ id: number; name: string; roles: string[] } | null>
```

```ts
// src/server/providers.ts -- server-only file, islands never import it
provide(user, async (ctx) => {
  const id = ctx.session.get("userId");
  return id ? ctx.get(Users).find(id) : null;
});
```

```tsx
@island
export class Cart {
  @clientUser accessor me!: { id: number; name: string } | null; // typed by the projection
  @inject(CartStore) accessor cart!: CartStore;                    // client-side singleton
  render() { return <p>{this.me?.name ?? "guest"}: {this.cart.count} items</p>; }
}
```

**Why the split into `defineAccessor` + `provide`:** the island imports
`decorators.js`. If the resolver lived there, it would import `Users` and the
database, and the client graph check would (correctly) refuse to boot. The
declaration is a typed key, like a DI token; the server implementation is
registered from a file islands never touch. The one-step `createAccessor(fn)`
is still there for resolvers that only use the shared context surface.

**Rules:**
- The projection's return type must be `Json`, checked by the compiler.
- An island using a server-only accessor, or a declared accessor with no
  `.carry()`, fails boot with the island, field and accessor named.
- Carried values are snapshots from render time. They refresh when the island is
  re-rendered by a server response (action region swap, boost navigation).
- Carried data is visible to the user in page source. Treat projections as
  public output, because they are.

### Client guards are UX, not security

`createGuard` works on island methods too: `@roles("admin") deleteAll()` checks
the carried user in the browser and turns the call into a no-op (with an
optional `onDenied`). It exists so buttons can fail fast and look right. The
server action it calls is still guarded on the server; a client guard never
replaces that.

### Writing client-only decorators

Same factories, plus two island-specific ones from `@toyz/yerd/kit`:

- `createState(init, { subscribe? })`: a trace cell with optional external
  source. `@persisted`, `@media`, `@online` are each a few lines on top of it.
- `createEffect(fn)`: runs on island mount, returns cleanup run on unmount.
  `@interval`, `@hotkey`, `@visible` are built on it (loom's connect/disconnect
  hook pattern from `createDecorator`).

`@state` itself is `createState` with no source. Same rule as the server: no
built-in gets a private hook.

## What this changes in the rest of the plan

- `@param`, `@query`, `@header`, `@cookie`, `@body`, `@request`, `@session` are
  built with `createAccessor`. `@status` and `@setHeader` will be `createMeta`.
  Named `@guard`s and `createGuard` values share one guard pipeline and result
  rules.
- Auth moves to the optional `@toyz/yerd/auth` subpath, written only with this kit.
  Use it, fork it, or ignore it and write your own `@user` as above.
- Sessions stay in core (they need cookie crypto and the response pipeline), but
  are exposed as `ctx.session` so user-made decorators can build on them.
- The kit is isomorphic (`@toyz/yerd/kit`), so DYNAMICS.md's island `@state`, `@prop`
  and DI are the client half of the same system, not a separate one. Island
  payloads gain a `data-carry` attribute.
- The M7 "user-land decorators showcase" (`@cache`, `@rateLimit`, `@timed`)
  becomes the kit's examples and tests.
