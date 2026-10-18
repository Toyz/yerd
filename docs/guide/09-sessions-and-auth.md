# Sessions and auth

This page covers sessions, signing users in with `@toyz/yerd/auth`, guards, and the security checks yerd does for you.

## Turn sessions on

Sessions are off until you call `app.sessions()`. Then any route can read and write the session through `@session`.

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

`Session<CartData>` types the session: `this.session.cart` is `string[] | undefined`, and `this.session.crat` or `this.session.cart = 42` won't compile. Values are plain properties:

- assign to save one, assign `undefined` (or `delete`) to remove it;
- changes made in place (`push`, editing a nested object) are noticed and saved too;
- `get(key)` / `set(key, value)` do the same by name, and reach a field named like a session method (`id`, `flash`, ...).

The type is only a view: every route sees the same session, so two routes can use different shapes over it (keep their field names apart). `@args(session)` works the same way, typed by the parameter.

### A class for methods and defaults

Pass a class to `@session` and the session gets its methods, getters and setters, with `this` as the session. Field initializers are defaults: a missing value reads as the default, and it's only saved once it changes, so reading a default never writes the session by itself.

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

- The class is never stored: only its data fields are, so keep them JSON (plain objects, arrays, strings, numbers, booleans).
- Its constructor runs once per request (for the defaults) and takes no arguments.
- No `#private` fields: `this` is the session, not an instance of the class.
- Session members win, so a method or getter named like one (`clear`, `delete`, `flash`, `get`, ...) would never run: a shape with one is refused the first time it's used.
- `@args(session(Cart))` gives a handler parameter the same view.

### Outside a route: session.as()

Code that isn't a route class gets the plain session: auth hooks, `currentContext().session` in a component, a helper function. [`session.as(Shape)`](api:yerd.Session) gives it the same typed view `@session(Shape)` gives a route, methods and defaults included; `session.as<T>()` with no argument is a type-only view, like `Session<T>`:

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

Views are cheap and share one session: `as(Prefs)` in a component and `@session(Prefs)` in the route see, and change, the same `theme`.

### App-wide keys

Most apps never need this. If a few keys really are everywhere (a theme every layout reads, say) and you'd rather not write `.as()` each time, declare them once on the global `SessionData` interface. Plain `Session` and `currentContext().session` are typed by it:

```tsx
import { post, redirect, route, session, type Session } from "@toyz/yerd";

declare module "@toyz/yerd" {
  interface SessionData {
    theme?: "light" | "dark";
  }
}

@route("/theme")
export class Theme {
  @session accessor session!: Session;

  @post toggle() {
    this.session.theme = this.session.theme === "dark" ? "light" : "dark"; // typed by SessionData
    return redirect("/");
  }
}
```

The interface is global, so every key on it is visible (and writable) from every route. Keep it to a handful; for anything that belongs to one feature, a shape class and `.as()` keep its keys next to its code.

## The session API

| Method | Does |
| --- | --- |
| `session.key` / `session.key = value` | read and write a value (`undefined` removes it); a shape class adds its own methods |
| `get(key)` / `set(key, value)` | the same, by name |
| `delete(key)` / `clear()` | remove one value / all of them (sign-in and the CSRF nonce included, so open forms stop working) |
| `flash(key, value)` | keep a value for the next request only (a notice after a redirect) |
| `flash(key)` | read and consume a flash set by the previous request |
| `regenerate()` | new session id, same data; do this on login |
| `destroy()` | drop the session and its cookie; setting a value afterwards starts a fresh one |
| `isNew`, `createdAt` | whether the request arrived without a session; when it was created |

HTML pages sent to someone with a session get `Cache-Control: private, no-cache` (unless the handler set its own), so a shared cache or the browser's Back button can't show a signed-in page to the wrong person, or a signed-out page after signing in.

Changes are saved after the handler runs, including ones made in place. A request that changed nothing sends no cookie (unless a rolling session is due for a refresh).

> [!NOTE]
> When an app has actions, every page request starts a session if there isn't one: action tokens are bound to a per-session nonce, and the nonce has to be saved before any form is rendered. So with sessions and actions on, first-time visitors get a cookie (and pages get `Cache-Control: private, no-cache`) whether or not your code writes anything. An app without `@action` methods only starts sessions when something is set.

> [!NOTE]
> If a request ends in an unhandled crash (anything other than an `HttpError`), the session isn't saved. A half-finished login or update never sticks.

## Stores and options

The default [CookieStore](api:yerd.CookieStore) keeps the data in the cookie itself, sealed with AES-256-GCM: no server state at all, but a ~4 KB limit. [MemoryStore](api:yerd.MemoryStore) keeps data in the process and only an id in the cookie.

The session cookie is sealed under its own key, not the one [seal()](api:yerd.seal) uses, so nothing your app seals can pass for a session and a session cookie doesn't open with `unseal()`. Upgrading from a version that shared the key signs everyone out once and invalidates values sealed before it.

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
| `rolling` | `true` | refresh the idle expiry on activity |
| `cookieName` | `"yerd_session"` | cookie name (gets a `__Host-` prefix over HTTPS) |
| `secure` | auto | force the `Secure` flag on or off; by default it's on when the request came over HTTPS |
| `trustProxy` | the app's `trustProxy` | believe `X-Forwarded-Proto` when deciding whether the request was HTTPS |
| `generateId` | 32 random bytes | makes the id for a new or regenerated session; only for stores that keep ids (`kind: "id"`) |

Cookies are always `HttpOnly`, `SameSite=Lax` and `Path=/`.

### MemoryStore

`MemoryStore` takes `maxSize` (evicts the least recently saved past it; default no cap) and `sweepInterval` (how often, at most, a save also clears expired sessions; default 60 s). It's for dev, tests and single-process deploys. Under the Vite dev server its sessions survive app reloads, so editing a file doesn't sign you out (stores share records by `name`, default `"default"`; give two stores in one app different names).

### Which store

| Store | Good for | Watch out for |
| --- | --- | --- |
| `CookieStore` (default) | small sessions (an id, a theme, a short cart), any number of instances, no infrastructure | ~4 KB after sealing: a bigger session is a 500 naming the size. Can't revoke a session server-side before it expires |
| `MemoryStore` | dev, tests, one process | lost on restart; each instance has its own |
| your own `SessionStore` | several instances, big sessions, "sign out everywhere" | one store lookup per request with a session |

### Your own store

A store is three methods over any key-value database. Here `Kv` stands for your Redis client or similar:

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
```

```ts
// src/app.ts
import { yerd } from "@toyz/yerd";
import { KvSessionStore } from "./session-store.js";

export const app = yerd().sessions({ store: new KvSessionStore(kv) }); // kv: your connected client
```

- `get` returns `undefined` for an unknown or expired id; yerd then starts a fresh session.
- `set` replaces the whole record. `ttlMs` is how long it may live: the idle `maxAge`, capped by what's left of `absoluteMaxAge`. Letting the database expire it keeps the store from filling up.
- `destroy` runs on logout and when the id is rotated (`regenerate()`, login).
- The record is JSON-safe (`data`, `flash`, `createdAt`), so `JSON.stringify` is all the serializing it needs.
- Methods may be sync or async.

To sign a user out everywhere, have the store keep an index of sessions per user: `set` sees the record's data, signed-in user id included (under `createAuth`'s `sessionKey`, `"__yerd_uid"` by default), so it can remember which keys belong to whom and delete them all.

### Custom session ids

Stores that keep the data on the server (`MemoryStore`, or your own [SessionStore](api:yerd.SessionStore) with `kind: "id"`) put only an id in the cookie. By default it's 32 random bytes, base64url. Pass [`generateId`](api:yerd.SessionOptions/generateId) when the id should look a certain way: a prefix you can spot in logs, the format your Redis keys or database rows use, or a value from a database sequence.

```ts
import { randomUUID } from "node:crypto";
import { MemoryStore, yerd } from "@toyz/yerd";

export const app = yerd().sessions({
  store: new MemoryStore(),
  generateId: () => `sess_${randomUUID()}`, // "sess_3f1c9a2e-..."
});
```

It may be async, for ids that come from somewhere else:

```ts
yerd().sessions({
  store: new PostgresSessionStore(pool),
  generateId: async () => {
    const { rows } = await pool.query("select nextval('session_ids') as id");
    return `s${rows[0].id}`;
  },
});
```

- It's called for every new session and again on `regenerate()` (which `auth.login()` does), so a signed-in user gets a fresh id.
- It must return a non-empty string, different from the session's old id; anything else is an error. Make ids unique: two live sessions with one id share their data.
- Keep them unguessable even though they can't be forged (the id travels inside the sealed cookie): a leaked store dump or log line shouldn't name live sessions. A random UUID is fine; a plain counter is not, unless the store maps it to something random.
- A `CookieStore` keeps the data in the cookie and has no ids, so `sessions({ generateId })` without an id store throws at startup.

## Sign-in with createAuth

yerd doesn't know what a user is. [createAuth](api:auth.createAuth) asks you how to load one by id and gives you everything else.

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
```

```ts
// src/app.ts
import { yerd } from "@toyz/yerd";
import { auth } from "./auth.js";

export const app = yerd().sessions().use(auth);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `load(id)` | required | the user for a stored id, or `undefined` if they're gone (sync or async) |
| `idOf(user)` | `String(user.id)` | the id to store in the session |
| `roles(user)` | none | role names, for `auth.role()` |
| `loginPath` | `"/login"` | where browsers go when a page needs a signed-in user |
| `sessionKey` | `"__yerd_uid"` | the session key holding the user id |

`app.use(auth)` installs a middleware that loads the user once per request. It needs `app.sessions()`.

> [!WARNING]
> Two kinds of sign-in in one app (users and admins) need a distinct `sessionKey` each. A second `createAuth()` on the same key throws, because signing in as one would count as the other.

## Login and logout

`auth.login(user)` signs a user in:

1. It rotates the session id, so an id someone saw or planted before login is worthless afterwards.
2. If someone else was signed in on this session (a shared computer, no logout), it starts a fresh session, so nothing of theirs carries over to the new user. A guest's data (a cart) does carry over.
3. It stores the user's id, then runs your `onLogin` hook, if any.

`auth.logout()` runs `onLogout`, then destroys the session and its cookie.

```tsx
// src/routes/login.tsx
import { ActionForm, HttpError, action, get, inject, post, query, redirect, route } from "@toyz/yerd";
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
      throw new HttpError(401, "Wrong name or password");
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

- [hashPassword](api:auth.hashPassword) hashes with argon2id (scrypt where Node lacks it) in PHC format. [verifyPassword](api:auth.verifyPassword) reads both.
- Pass `undefined` to `verifyPassword` for an unknown user, as above: it still spends a full hash, so timing doesn't reveal which names exist.
- [safeNext](api:auth.safeNext) only lets same-site paths through. `//evil.com`, `https://...` and friends become the fallback (default `"/"`). Always run `?next=` through it.
- `login()` and `logout()` return a promise when a hook is async. `await` them either way: the session must be ready before the response goes out.

### Keeping a guest's cart across sign-in

`onLogin` runs right after `login()` has rotated the session and stored the user, and `onLogout` right before `logout()` destroys the session. Use them to merge what a guest collected into the user's own data, and to keep it for next time (another day, another device):

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

Here `Cart` is the shape class from [above](#a-class-for-methods-and-defaults) with one more method, `merge(saved: string[])`, and `Carts` is your own service that keeps each user's cart. The hooks get the plain session; [`session.as(Cart)`](#outside-a-route-sessionas) gives them the cart view without declaring any app-wide keys. A user who never signs out never triggers `onLogout`, so save on every cart change too. The [recipes guide](16-recipes.md#show-a-saved-cart-after-sign-in) builds the whole thing: the cart shape, the saved carts, the merge and a welcome-back notice.

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

"Browser" means the request accepts `text/html`. Requests from yerd's client runtime get the redirect as a `yx-location` header instead.

## Guards

A guard is a gate in front of handlers. [createGuard](api:yerd.createGuard) makes one you can use as a decorator or in a `guards` list.

```tsx
import { HttpError, createGuard, get, route } from "@toyz/yerd";

export const businessHours = createGuard("businessHours", () => {
  const hour = new Date().getHours();
  return (hour >= 9 && hour < 17) || new HttpError(403, "Come back during business hours");
});

@route("/support")
@businessHours
export class Support {
  @get page() {
    return "We're here";
  }
}
```

| A guard returns | Result |
| --- | --- |
| `true` or nothing | continue |
| a string | 303 redirect there |
| `false` | 403 |
| an `Error` (returned or thrown) | that error's response |
| anything else | becomes the response, like a handler's return value |

Named guards live on services, so they can inject things. Declare one with [guard](api:yerd.guard) and refer to it by name.

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

- Guards attach in five places, and run in this order: `app.guard(...)`, groups (outer to inner), the route's `guards` option, class decorators, then method decorators. The first one that doesn't continue decides.
- [guards](api:yerd.guards) applies names or guard values to a class or method.
- An unknown guard name is a boot error.
- Actions run behind their class's guards plus their own, so `auth.required` on a group covers every page and action in it.

## The security model

yerd blocks the common attacks by default. In short:

- **Cross-site requests.** Every POST, PUT, PATCH and DELETE from another site is refused with a 403 before any guard, handler or action runs. `trustedOrigins` lists other origins allowed to post; `trustProxy` makes the check use `X-Forwarded-Host`.
- **Action tokens.** Every action carries a signed token, so its arguments can't be forged. It expires after `actionTtl` seconds (a day) and, with sessions on, only works in the session it was rendered for.
- **Sessions.** Sealed with AES-256-GCM, `HttpOnly`, `SameSite=Lax`, and `Secure` with a `__Host-` name over HTTPS. `login()` rotates the id and starts fresh when the user changes.
- **Secrets.** Set `YERD_SECRET` (at least 32 bytes, a comma-separated list to rotate) in production. Without it, every restart signs everyone out.

> [!NOTE]
> A signed token proves the server rendered those arguments, not that this user may act on them. An action bound to `{ id }` still has to check that `this.me` owns `id`.

The [security guide](15-security.md) has the details of each, the knobs, and a checklist for going live.