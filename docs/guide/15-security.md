# Security

What yerd does to keep an app safe by default, what each protection covers, and what stays your job. The [checklist](#checklist) at the end is the short version.

## Secrets

Action tokens are signed and cookie sessions sealed with the app secret. Set `YERD_SECRET` in production, at least 32 bytes:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```sh
# rotate: put the new secret first, deploy, drop the old one later
YERD_SECRET="new-secret-at-least-32-bytes-long....,old-secret-at-least-32-bytes-long...."
```

- New tokens and sessions use the first secret; any listed secret is accepted, so a rotation breaks nothing.
- `yerd({ secret })` takes a string or a list and wins over the variable.
- A secret shorter than 32 bytes stops the app from booting.

Without a secret, yerd makes a random one:

| `NODE_ENV` | Without `YERD_SECRET` |
| --- | --- |
| unset or `development` | saved to `node_modules/.cache/yerd/secret` and reused, so dev restarts keep you signed in |
| `production` | one per process, with a boot warning: every restart signs everyone out and breaks open forms, and instances reject each other's cookies |
| anything else (`test`) | one per process, no warning |

Built servers run with `NODE_ENV=production` unless you set it.

## Cross-site requests

Every POST, PUT, PATCH and DELETE from another site is refused with a 403 before any guard, handler or action runs. In order:

1. An `Origin` in `trustedOrigins` passes.
2. `Sec-Fetch-Site: cross-site` or `same-site` is refused; `same-origin` or `none` passes.
3. `Origin: null` (sandboxed iframes, some redirects) is refused.
4. Otherwise `Origin`, or else `Referer`, must match the `Host` (or `X-Forwarded-Host` with `trustProxy`).
5. A request with none of these headers passes: it can't be a browser carrying a victim's cookies (curl, webhooks, server-to-server).

```ts
import { yerd } from "@toyz/yerd";

export const app = yerd({
  trustedOrigins: ["https://admin.example.com"], // other origins allowed to post here
  trustProxy: true, // behind a proxy: compare against X-Forwarded-Host
  // csrf: false,   // turns the check off entirely
});
```

- This is the main CSRF defense. For visitors without a session (whose tokens aren't bound to anyone) it and `SameSite` cookies are what stop another site posting a form.
- With `csrf: false`, plain POST handlers, sessionless actions (a login form) and prerendered tokens are open to cross-site posts. Only turn it off when something in front of the app does the same job.
- GET and HEAD are never checked, so GET handlers must not change anything: a link, an `<img>` or a [prefetch](06-interactivity.md#prefetching) can send one.

> [!NOTE]
> `same-site` counts as cross-site: `shop.example.com` can't post to `api.example.com` unless it's in `trustedOrigins`.

## Action tokens

Every action carries a `_yx` token, HMAC-SHA256-signed, naming the route class, the action and its bound arguments.

- **Can't be forged.** Changing the action or `{ id: 7 }` to `{ id: 8 }` breaks the signature: a 400.
- **Expires** after `actionTtl` seconds (default 86400). An expired form is a 403 asking the user to reload; the runtime does it for them (see [stale pages](#stale-pages)).
- **Bound to the session.** With sessions on, a visitor with a session gets tokens tied to its nonce, and a token leaked to anyone else is a 403. Turn sessions on if forms matter.
- **Forms never start a session.** A visitor without one gets an unbound token and no cookie, so pages stay cacheable and crawlers don't fill the store. An unbound token is accepted only while the visitor still has no session.
- **Signing in renews the nonce.** `regenerate()` (called by `auth.login()`) and `clear()` make earlier forms stale. When a scripted action starts or rotates the session, the runtime re-fetches the page's tokens in the background, so other forms don't go stale.
- **Prerendered pages** have tokens with no expiry and no session, protected only by the signature and the cross-site check. Keep actions that need a signed-in user off them, or check the user in the action.

> [!WARNING]
> A signed token proves your server rendered those arguments, not that this user may act on them. An action bound to `{ id }` must still check that the signed-in user owns `id`: pages change hands (a shared screen, a stale tab after logout).

### Values the browser fills in

`el.value`, `ref("#x").checked` and `drag.data("id")` in an action lambda are browser input, like form fields; only where they go is signed. Validate them, for example with [parse](api:yerd.parse):

```tsx
import { Region, action, get, is, matches, parse, route } from "@toyz/yerd";

class MoveCard {
  @is.string({ validate: matches(/^c\d+$/, "Not a card id") }) card!: string;
  @is.oneOf(["todo", "doing", "done"]) to!: "todo" | "doing" | "done";
}

@route("/board")
export class Board {
  @get page() {
    return (
      <Region id="board">
        <section action={({ drag }) => this.move({ card: drag.data("id"), to: "done" })} trigger="drop">Done</section>
      </Region>
    );
  }

  @action move(args: { card: string; to: string }) {
    const { card, to } = parse(MoveCard, args); // `card` came from the browser; `to` was signed
    console.log(`move ${card} to ${to}`);
  }
}
```

### Stale pages

When a token is expired, signed with a dropped secret, or made for another session (or for none, and the visitor now has one), the runtime gets a `yx-stale` response, re-fetches the page with fresh tokens and asks the user to try again. The action didn't run, so retrying is safe. Without JavaScript the user gets the 403 page.

## Sessions

- **Sealed.** The default [CookieStore](api:yerd.CookieStore) encrypts and authenticates the cookie with AES-256-GCM. Id stores keep only a random id in the sealed cookie; `MemoryStore` keys records by a hash of it, so a store dump can't be replayed.
- **Its own key.** The session cookie key is separate from [seal()](api:yerd.seal) / [unseal()](api:yerd.unseal), so nothing your app seals passes for a session.
- **Cookie flags.** `HttpOnly`, `SameSite=Lax`, `Path=/`; over HTTPS also `Secure` with the `__Host-` prefix, which stops subdomains planting it. Behind a proxy, set `trustProxy` (see [deploying](11-deploying.md#behind-a-proxy)).
- **Expiry.** `maxAge` idle (14 days) and `absoluteMaxAge` from creation (30 days, never extended).
- **Crashes don't save**, so a half-finished login never sticks.
- **Not cached.** HTML for a request carrying a session cookie gets `Cache-Control: private, no-cache` unless the handler set its own. If you mark a page with forms cacheable yourself, send `Vary: Cookie`: its tokens are for whoever it was rendered for.

The full behaviour and options are in [sessions and auth](09-sessions-and-auth.md).

### Signing in and out

[createAuth](api:auth.createAuth)'s `login(user)` rotates the session id (stopping session fixation) and starts a fresh session if a different user was signed in, so their data never reaches the next user. `logout()` destroys the session and cookie. An id whose user no longer exists is dropped on the next request. See [login and logout](09-sessions-and-auth.md#login-and-logout).

### Passwords

- [hashPassword](api:auth.hashPassword) uses argon2id (OWASP's minimum: 19 MiB, 2 passes), scrypt where Node lacks it, in PHC format so parameters can be raised later.
- [verifyPassword](api:auth.verifyPassword) compares in constant time. Pass it `undefined` for an unknown user so timing doesn't reveal which accounts exist.

## Redirects

- [safeNext](api:auth.safeNext) passes only same-site paths. `//evil.com`, `/\evil.com`, `/\t/evil.com`, `https://...`, `javascript:` and paths that normalize to `//host` become the fallback (`"/"`). Run every `?next=` through it.
- [redirect()](api:yerd.redirect) doesn't check where it points (it percent-encodes non-ASCII and refuses line breaks), so never pass it a request URL without `safeNext`.
- A no-JavaScript action redirects back to the form's page, from a same-host `Referer` only, checked like `safeNext`.
- The client runtime never navigates to `javascript:`, `data:` or `vbscript:` URLs.

## Output

- **Escaping.** Text and attributes are always escaped. [raw()](api:yerd.raw) is the only way around it; never pass it unsanitized user input.
- **URL attributes.** `javascript:`, `vbscript:` and `data:` URLs (including tricks like `" java\tscript:"`) become `about:blank#blocked`; `data:image/...` is allowed on `src` and `poster`.
- **Inline scripts.** Pass data with [json()](api:yerd.json); text that would end the element early throws.
- **Headers.** Values with line breaks, NUL or other control characters are refused, so request data can't split a response.
- **Errors.** A non-`YerdError` is a 500 with body `Internal Server Error`; message and stack go to the log only. `YerdError` messages are shown below 500. Show stacks on the [error page](05-pages-and-layouts.md#error-pages) in development only.
- **Logs.** Fields named like secrets (`password`, `token`, `cookie`, ...) are redacted; see [logging](10-logging.md#redaction-and-limits).

## Input

- **Validation.** Bad values are a 400 before your handler. DTOs drop undeclared keys (no sneaking in `isAdmin: true`), and `__proto__` is plain data. See [request data](03-request-data.md).
- **URLs.** [is.url()](api:yerd.is.url) accepts only http and https unless you list others.
- **Size.** Bodies over `bodyLimit` (1 MiB) are a 413 before your code runs; `maxSize` and `types` limit uploads. Streamed NDJSON is limited per line.
- **Static files.** `app.static()` refuses `..` (encoded or not), NUL bytes, dotfiles and symlinks leaving the folder.

## Client-side code

- **CSP.** [Local](api:yerd.Local) handlers are compiled in the browser and need `'unsafe-eval'` under a strict Content-Security-Policy. Without `Local`, `script-src 'self'` is enough for the runtime and its `/_yerd/` chunks.
- **Shipped as source.** `Local` handlers and [custom attributes](06-interactivity.md#custom-attributes)' client halves are public and can't see server variables.

## Checklist

- `YERD_SECRET` set in production, at least 32 bytes, out of git.
- `app.sessions()` on, so action tokens are bound to a visitor.
- Every action checks that the signed-in user may touch what its arguments name.
- Values from `el`, `ref()` and `drag` validated like form fields.
- GET handlers change nothing.
- Every `?next=` goes through `safeNext`; `redirect()` never gets a raw URL from the request.
- `raw()` only on trusted or sanitized HTML.
- `trustProxy` only behind a proxy that sets the forwarded headers and strips the client's.
- `trustedOrigins` lists only origins you control.
- Separate `sessionKey`s for separate kinds of sign-in.
- `bodyLimit` raised only as far as your uploads need.
- The error page shows `error.stack` only outside production.
