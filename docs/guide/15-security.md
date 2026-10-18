# Security

This page collects what yerd does to keep an app safe by default, what each protection does and doesn't cover, and the few things that stay your job. Most of it needs no code. The checklist at the end is the short version.

## Secrets

Action tokens are signed and cookie sessions are sealed with the app secret. Set it in production with `YERD_SECRET`, at least 32 bytes:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```sh
# rotate: put the new secret first, deploy, drop the old one later
YERD_SECRET="new-secret-at-least-32-bytes-long....,old-secret-at-least-32-bytes-long...."
```

New tokens and sessions use the first secret; any listed secret is accepted, so open forms and existing sessions keep working through a rotation. `yerd({ secret })` takes a string or a list and wins over the variable. A secret shorter than 32 bytes stops the app from booting.

Without a secret, yerd makes a random one:

| `NODE_ENV` | Without `YERD_SECRET` |
| --- | --- |
| unset or `development` | a random secret saved to `node_modules/.cache/yerd/secret` and reused, so restarting the dev server keeps you signed in |
| `production` | a random secret per process, with a warning at boot: every restart signs everyone out and breaks open forms, and two instances reject each other's cookies |
| anything else (`test`) | a random secret per process, no warning |

Built servers (`vite build`) run with `NODE_ENV=production` unless you set it, so the warning shows up where it matters.

## Cross-site requests

Every POST, PUT, PATCH and DELETE is checked before any guard, handler or action runs. A browser request from another site is refused with a 403:

1. An `Origin` listed in `trustedOrigins` passes.
2. `Sec-Fetch-Site: cross-site` or `same-site` is refused; `same-origin` or `none` passes. Modern browsers send this header on every request.
3. `Origin: null` (a sandboxed iframe, some redirects) is refused.
4. Otherwise `Origin`, or failing that `Referer`, must match the `Host` (or `X-Forwarded-Host` with `trustProxy`).
5. A request with none of these headers passes. It can't be a browser carrying a victim's cookies: curl, server-to-server calls and webhooks look like this.

```ts
import { yerd } from "@toyz/yerd";

export const app = yerd({
  trustedOrigins: ["https://admin.example.com"], // other origins allowed to post here
  trustProxy: true, // behind a proxy: compare against X-Forwarded-Host
  // csrf: false,   // turns the check off entirely
});
```

> [!NOTE]
> `same-site` counts as cross-site: `shop.example.com` can't post to `api.example.com` unless it's in `trustedOrigins`. A subdomain you don't control fully (user content, a marketing site) shouldn't be able to post with your users' cookies.

GET and HEAD are never checked, which is why GET handlers must not change anything: a link, an `<img>`, or a [prefetch](06-interactivity.md#prefetching) can make a browser send one.

## Action tokens

Every action form (and every element with an `action`) carries a `_yx` token, HMAC-SHA256-signed with the secret. It names the route class, the action and its bound arguments.

- **Can't be forged.** A visitor can't call another action, or change `{ id: 7 }` to `{ id: 8 }`: the signature breaks and the request is a 400.
- **Expires.** After `actionTtl` seconds (default 86400, a day). An expired form gets a 403 asking the user to reload; with the client runtime the page refreshes itself (see [stale pages](#stale-pages)).
- **Bound to the session.** With sessions on, the token carries a hash of a per-session nonce. A token rendered for one visitor is a 403 for anyone else, so a token leaked from a page (a screenshot, a shared HTML file) is useless to others. Turn sessions on even if you don't otherwise need them, if forms matter.
- **Prerendered pages** are built for no one, so their tokens have no expiry and no session. They're protected by the signature and the cross-site check only. Keep actions that need a signed-in user off prerendered pages, or check the user in the action.

> [!WARNING]
> A signed token proves your server rendered those arguments. It doesn't prove this user may act on them: an action bound to `{ id }` must still check that the signed-in user owns `id`. The token was rendered for whoever was looking at the page, and pages change hands (a shared screen, a stale tab after logout).

### Values the browser fills in

An action lambda that reads `el.value`, `ref("#x").checked` or `drag.data("id")` leaves holes in the token. Where each value goes is signed; what it contains comes from the browser, like any form field. Validate it before use, for example with [parse](api:yerd.parse):

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

When the secret changed, the server was redeployed, or a token expired, the client runtime gets a `yx-stale` response, fetches the page again with fresh tokens and tells the user to try again. The action didn't run, so retrying is safe. Without JavaScript the user gets the 403 page.

## Sessions

- **Sealed.** The default [CookieStore](api:yerd.CookieStore) keeps the data in the cookie, encrypted and authenticated with AES-256-GCM: visitors can't read or change it. [MemoryStore](api:yerd.MemoryStore) and other id stores keep only a random id in the (also sealed) cookie, and `MemoryStore` keys its records by a hash of the id, so a dump of the store can't be replayed as cookies.
- **Cookie flags.** Always `HttpOnly`, `SameSite=Lax` and `Path=/`. Over HTTPS also `Secure`, with the `__Host-` name prefix, which stops a subdomain from planting the cookie. Behind a proxy, set `trustProxy` so yerd believes `X-Forwarded-Proto`; see [deploying](11-deploying.md#behind-a-proxy).
- **Expiry.** `maxAge` idle time (14 days by default, refreshed on activity) and `absoluteMaxAge` from creation (30 days, never extended).
- **Crashes don't save.** If a request ends in an unhandled crash (anything but an `HttpError`), its session changes are thrown away, so a half-finished login or update never sticks.
- **Not cached.** HTML pages sent to someone with a session get `Cache-Control: private, no-cache` unless the handler set its own, so neither a shared cache nor the browser's Back button replays a signed-in page to the wrong person.

### Signing in and out

[createAuth](api:auth.createAuth)'s `login(user)`:

1. **Rotates the session id** (`regenerate()`), so an id someone planted or saw before login is worthless afterwards (session fixation).
2. **Starts a fresh session when the user changes.** If someone else was signed in on this browser (a shared computer, no logout), their session data is dropped, not handed to the new user. A guest's data (a cart) does carry over, and `onLogin` can merge it.
3. Stores the user's id, then runs `onLogin`.

`logout()` runs `onLogout`, then destroys the session and its cookie. An id whose user no longer exists is dropped from the session on the next request. Two kinds of sign-in in one app (users and admins) must use different `sessionKey`s; a second `createAuth()` on the same key throws. Details in [sessions and auth](09-sessions-and-auth.md#login-and-logout).

### Passwords

[hashPassword](api:auth.hashPassword) uses argon2id (OWASP's minimum: 19 MiB, 2 passes) where Node has it and scrypt otherwise, in PHC format, so parameters can be raised later and old hashes still verify. [verifyPassword](api:auth.verifyPassword) compares in constant time. Pass it `undefined` for an unknown user: it still runs a full hash, so response time doesn't reveal which accounts exist.

## Redirects

- [safeNext](api:auth.safeNext) only lets same-site paths through. `//evil.com`, `/\evil.com`, `/\t/evil.com`, `https://...`, `javascript:` and paths that normalize to `//host` all become the fallback (default `"/"`). Run every `?next=` through it.
- [redirect()](api:yerd.redirect) sends whatever you give it (non-ASCII is percent-encoded, and line breaks are refused). It doesn't check where it points, so never pass it a URL from the request without `safeNext`.
- After an action without JavaScript, yerd redirects back to the page the form was on, taken from `Referer` only when it's the same host, and checked like `safeNext`.
- `auth.required` sends browsers to `loginPath?next=<the page>`. Read it back with `safeNext`.
- The client runtime never navigates to a `javascript:`, `data:` or `vbscript:` URL, whatever a response says.

## Output

- **Escaping.** Text and attribute values are always escaped. [raw()](api:yerd.raw) is the only way around it: never pass it anything a user typed unless you sanitized it.
- **URL attributes.** `href`, `src`, `action`, `formaction` and friends turn `javascript:`, `vbscript:` and `data:` URLs into `about:blank#blocked` (`data:image/...` is allowed on `src` and `poster`), including tricks like `" java\tscript:"`.
- **Inline scripts.** `<script>` and `<style>` contents are raw text. Hand data to a script with [json()](api:yerd.json), which escapes `<`, `>` and `&`. Text that would end the element early (`</script`) throws at render time.
- **Headers.** A header value with a line break, NUL or other control character is refused before it's written, so request data can't split a response.
- **Errors.** A thrown error that isn't an `HttpError` is a 500 with the body `Internal Server Error`; its message and stack go to the log only. `HttpError` messages are shown below 500 and hidden from 500 up (`expose`). The error page gets the thrown error as `error`; show its stack in development only (see [error pages](05-pages-and-layouts.md#error-pages)).
- **Logs.** Fields named like secrets (`password`, `token`, `authorization`, `cookie`, `session`...) are redacted before any sink sees them. See [logging](10-logging.md#redaction-and-limits).

## Input

- **Validation.** Bad values are a 400 before your handler sees them. DTO classes drop keys they don't declare, so a client can't sneak `isAdmin: true` into a model you `Object.assign`. A field named `__proto__` is plain data. See [request data](03-request-data.md).
- **URLs.** [is.url()](api:yerd.is.url) only accepts http and https unless you list other protocols, so a profile link can't be `javascript:alert(1)`.
- **Size.** Bodies over `bodyLimit` (1 MiB by default) are a 413 before your code runs; `maxSize` and `types` limit each upload (413, 415). Streamed NDJSON bodies are limited per line.
- **Static files.** `app.static()` refuses `..` (encoded or not), NUL bytes, dotfiles and symlinks that leave the folder.

## Client-side code

- **CSP.** [Local](api:yerd.Local) handlers are compiled in the browser, which needs `'unsafe-eval'` under a strict Content-Security-Policy. Without `Local`, the runtime is a plain module script from your own origin (`script-src 'self'`).
- **Shipped as source.** `Local` handlers and the client halves of [custom attributes](06-interactivity.md#custom-attributes) are sent to the browser as their source text. They can't see server variables, and anything you write in them is public.

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
