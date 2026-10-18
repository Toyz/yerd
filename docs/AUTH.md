# yerd auth: sessions, users, guards

Sessions and auth built from `node:crypto` and the decorator model already in
PLAN.md. No passport, no express-session, no jsonwebtoken. yerd ships the
primitives and the wiring; the user owns the user model and the database.

**Split:** sessions are core (`app.sessions()`, `ctx.session`, `@session`).
Everything about users (`createAuth`, `@auth.user`, `auth.required`,
`auth.role()`, passwords, `safeNext`) lives in the optional `@toyz/yerd/auth`
subpath and is written only with the public decorator kit
([DECORATORS.md](DECORATORS.md)) and middleware. Use it, fork it, or write
your own in a few lines.

## What it looks like

```ts
// src/session.ts -- typed session data via declaration merging
declare module "@toyz/yerd" {
  interface SessionData {
    cart?: string[];
  }
}
```

```ts
// src/users.ts -- the one thing the user has to write: how to load a user by id
import { resolve } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";

export const auth = createAuth<User>({
  load: (id) => resolve(UserRepo).get(id),  // undefined if they're gone
  roles: (user) => user.roles,              // for auth.role(...)
  loginPath: "/login",                      // the default
});
```

```ts
// src/main.ts
export default yerd()
  .sessions({ maxAge: 14 * 86_400_000 })   // sealed-cookie store by default
  .use(auth)                                // loads the signed-in user once per request
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

```tsx
// src/routes/login.tsx
@route("/login")
export class Login {
  @inject(UserRepo) accessor users!: UserRepo;
  @session accessor session!: Session;
  @query("next") accessor next: string | undefined;

  @get form() {
    return <LoginForm action={this.submit} error={this.session.flash("error")} />;
  }

  @action
  async submit(_: {}, form: ActionForm) {
    const input = form.parse(LoginInput);
    const user = this.users.byName(input.name);
    // Always spends a hash, so timing doesn't reveal which names exist.
    if (!(await verifyPassword(input.password, user?.passwordHash)) || !user) {
      this.session.flash("error", "Wrong username or password.");
      return redirect("/login");
    }
    auth.login(user);                          // rotates the session id, stores the user id
    return redirect(safeNext(this.next, "/")); // same-site paths only
  }
}
```

```tsx
// src/routes/admin.tsx
@route("/admin", { guards: [auth.role("admin")] })
export class Admin {
  @auth.user accessor me!: User;               // resolved user, typed
  @session accessor session!: Session;

  @get index() {
    return <Dashboard user={this.me} notice={this.session.flash("notice")} />;
  }
}
```

```tsx
// any layout or component, no prop drilling (reads the request via ALS)
export function Nav() {
  const me = auth.current();
  return (
    <nav>
      {me ? <form action={LogoutRoute.prototype.out}><button>log out {me.name}</button></form>
          : <a href="/login">log in</a>}
    </nav>
  );
}
```

(`LogoutRoute.out` is an ordinary `@action` that calls `auth.logout()`; yerd
has no built-in logout action. An action is found by function identity, so a
component can name it through the prototype.)

## Sessions

**Turning them on.** `app.sessions(options?)`. Reading `ctx.session` (or
`@session`) in an app without it throws "Sessions are off; call
app.sessions() to turn them on", and so does `createAuth`'s middleware.

**Access.** `@session accessor session!: Session` on any route, service or
class, or `currentContext().session` from function components. Like the other
request accessors it reads through `AsyncLocalStorage`, so it works whatever the
class's lifetime.

**API.** values as properties (`session.cart`, `session.cart = x`, assigning
`undefined` removes), `get(key)`, `set(key, value)`, `delete(key)`, `clear()`,
`flash(key, value)` / `flash(key)` (readable on the next request only, then
gone, which pairs with the post/redirect/get flow actions already use),
`regenerate()`, `destroy()`, `isNew`, `createdAt`. Keys and value types come
from `Session<T>`'s `T`, or the merged `SessionData` interface for plain
`Session`, so `session.cartt` is a compile error. `@session(Cart)` views the
session through a class: its methods, getters and setters run with `this` as
the session, and field initializers are defaults (read when the value is
missing, saved once changed). Views are per session and class, so two
accessors with the same class share one. Writing after `destroy()` (logout, then a flash or a login)
starts a fresh session: a new id and creation time, the old record still
dropped.

**Ids.** `kind: "id"` stores get a fresh id on a new session and on
`regenerate()`: 32 random bytes by default, or `sessions({ generateId })`
(sync or async; must be unique and non-empty; refused with a CookieStore).

**Lazy and dirty-tracked.** Nothing is written back unless it changed (set,
or changed in place: the data is compared to what was loaded) (or
`rolling` needs the expiry bumped). A page that never touches the session
sends no `Set-Cookie`. A request whose handler crashed (anything but an
`HttpError`) skips the commit, so a half-done login or update doesn't stick.

**Stores.** One small interface, passed as `app.sessions({ store })`:

```ts
interface SessionStore {
  /** "cookie" stores keep the sealed record in the cookie itself; "id" stores keep an id there. */
  readonly kind: "cookie" | "id";
  get(id: string): SessionRecord | undefined | Promise<SessionRecord | undefined>;
  set(id: string, record: SessionRecord, ttlMs: number): void | Promise<void>;
  destroy(id: string): void | Promise<void>;
}
```

Methods may be sync or async. Built in:

| Store         | Where data lives                    | For                              |
|---------------|-------------------------------------|----------------------------------|
| `CookieStore` | the cookie itself, AES-256-GCM sealed | default; no server state, ~4KB cap (bigger is an error) |
| `MemoryStore({ maxSize?, sweepInterval? })` | a `Map` in this process, keyed by a hash of the id | dev, tests, single-process deploys; lost on restart. `maxSize` evicts the least recently saved (default no cap); expired sessions are swept on saves at most every `sweepInterval` ms (default 60s) |
| `FileStore`   | one JSON file per session           | planned |

Redis, Postgres or anything else is a user-written class implementing
`SessionStore`: `app.sessions({ store: new RedisStore(client) })`. Their dep,
not ours.

**Cookie.** `HttpOnly; SameSite=Lax; Path=/`, named `yerd_session`
(`cookieName`). When the request came over HTTPS it's also `Secure` with the
`__Host-` name prefix, so it can't be scoped to a subdomain or planted by one.
"Over HTTPS" means the socket was TLS, or, with `trustProxy` on, the first
`X-Forwarded-Proto` says `https`. The app's `trustProxy` option is passed
through to sessions; a session's own `trustProxy` wins. `secure: true / false`
forces it either way.

**IDs.** 32 bytes from `crypto.randomBytes`, base64url, and always sealed
inside the cookie. Server-side stores key by a SHA-256 of the ID, so a leaked
store dump can't be replayed as cookies.

**Expiry.** Idle timeout (`maxAge`, ms, default 14 days, refreshed when
`rolling`, the default) plus an absolute lifetime (`absoluteMaxAge`, ms,
default 30 days) that rolling never extends.

**Secrets.** The `secret` option (a string, or a list newest first), else
`YERD_SECRET` from the environment, comma separated for rotation. Sign and
seal with the first, accept any. Rotation is: prepend a new one, deploy, drop
the old one later. Every secret must be at least 32 bytes, or boot throws.
With no secret at all, yerd uses a random per-process one, so forms and
sessions break across restarts and instances; in production
(`NODE_ENV=production`) that only logs a warning, it doesn't refuse to start.
The same secrets sign action tokens.

## Auth

yerd doesn't know what a user is. `createAuth({ load })` takes a function that
turns the id stored in the session into a user (or `undefined`); its
middleware calls it at most once per request and builds everything else on it.

```ts
createAuth<User>({
  load: (id: string) => User | undefined | Promise<User | undefined>,
  idOf?: (user: User) => string,          // default: String(user.id)
  roles?: (user: User) => readonly string[],
  loginPath?: string,                     // default "/login"
  sessionKey?: string,                    // default "__yerd_uid"
})
```

| API                          | Kind       | Does                                                      |
|------------------------------|------------|-----------------------------------------------------------|
| `app.use(auth)`              | middleware | loads the signed-in user once per request (needs `app.sessions()`) |
| `@auth.user accessor me!: User` | accessor | the signed-in user; reading it with nobody signed in is a 401 |
| `@auth.maybeUser accessor me?: User` | accessor | the signed-in user or `undefined`                |
| `auth.current()`             | function   | same, for components and plain functions (`undefined` outside a request) |
| `auth.required`              | guard      | someone must be signed in (see below)                     |
| `auth.role(...names)`        | guard      | signed in (else as `required`) and has one of the roles, else 403 |
| `auth.login(user)`           | function   | regenerates the session id, stores `idOf(user)`           |
| `auth.logout()`              | function   | destroys the session                                      |
| `hashPassword` / `verifyPassword` | function | see below                                            |
| `safeNext(path, fallback?)`  | function   | same-site paths only, else the fallback (`/`)             |

Guards go anywhere guards go: `guards: [auth.required]` on a route or group,
`@auth.required` as a decorator, `app.guard(auth.required)`.

**One session key per auth.** Each auth keeps its user id under its own
session key. An app with two kinds of sign-in (users and admins) must give
each a distinct `sessionKey`, or signing in as one would count as the other:
creating a second auth without one throws. (Dev reloads reset this, so
re-creating the same auth isn't a clash.)

**Prerendering.** At build time nobody is signed in: the middleware sets no
user, and `auth.required` on a prerendered route fails the build.

**Unauthenticated responses** depend on who's asking:
- requests that accept `text/html` (browsers, and yerd's runtime, which asks
  for HTML): `303` to `loginPath?next=<path and query>`; for the runtime's
  scripted requests (`yx: 1`) that becomes `200` with `yx-location`, so the
  client navigates to login
- anything else (JSON / API): `401`

Forbidden (`auth.role()` failing) is `403`, rendered through the error page
like any other `HttpError`.

**Passwords.** `hashPassword` uses argon2id via `crypto.argon2` (present in
Node 26, confirmed in M0) with a random 16-byte salt, stored in the standard
`$argon2id$v=19$m=...,t=...,p=...$salt$hash` format so cost parameters can be
raised later and old hashes still verify. scrypt (`scrypt$N$r$p$salt$hash`) is
the fallback where `crypto.argon2` is unavailable, and `verifyPassword` reads
both formats. `verifyPassword` compares with
`crypto.timingSafeEqual`, and when given `undefined` (no such user) it still
runs a dummy hash so response timing doesn't reveal which emails exist.

**Session fixation.** `auth.login(user)` always calls `session.regenerate()`:
new ID, data copied over, the old ID destroyed in id stores.

**Open redirects.** `?next=` only goes through `safeNext` (and the no-JS
redirect after an action through the same `safeBack`): the value must start
with `/`; control characters and backslashes are refused outright (browsers
drop tabs and newlines and read `\` as `/`, so `/\t/evil.com` is
`//evil.com` to them); then the URL parser must agree the result is
same-origin. `//evil.com`, `/\evil.com`, absolute URLs and `javascript:` all
fall back.

## Security model

**Cross-site requests.** Every unsafe method (POST, PUT, PATCH, DELETE) is
checked before routing, actions or not, and refused with 403 when it looks
cross-site:

1. `Origin` in `trustedOrigins`: allowed.
2. `Sec-Fetch-Site` (the browser's own verdict): `cross-site` or `same-site`
   is refused; `same-origin` or `none` is allowed.
3. Without it, `Origin: null` (sandboxed frames, some redirects) is refused.
4. Else `Origin`, or failing that `Referer`, is compared with the `Host` the
   request was sent to (default ports compare equal). With `trustProxy`, the
   first `X-Forwarded-Host` is used instead of `Host`.
5. A request with none of these headers passes: it isn't from a browser page,
   so it can't be carrying a victim's cookies by accident (curl,
   server-to-server).

Options on `yerd({ ... })`: `csrf: false` turns the check off,
`trustedOrigins: ["https://admin.example.com"]` allows other origins,
`trustProxy: true` believes `X-Forwarded-Host` (and `X-Forwarded-Proto` for
session cookies). Only turn `trustProxy` on behind a proxy that sets those
headers and strips any the client sent.

**Action tokens.** An action form's `_yx` token is HMAC-signed with the app
secret, so the class, action and bound args can't be changed or invented. It
also carries:

- **an expiry**, `actionTtl` seconds after render (default 86400, one day);
  an expired token is a 403 ("This form has expired; reload the page");
- **when sessions are on, a hash of a per-session nonce.** The nonce lives in
  the session under `__yerd_csrf` (random, 18 bytes) and is created up front
  for page requests in apps that have actions, because a nonce first set while
  the page streams would come after the session cookie has gone out. A token
  whose nonce hash doesn't match the session is a 403. Tokens carry the hash,
  not the nonce, so page source says nothing about the session.

Tokens in **prerendered** pages carry neither (they were built for nobody):
they're accepted on their signature and the cross-site check alone.

When a form posts several `_yx` values, the server takes the **last**: that's
what makes `<button formaction={action}>` inside `<form action={other}>` call
the button's action.

**Signed args aren't authorization.** A token proves the server rendered
those args, not that this user may act on them: `bind(this.remove, { id })`
still needs the action to check that `this.me` owns `id`. The todo example
does this by scoping every query to the signed-in user.

## How this plugs into actions and islands

- **Guards run on actions too.** An action runs behind its class's guards
  (app, group, route `guards`, class decorators) plus its own method guards,
  so `auth.required` on a group covers every page and action in it.
- **Island RPC carries the session** (planned with islands): same-origin
  `fetch` sends cookies, and the action resolves `@auth.user` like any
  request.
- **Logout as an action.** `@action out() { auth.logout(); return redirect("/login"); }`
  works with and without JS.

## API auth, no cookies (planned)

For machine clients, alongside sessions:

- **Bearer tokens.** `@bearer accessor token!: TokenClaims`. Hand-rolled
  HS256 JWT: header must say `HS256` exactly (no `none`, no algorithm switching),
  `exp` and `nbf` enforced, signature checked with `timingSafeEqual`. About 80
  lines with `node:crypto`. `signToken(claims, { expiresIn })` to mint.
- **API keys.** `apiKeys.create(owner)` returns `yk_<random>` once and stores
  only its SHA-256. Lookup by hash, so a database leak doesn't leak usable keys.
- `auth.required` accepts either a session user or a valid bearer/API key,
  depending on a `strategies` option.

## Stretch (pure bit, still zero runtime deps)

- **OAuth / OIDC login.** Authorization code + PKCE with global `fetch`; `state`
  and `nonce` kept in the session; ID tokens verified against the provider's
  JWKS using `crypto.createPublicKey({ format: "jwk" })`. "Log in with GitHub"
  without an SDK.
- **Passkeys (WebAuthn).** Requires parsing CBOR attestation objects by hand and
  verifying ES256/RS256 signatures with `node:crypto`. Absolutely unnecessary,
  extremely on-brand.
- **TOTP 2FA.** RFC 6238 is ~30 lines of HMAC-SHA1. QR code rendering by hand
  is the real shitpost.

## Files

```
src/session/
  session.ts        Session, SessionData, SessionStore, CookieStore, MemoryStore, seal/unseal
  manager.ts        SessionManager: load and commit per request, cookie naming, expiry
src/actions/
  action.ts         action token signing, expiry and session nonce (checkActionToken, csrfTag), safeBack
src/server/
  app.ts            the cross-site check (crossSiteReason), YerdOptions csrf / trustedOrigins / trustProxy / actionTtl
  request-context.ts csrfNonce(), signAction()
src/auth/
  index.ts          @toyz/yerd/auth: createAuth, safeNext
  password.ts       hashPassword, verifyPassword
```

Planned: `FileStore`, `token.ts` (HS256 JWT, API keys), `<Authorized>`.

## Tests that must exist

- Tampered, truncated and wrong-key cookies are rejected; old secrets still verify after rotation.
- `regenerate()` invalidates the old ID in server-side stores.
- Absolute expiry wins over rolling.
- `safeNext` rejects `//x`, `/\x`, `https://x`, `javascript:`.
- JWT with `alg: none`, `alg: HS512`, expired, or not-yet-valid is rejected (when JWTs land).
- Action posted without a valid token, with an expired one, with one made for another session, or with a foreign `Origin` / `Sec-Fetch-Site`, is rejected.
- A second `createAuth` without its own `sessionKey` throws.
- A guarded class rejects its `@action` methods, not just its `@get`.
- `verifyPassword(x, undefined)` takes roughly as long as a real check.
