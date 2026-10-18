# Sessions and auth

The shop remembers a cart without an account, signs people in without losing it, and keeps checkout for the signed in.

## Turn sessions on

Visitors need a cart before they have an account. Call `app.sessions()`; then any route reads and writes the session through [@session](api:yerd.session).

```ts
// src/app.ts
export function createApp(options?: YerdOptions) {
  return yerd(options).layout(RootLayout).errorPage(ErrorPage).sessions().use(auth);
}
```

- `@session accessor session!: Session` is the plain session (checkout uses it for flash messages); `Session<{ coupon?: string }>` types its keys.
- Assign to save, assign `undefined` (or `delete`) to remove. In-place changes (`push`, nested edits) are saved too. `get(key)` / `set(key, value)` do the same by name.

### A class for methods and defaults

The cart is a class: pass it to `@session` and the session gets its methods and getters, with field initializers as defaults.

```ts
// src/cart.ts
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

// src/routes/products.tsx, in ProductPage
@session(Cart) accessor cart!: Session<Cart>;
// add(): this.cart.add(product.id);
```

A visitor gets no cookie until the cart changes:

```answer
GET /products/7
200 OK
content-type: text/html; charset=utf-8

<!doctype html><!-- ... --><a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">0</span></a><!-- ... -->
---
POST /products/7
_yx=(the form's token)
>>>
200 OK
content-type: text/html; charset=utf-8
set-cookie: yerd_session=5MJHr9ws...; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax

<a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">1</span></a><!-- ... -->
```

- A missing value reads as its default, which is only saved once it changes. `this.cart.lines` is never `undefined`.
- Only data fields are stored: keep them JSON. The constructor takes no arguments; no `#private` fields, since `this` is the session.
- A member named like a session method (`clear`, `flash`, `get`, ...) is refused on first use: the cart's `empty()` isn't called `clear()`.
- Views share one session: routes may use different shapes, with distinct field names. `@args(session(Cart))` gives a handler parameter the view.

> [!TAKE]
> The session is a sealed cookie by default: no store to run, any number of instances, and nothing to clean up. The cart holds ids and quantities, never prices, so it stays small. You give up revoking a session early and anything over ~4 KB; a [store](#which-store) gets you both.

### Outside a route: session.as()

The header shows the cart's count on every page, from the layout. Code outside a route class (layouts, components, auth hooks) gets the plain session; [`session.as(Shape)`](api:yerd.Session) gives it the typed view:

```tsx
// src/layouts.tsx
/** Items in the visitor's cart; 0 on routes without a session (the API, the stock feed). */
function cartCount(): number {
  const ctx = currentContext();
  return ctx.route.session === false ? 0 : ctx.session.as(Cart).count;
}
```

```answer
GET /
200 OK
content-type: text/html; charset=utf-8

<!doctype html><!-- ... --><header class="top"><a class="brand" href="/">Paperyard</a><a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">1</span></a><a class="account" href="/login">Sign in</a></header><!-- ... -->
```

- `as(Shape)` includes methods and defaults; `as<T>()` is a type-only view, like `Session<T>`.
- `as(Cart)` here and `@session(Cart)` in a route change the same `lines`.

### App-wide keys

For the few keys every page reads (a theme, say), declare them on the global `SessionData` interface; plain `Session` and `currentContext().session` are typed by it.

```ts
declare module "@toyz/yerd" {
  interface SessionData {
    theme?: "light" | "dark";
  }
}
```

Keep it to a handful; feature data belongs in a shape class.

## The session API

| Method | Does |
| --- | --- |
| `session.key` / `session.key = value` | read and write a value (`undefined` removes it) |
| `get(key)` / `set(key, value)` | the same, by name |
| `delete(key)` / `clear()` | remove one value / all of them (`clear` also drops sign-in and the CSRF nonce, so open forms stop working) |
| `flash(key, value)` | keep a value for the next request that uses the session (sign-in's error message after a redirect) |
| `flash(key)` | read and consume that value |
| `regenerate()` | new session id and CSRF nonce, same data; `auth.login()` does it |
| `destroy()` | drop the session and cookie; a later write starts a fresh one |
| `isNew`, `createdAt` | whether the request arrived without a session; when it was created |

- The session opens on first use (`ctx.session`, `@session`, auth middleware, an action). A request that never uses it doesn't refresh it or consume a flash.
- Changes are saved after the handler runs; an unchanged session sends no cookie unless a rolling refresh is due.
- An unhandled crash (anything but a `YerdError`) saves nothing, so a half-finished login never sticks.
- HTML sent to someone with a session isn't cacheable by others (see [caching headers](04-responses.md#caching-headers)).

> [!NOTE]
> Rendering action forms never starts a session, so pages with forms stay cacheable for first-time visitors. See [action tokens](15-security.md#action-tokens).

## Routes without a session

The JSON API and the stock feed have no use for a cart. `session: false` on a route or group means the session is never opened or saved there, whatever cookie arrives:

```ts
// src/routes/api.ts
@route("/api/products/:id", { session: false })
export class ProductApi {
  // ...
}
```

Sent with the cart's cookie, the API answers without one:

```answer
GET /api/products/7
200 OK
content-type: application/json; charset=utf-8

{"id":7,"name":"Field notebook","category":"notebooks","price":2400,"stock":12,"description":"Waterproof paper for notes in the rain."}
```

- A route's setting wins over its group's. No store read, no `Set-Cookie`.
- `ctx.session` throws and a `@session` field refuses to boot. Layouts and error pages for the route can't read it either: hence `cartCount()`'s check.
- Auth sees nobody signed in (`auth.required` turns requests away), and the route's action tokens aren't session-bound.

## Stores and options

The default [CookieStore](api:yerd.CookieStore) keeps the data in the cookie, sealed with AES-256-GCM (no server state, ~4 KB limit). [MemoryStore](api:yerd.MemoryStore) keeps data in the process and only an id in the cookie.

```ts
import { MemoryStore, yerd } from "@toyz/yerd";

export const app = yerd().sessions({
  store: new MemoryStore({ maxSize: 10_000, sweepInterval: 60_000 }),
  maxAge: 2 * 60 * 60 * 1000, // two hours idle
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `store` | `new CookieStore()` | where the data lives |
| `maxAge` | 14 days | idle lifetime in ms |
| `absoluteMaxAge` | 30 days | lifetime from creation in ms, never extended |
| `rolling` | `true` | refresh the idle expiry on requests that use the session |
| `cookieName` | `"yerd_session"` | cookie name (gets a `__Host-` prefix over HTTPS) |
| `secure` | auto | force the `Secure` flag; by default on over HTTPS |
| `trustProxy` | the app's `trustProxy` | believe `X-Forwarded-Proto` when detecting HTTPS |
| `generateId` | 32 random bytes | the id for a new or regenerated session ([below](#custom-session-ids)) |

- Cookies are always `HttpOnly`, `SameSite=Lax` and `Path=/`.
- The session cookie is sealed under its own key, separate from [seal()](api:yerd.seal).

### MemoryStore

For dev, tests and single-process deploys. `maxSize` evicts the least recently saved past it (default no cap); `sweepInterval` is how often a save may also clear expired sessions (default 60 s). Sessions survive Vite dev reloads; give two stores in one app different `name`s.

### Which store

| Store | Good for | Watch out for |
| --- | --- | --- |
| `CookieStore` (default) | small sessions, any number of instances, no infrastructure | ~4 KB sealed (bigger is a 500); can't revoke a session before it expires |
| `MemoryStore` | dev, tests, one process | lost on restart; per instance |
| your own `SessionStore` | several instances, big sessions, "sign out everywhere" | one lookup per request carrying a session cookie, unless the store is `sync` |

### Your own store

A store is three methods over any key-value database (`Kv` stands for your Redis client or similar):

```ts
// src/session-store.ts
import { createHash } from "node:crypto";
import type { SessionRecord, SessionStore } from "@toyz/yerd";

export class KvSessionStore implements SessionStore {
  readonly kind = "id";
  constructor(private readonly kv: Kv) {}

  // Keyed by a hash of the id, so a dump of the database can't be replayed as cookies.
  #key(id: string): string {
    return `session:${createHash("sha256").update(id).digest("base64url")}`;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const raw = await this.kv.get(this.#key(id));
    return raw ? (JSON.parse(raw) as SessionRecord) : undefined;
  }

  async set(id: string, record: SessionRecord, ttlMs: number): Promise<void> {
    await this.kv.set(this.#key(id), JSON.stringify(record), { px: Math.max(1, Math.round(ttlMs)) });
  }

  async destroy(id: string): Promise<void> {
    await this.kv.del(this.#key(id));
  }
}

// src/app.ts
yerd().sessions({ store: new KvSessionStore(kv) }); // kv: your connected client
```

- `get` returns `undefined` for an unknown or expired id.
- `set` replaces the whole JSON-safe record; `ttlMs` is the idle `maxAge` capped by `absoluteMaxAge`, so let the database expire it.
- `destroy` runs on logout and when the id rotates.
- Methods may be async. A store that always answers at once should set `readonly sync = true`, so requests skip a wait.
- For "sign out everywhere", index sessions per user in `set`: the record's `data` holds the user id under `createAuth`'s `sessionKey`.

### Custom session ids

[`generateId`](api:yerd.SessionOptions/generateId) controls the id that `MemoryStore` or a [SessionStore](api:yerd.SessionStore) with `kind: "id"` puts in the cookie.

```ts
yerd().sessions({
  store: new MemoryStore(),
  generateId: () => `sess_${randomUUID()}`, // "sess_3f1c9a2e-..."
});
```

- It may be async. Called for every new session and on `regenerate()`.
- Must return a non-empty string different from the old id. Keep ids unguessable, so a leaked log line can't name a live session: a random UUID, not a counter.
- With a `CookieStore` (no ids), it throws at startup.

## Sign-in with createAuth

[createAuth](api:auth.createAuth) needs to know how to load a user by id; it handles the rest. The shop's:

```ts
// src/users.ts
import { createAuth } from "@toyz/yerd/auth";

/** Session sign-in: `app.use(auth)`, `guards: [auth.required]`, `@auth.user`. */
export const auth = createAuth<User>({
  load: (id) => resolve(Users).get(id),
  loginPath: "/login",
});

// src/app.ts: ...sessions().use(auth)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `load(id)` | required | the user for a stored id, or `undefined` if they're gone (sync or async) |
| `idOf(user)` | `String(user.id)` | the id to store in the session |
| `roles(user)` | none | role names, for `auth.role()` |
| `loginPath` | `"/login"` | where browsers go when a page needs a signed-in user |
| `sessionKey` | `"__yerd_uid"` | the session key holding the user id |

`app.use(auth)` loads the user once per request. It needs `app.sessions()`.

> [!WARNING]
> Two kinds of sign-in in one app (users and admins) need a distinct `sessionKey` each. A second `createAuth()` on the same key throws.

## Login and logout

The sign-in form checks the password, then calls `auth.login(user)`; a wrong one goes back to the form with a flashed message, with or without JavaScript.

```tsx
// src/routes/auth.tsx
@action async submit(_: {}, form: ActionForm) {
  // ...form.parse(LoginForm) into `input`; a bad form goes to #fail() too
  const user = this.users.byName(input.name);
  // Spends a full hash even for unknown names, so timing doesn't reveal who has an account.
  if (!(await verifyPassword(input.password, user?.passwordHash)) || !user) {
    return this.#fail("Wrong username or password.", input.name);
  }
  // Rotates the session id and keeps a guest's data: the cart comes along.
  await auth.login(user);
  return redirect(safeNext(this.next));
}

/** Back to the form with a message, with or without JavaScript. */
#fail(error: string, name: string | undefined) {
  this.session.flash("login", { error, name } satisfies LoginState);
  return redirect(`/login${this.next ? `?next=${encodeURIComponent(this.next)}` : ""}`);
}

// ...and signing out is a POST, so a prefetch or a crawler can't do it:
@route("/logout")
export class Logout {
  @post async leave() {
    await auth.logout();
    return redirect("/");
  }
}
```

```answer
POST /login
_yx=(the form's token)&name=ada&password=nope
>>>
303 See Other
location: /login
---
POST /login?next=/checkout
_yx=(the form's token)&name=ada&password=analytical-engine
>>>
303 See Other
location: /checkout
set-cookie: yerd_session=hocHnKf4...; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax
---
POST /logout
>>>
303 See Other
location: /
set-cookie: yerd_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax
```

`auth.login(user)`:

1. Rotates the session id, so an id seen or planted before login is worthless.
2. Starts a fresh session if someone else was signed in on it; a guest's data (the cart) carries over.
3. Stores the user's id, then runs `onLogin`.

`auth.logout()` runs `onLogout`, then destroys the session and cookie.

- [hashPassword](api:auth.hashPassword) uses argon2id (scrypt where Node lacks it), PHC format; [verifyPassword](api:auth.verifyPassword) reads both. Given `undefined`, it still spends a full hash.
- [safeNext](api:auth.safeNext) passes only same-site paths, else the fallback (`"/"`). Always run `?next=` through it.
- Always `await` `login()` and `logout()`; with async hooks they return a promise.

### Keeping a guest's cart across sign-in

The shop does nothing for this: the cart is guest data in the session, and `auth.login()` keeps it. After the sign-in above:

```answer
GET /cart
200 OK
content-type: text/html; charset=utf-8

<!doctype html><!-- ... --><a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">1</span></a><form class="account" method="post" action="/logout">ada <button class="link">Sign out</button></form><!-- ... -->
```

To also keep carts saved per account, merge in `onLogin` (after the user is stored) and save in `onLogout` (before the session is destroyed):

```ts
export const auth = createAuth<User>({
  load: (id) => resolve(Users).get(id),
  async onLogin(user, session) {
    session.as(Cart).merge(await resolve(Carts).load(user.id)); // the guest's lines join the saved cart
  },
  async onLogout(user, session) {
    if (user) await resolve(Carts).save(user.id, session.as(Cart).lines);
  },
});
```

- `merge()` and `Carts` (your own service) aren't in the shop. Hooks use [`session.as()`](#outside-a-route-sessionas).
- A user who never signs out never triggers `onLogout`, so save on every cart change too. The [recipes guide](16-recipes.md#show-a-saved-cart-after-sign-in) builds the whole thing.

## Protecting routes

Checkout and the receipts are for the signed in. `auth.required` on their group covers every page and action in it:

```tsx
// src/routes/checkout.tsx
/** Everything here needs a signed-in user, in a narrow column. No URL prefix. */
@group("/", { guards: [auth.required], layout: Narrow })
export class Account {}

@route("/checkout", { group: Account, meta: { title: "Check out" } })
export class CheckoutPage {
  @auth.user accessor me!: User;
  // ...
}
```

A browser (`Accept: text/html`) is sent to sign in; an API client gets a 401:

```answer
GET /checkout
303 See Other
location: /login?next=%2Fcheckout
---
GET /checkout
401 Unauthorized
content-type: application/json; charset=utf-8

{"error":"Sign in first","code":"unauthorized"}
```

| Piece | Gives |
| --- | --- |
| `auth.required` | a guard: browsers go to `loginPath?next=...`, API clients get 401 |
| `auth.role(...names)` | a guard: the user has one of these roles, else 403 (signed out behaves like `required`) |
| `@auth.user` | the signed-in user; reading it with nobody signed in is a 401 |
| `@auth.maybeUser` | the user or `undefined` (the sign-in page uses it) |
| `auth.current()` | the user or `undefined`, for components and plain functions (the layout's account link) |

yerd's client runtime gets the redirect as a `yx-location` header.

## Guards

[createGuard](api:yerd.createGuard), what a guard may return, and the order guards run in are covered in [routing](02-routing.md#guards). Named guards live on services, so they can inject things: declare one with [guard](api:yerd.guard) and refer to it by name.

```ts
import { HttpStatus, guard, guards, inject, post, route, service, type YerdContext } from "@toyz/yerd";

@service
export class Flags {
  @inject(FlagStore) accessor store!: FlagStore;

  @guard("beta") beta(ctx: YerdContext) {
    return this.store.isOn("beta", ctx.path) || "/waitlist";
  }
}

@route("/beta", { guards: ["beta"] })
export class Beta {
  @post @guards(auth.required) vote() {
    return HttpStatus.NoContent;
  }
}
```

- [guards](api:yerd.guards) applies names or guard values to a class or method.
- An unknown guard name is a boot error.
- Actions run behind their class's guards plus their own.

## The security model

yerd refuses cross-site writes, signs action tokens per session, and seals session cookies by default. Set `YERD_SECRET` in production, or every restart signs everyone out. The [security guide](15-security.md) has the details and a go-live checklist.

> [!NOTE]
> A signed token proves the server rendered those arguments, not that this user may act on them. An action bound to `{ id }` still has to check that `this.me` owns `id`.
