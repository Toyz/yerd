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

Pass a class to `@session` and the session gets its methods, getters and setters, with `this` as the session. Field initializers are defaults: a missing value reads as the default, and it's only saved once it changes, so a visitor who only reads gets no cookie.

```tsx
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

### App-wide keys

Keys every route shares can go on the global `SessionData` interface instead. Plain `Session`, without a type argument, uses it, and so does `currentContext().session` outside a route class:

```tsx
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

## The session API

| Method | Does |
| --- | --- |
| `session.key` / `session.key = value` | read and write a value (`undefined` removes it); a shape class adds its own methods |
| `get(key)` / `set(key, value)` | the same, by name |
| `delete(key)` / `clear()` | remove one value / all of them |
| `flash(key, value)` | keep a value for the next request only (a notice after a redirect) |
| `flash(key)` | read and consume a flash set by the previous request |
| `regenerate()` | new session id, same data; do this on login |
| `destroy()` | drop the session and its cookie; setting a value afterwards starts a fresh one |
| `isNew`, `createdAt` | whether the request arrived without a session; when it was created |

HTML pages sent to someone with a session get `Cache-Control: private, no-cache` (unless the handler set its own), so a shared cache or the browser's Back button can't show a signed-in page to the wrong person, or a signed-out page after signing in.

Changes are saved after the handler runs, including ones made in place. A request that changed nothing sends no cookie (unless a rolling session is due for a refresh).

> [!NOTE]
> If a request ends in an unhandled crash (anything other than an `HttpError`), the session isn't saved. A half-finished login or update never sticks.

## Stores and options

The default [CookieStore](api:yerd.CookieStore) keeps the data in the cookie itself, sealed with AES-256-GCM: no server state at all, but a ~4 KB limit. [MemoryStore](api:yerd.MemoryStore) keeps data in the process and only an id in the cookie.

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

Your own ids, for a store or logs that expect a format:

```ts
import { randomUUID } from "node:crypto";

yerd().sessions({ store: new MemoryStore(), generateId: () => `sess_${randomUUID()}` });
```

It may be async (a database sequence), must return a unique non-empty string, and is refused with a `CookieStore`, which has no ids. The id sits inside the sealed cookie so it can't be forged, but keep it unguessable anyway: a leaked store dump shouldn't name live sessions.

`MemoryStore` takes `maxSize` (evicts the least recently saved past it; default no cap) and `sweepInterval` (how often, at most, a save also clears expired sessions; default 60 s). It's for dev, tests and single-process deploys. Under the Vite dev server its sessions survive app reloads, so editing a file doesn't sign you out (stores share records by `name`, default `"default"`). For anything else, implement [SessionStore](api:yerd.SessionStore): `kind: "id"` plus `get`, `set` and `destroy`.

Cookies are always `HttpOnly`, `SameSite=Lax` and `Path=/`.

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

`auth.login(user)` regenerates the session id (so a pre-login id can't be reused) and stores the user's id. `auth.logout()` destroys the session.

```tsx
import { ActionForm, HttpError, action, get, inject, query, redirect, route } from "@toyz/yerd";
import { safeNext, verifyPassword } from "@toyz/yerd/auth";
import { auth } from "./auth.js";
import { Users, type User } from "./users.js";

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
        <button>Log in</button>
      </form>
    );
  }

  @action async submit(_: {}, form: ActionForm) {
    const user = this.users.byName(form.string("name"));
    if (!(await verifyPassword(form.string("password"), user?.passwordHash)) || !user) {
      throw new HttpError(401, "Wrong name or password");
    }
    auth.login(user);
    return redirect(safeNext(this.next));
  }
}
```

- [hashPassword](api:auth.hashPassword) hashes with argon2id (scrypt where Node lacks it) in PHC format. [verifyPassword](api:auth.verifyPassword) reads both.
- Pass `undefined` to `verifyPassword` for an unknown user, as above: it still spends a full hash, so timing doesn't reveal which names exist.
- [safeNext](api:auth.safeNext) only lets same-site paths through. `//evil.com`, `https://...` and friends become the fallback (default `"/"`). Always run `?next=` through it.

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

yerd blocks the common attacks by default. Here's what it does, and the knobs.

**Cross-site requests.** Every POST, PUT, PATCH and DELETE is checked before any guard, handler or action runs. A browser request from another site is refused with 403, judged by `Sec-Fetch-Site`, then `Origin`, then `Referer` against the `Host`. Requests with none of those headers (curl, server-to-server) pass, since they can't be carrying a victim's cookies.

```ts
yerd({
  trustedOrigins: ["https://admin.example.com"], // other origins allowed to post
  trustProxy: true, // behind a proxy: believe X-Forwarded-Host and X-Forwarded-Proto
  // csrf: false,   // turns the check off entirely
});
```

**Action tokens.** Every action form carries a signed `_yx` token, so the action and its bound arguments can't be forged. It expires after `actionTtl` seconds (default 86400), and with sessions on it's bound to the visitor's session: a token rendered for someone else is a 403.

**Secrets.** Tokens are signed and cookie sessions sealed with `YERD_SECRET`. Each secret must be at least 32 bytes.

```sh
# rotate: put the new secret first, deploy, drop the old one later
YERD_SECRET="new-secret-at-least-32-bytes-long....,old-secret-at-least-32-bytes-long...."
```

New tokens and sessions use the first secret; any listed secret is accepted. `yerd({ secret })` takes a string or a list and wins over the variable.

> [!WARNING]
> Without a secret, yerd uses a random one per process: every restart logs everyone out and breaks open forms, and two instances can't read each other's cookies. It warns at boot when `NODE_ENV=production`. Set `YERD_SECRET` in production. (In development, with `NODE_ENV` unset or `development`, the random secret is saved to `node_modules/.cache/yerd/secret` and reused, so dev server restarts keep you signed in.)

> [!NOTE]
> A signed token proves the server rendered those arguments, not that this user may act on them. An action bound to `{ id }` still has to check that `this.me` owns `id`.
