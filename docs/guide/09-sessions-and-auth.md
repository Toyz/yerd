# Sessions and auth

Sessions, signing users in with `@toyz/yerd/auth`, and guards.

## Turn sessions on

Call `app.sessions()`; then any route reads and writes the session through `@session`.

```tsx
import { post, get, redirect, route, session, yerd, type Session } from "@toyz/yerd";

interface CartData {
  cart?: string[];
}

@route("/cart")
export class Cart {
  @session accessor session!: Session<CartData>;

  @get show() {
    return { items: this.session.cart ?? [], notice: this.session.flash("notice") ?? null };
  }

  @post add() {
    (this.session.cart ??= []).push("socks");
    this.session.flash("notice", "Added to cart");
    return redirect("/cart");
  }
}

export const app = yerd().sessions();
```

- `Session<CartData>` types the session's keys; typos and wrong types don't compile.
- Assign to save, assign `undefined` (or `delete`) to remove. In-place changes (`push`, nested edits) are saved too.
- `get(key)` / `set(key, value)` do the same by name, including keys named like session methods (`id`, `flash`).
- The type is only a view over one shared session; routes may use different shapes, with distinct field names.
- `@args(session)` gives a handler parameter the same thing.

### A class for methods and defaults

Pass a class to `@session` to give the session its methods, getters and setters, with field initializers as defaults.

```tsx
import { get, post, redirect, route, session, type Session } from "@toyz/yerd";

class Cart {
  items: string[] = [];
  coupon?: string;

  get count() {
    return this.items.length;
  }
  add(item: string) {
    this.items.push(item);
  }
}

@route("/cart")
export class CartPage {
  @session(Cart) accessor cart!: Session<Cart>;

  @get show() {
    return { items: this.cart.items, count: this.cart.count }; // items is string[], never undefined
  }

  @post add() {
    this.cart.add("socks"); // saved
    this.cart.flash("notice", "Added to cart"); // the session API is still there
    return redirect("/cart");
  }
}
```

- A missing value reads as its default, which is only saved once it changes.
- Only data fields are stored: keep them JSON. The constructor takes no arguments.
- No `#private` fields: `this` is the session, not an instance.
- A member named like a session method (`clear`, `flash`, `get`, ...) is refused on first use.
- `@args(session(Cart))` gives a handler parameter the same view.

### Outside a route: session.as()

Code outside a route class (auth hooks, components via `currentContext().session`, helpers) gets the plain session; [`session.as(Shape)`](api:yerd.Session) gives it the typed view.

```tsx
import { currentContext } from "@toyz/yerd";

class Prefs {
  theme: "light" | "dark" = "light";

  toggle() {
    this.theme = this.theme === "dark" ? "light" : "dark";
  }
}

export function ThemeLabel() {
  const prefs = currentContext().session.as(Prefs); // Session<Prefs>
  return <span class={`theme-${prefs.theme}`}>{prefs.theme}</span>;
}

export function lastSearch(): string | undefined {
  return currentContext().session.as<{ lastSearch?: string }>().lastSearch;
}
```

- `as(Shape)` includes methods and defaults; `as<T>()` is a type-only view, like `Session<T>`.
- Views share one session: `as(Prefs)` here and `@session(Prefs)` in a route change the same `theme`.

### App-wide keys

For the few keys every page reads (a theme, say), declare them on the global `SessionData` interface; plain `Session` and `currentContext().session` are typed by it.

```ts
declare module "@toyz/yerd" {
  interface SessionData {
    theme?: "light" | "dark";
  }
}

// anywhere: this.session.theme, currentContext().session.theme
```

Every route sees these keys, so keep it to a handful; feature data belongs in a shape class.

## The session API

| Method | Does |
| --- | --- |
| `session.key` / `session.key = value` | read and write a value (`undefined` removes it) |
| `get(key)` / `set(key, value)` | the same, by name |
| `delete(key)` / `clear()` | remove one value / all of them (`clear` also drops sign-in and the CSRF nonce, so open forms stop working) |
| `flash(key, value)` | keep a value for the next request that uses the session (a notice after a redirect) |
| `flash(key)` | read and consume that value |
| `regenerate()` | new session id and CSRF nonce, same data; do this on login |
| `destroy()` | drop the session and cookie; a later write starts a fresh one |
| `isNew`, `createdAt` | whether the request arrived without a session; when it was created |

- The session opens on first use (`ctx.session`, `@session`, auth middleware, an action). A request that never uses it doesn't refresh it or consume a flash.
- Changes are saved after the handler runs; an unchanged session sends no cookie unless a rolling refresh is due.
- An unhandled crash (anything but a `YerdError`) saves nothing, so a half-finished login never sticks.
- HTML sent to someone with a session isn't cacheable by others (see [caching headers](04-responses.md#caching-headers)).

> [!NOTE]
> Rendering action forms never starts a session, so pages with forms stay cacheable for first-time visitors. See [action tokens](15-security.md#action-tokens).

## Routes without a session

`session: false` on a route or group means the session is never opened or saved there, whatever cookie arrives. Use it for JSON APIs and webhooks.

```ts
import { get, group, route } from "@toyz/yerd";

@group("/api", { session: false })
class Api {}

@route("/stats", { group: Api })
export class Stats {
  @get read() {
    return { up: true };
  }
}
```

- A route's setting wins over its group's. No store read, no `Set-Cookie`.
- `ctx.session` throws and a `@session` field refuses to boot. Layouts and error pages for the route can't read it either.
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
- The session cookie is sealed under its own key, separate from [seal()](api:yerd.seal). Upgrading from a version that shared the key signs everyone out once.

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

interface Kv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { px: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class KvSessionStore implements SessionStore {
  readonly kind = "id";
  readonly #kv: Kv;

  constructor(kv: Kv) {
    this.#kv = kv;
  }

  // Keyed by a hash of the id, so a dump of the database can't be replayed as cookies.
  #key(id: string): string {
    return `session:${createHash("sha256").update(id).digest("base64url")}`;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const raw = await this.#kv.get(this.#key(id));
    return raw ? (JSON.parse(raw) as SessionRecord) : undefined;
  }

  async set(id: string, record: SessionRecord, ttlMs: number): Promise<void> {
    await this.#kv.set(this.#key(id), JSON.stringify(record), { px: Math.max(1, Math.round(ttlMs)) });
  }

  async destroy(id: string): Promise<void> {
    await this.#kv.del(this.#key(id));
  }
}

// src/app.ts
export const app = yerd().sessions({ store: new KvSessionStore(kv) }); // kv: your connected client
```

- `get` returns `undefined` for an unknown or expired id.
- `set` replaces the whole JSON-safe record; `ttlMs` is the idle `maxAge` capped by `absoluteMaxAge`, so let the database expire it.
- `destroy` runs on logout and when the id rotates.
- Methods may be async. An async `get` runs before middleware on every request with a session cookie; a store that always answers at once should set `readonly sync = true`.
- For "sign out everywhere", index sessions per user in `set`: the record's `data` holds the user id under `createAuth`'s `sessionKey`.

### Custom session ids

[`generateId`](api:yerd.SessionOptions/generateId) controls the id that `MemoryStore` or a [SessionStore](api:yerd.SessionStore) with `kind: "id"` puts in the cookie.

```ts
import { randomUUID } from "node:crypto";
import { MemoryStore, yerd } from "@toyz/yerd";

export const app = yerd().sessions({
  store: new MemoryStore(),
  generateId: () => `sess_${randomUUID()}`, // "sess_3f1c9a2e-..."
});
```

- It may be async (an id from a database sequence, say).
- Called for every new session and on `regenerate()` (which `auth.login()` does).
- Must return a non-empty string different from the old id. Two live sessions with one id share data.
- Keep ids unguessable, so a leaked log line can't name a live session: a random UUID, not a counter.
- With a `CookieStore` (no ids), it throws at startup.

## Sign-in with createAuth

[createAuth](api:auth.createAuth) needs to know how to load a user by id; it handles the rest.

```ts
// src/auth.ts
import { resolve } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";
import { Users, type User } from "./users.js";

export const auth = createAuth<User>({
  load: (id) => resolve(Users).find(id),
  roles: (user) => user.roles,
  loginPath: "/login",
});

// src/app.ts
export const app = yerd().sessions().use(auth);
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

`auth.login(user)` signs a user in:

1. Rotates the session id, so an id seen or planted before login is worthless.
2. Starts a fresh session if someone else was signed in on it; a guest's data (a cart) carries over.
3. Stores the user's id, then runs `onLogin`.

`auth.logout()` runs `onLogout`, then destroys the session and cookie.

```tsx
// src/routes/login.tsx
import { ActionForm, Unauthorized, action, get, inject, post, query, redirect, route } from "@toyz/yerd";
import { safeNext, verifyPassword } from "@toyz/yerd/auth";
import { auth } from "../auth.js";
import { Users, type User } from "../users.js";

@route("/login")
export class Login {
  @inject(Users) accessor users!: Users;
  @auth.maybeUser accessor me: User | undefined;
  @query("next") accessor next: string | undefined;

  @get page() {
    if (this.me) return redirect(safeNext(this.next));
    return (
      <form action={this.submit}>
        <input name="name" autocomplete="username" />
        <input name="password" type="password" autocomplete="current-password" />
        <p data-yx-error role="alert"></p>
        <button>Log in</button>
      </form>
    );
  }

  @action async submit(_: {}, form: ActionForm) {
    const user = this.users.byName(form.string("name"));
    if (!(await verifyPassword(form.string("password"), user?.passwordHash)) || !user) {
      throw new Unauthorized("Wrong name or password");
    }
    await auth.login(user);
    return redirect(safeNext(this.next));
  }
}

@route("/logout")
export class Logout {
  // A POST, not a link: a prefetch or a crawler must not be able to sign anyone out.
  @post async leave() {
    await auth.logout();
    return redirect("/");
  }
}

// in a layout: <form action="/logout" method="post"><button>Log out</button></form>
```

- [hashPassword](api:auth.hashPassword) uses argon2id (scrypt where Node lacks it), PHC format; [verifyPassword](api:auth.verifyPassword) reads both.
- Pass `undefined` to `verifyPassword` for an unknown user: it still spends a full hash, so timing doesn't reveal which names exist.
- [safeNext](api:auth.safeNext) passes only same-site paths, else the fallback (`"/"`). Always run `?next=` through it.
- Always `await` `login()` and `logout()`; with async hooks they return a promise.

### Keeping a guest's cart across sign-in

`onLogin` runs after the user is stored and `onLogout` before the session is destroyed; use them to merge a guest's data with the user's saved data.

```ts
// src/auth.ts
import { resolve } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";
import { Cart, Carts } from "./cart.js";
import { Users, type User } from "./users.js";

export const auth = createAuth<User>({
  load: (id) => resolve(Users).find(id),
  async onLogin(user, session) {
    const cart = session.as(Cart); // the same view as @session(Cart): methods, defaults
    cart.merge(await resolve(Carts).load(user.id)); // the guest's items join the saved cart
  },
  async onLogout(user, session) {
    if (user) await resolve(Carts).save(user.id, session.as(Cart).items);
  },
});
```

- `Cart` is the [shape class above](#a-class-for-methods-and-defaults) plus `merge(saved)`; `Carts` is your own service. Hooks use [`session.as()`](#outside-a-route-sessionas).
- A user who never signs out never triggers `onLogout`, so save on every cart change too.
- The [recipes guide](16-recipes.md#show-a-saved-cart-after-sign-in) builds the whole thing.

## Protecting routes

```tsx
import { get, group, route } from "@toyz/yerd";
import { auth } from "./auth.js";
import type { User } from "./users.js";

@route("/account", { guards: [auth.required] })
export class Account {
  @auth.user accessor me!: User;

  @get show() {
    return <h1>Hello, {this.me.name}</h1>;
  }
}

@group("/admin", { guards: [auth.role("admin")] })
export class Admin {}

export function Greeting() {
  const user = auth.current();
  return user ? <span>Hi {user.name}</span> : <a href="/login">Log in</a>;
}
```

| Piece | Gives |
| --- | --- |
| `auth.required` | a guard: browsers go to `loginPath?next=...`, API clients get 401 |
| `auth.role(...names)` | a guard: the user has one of these roles, else 403 (signed out behaves like `required`) |
| `@auth.user` | the signed-in user; reading it with nobody signed in is a 401 |
| `@auth.maybeUser` | the user or `undefined` |
| `auth.current()` | the user or `undefined`, for components and plain functions |

"Browser" means the request accepts `text/html`; yerd's client runtime gets the redirect as a `yx-location` header.

## Guards

[createGuard](api:yerd.createGuard), what a guard may return, and the order guards run in are covered in [routing](02-routing.md#guards). Named guards live on services, so they can inject things: declare one with [guard](api:yerd.guard) and refer to it by name.

```ts
import { guard, guards, inject, post, route, service, type YerdContext } from "@toyz/yerd";
import { auth } from "./auth.js";
import { FlagStore } from "./flags.js";

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
    return 204;
  }
}
```

- [guards](api:yerd.guards) applies names or guard values to a class or method.
- An unknown guard name is a boot error.
- Actions run behind their class's guards plus their own, so `auth.required` on a group covers every page and action in it.

## The security model

yerd refuses cross-site writes, signs action tokens per session, and seals session cookies by default. Set `YERD_SECRET` in production, or every restart signs everyone out. The [security guide](15-security.md) has the details and a go-live checklist.

> [!NOTE]
> A signed token proves the server rendered those arguments, not that this user may act on them. An action bound to `{ id }` still has to check that `this.me` owns `id`.
