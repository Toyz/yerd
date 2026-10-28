# Security

What yerd does to keep the shop safe without being asked, and what stays your job. The [checklist](#checklist) at the end is the short version.

## Secrets

Action tokens are signed and cookie sessions sealed with the app secret. Set `YERD_SECRET` in production, at least 32 bytes:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# rotate: the new secret first, deploy, drop the old one later
YERD_SECRET="new-secret-at-least-32-bytes-long....,old-secret-at-least-32-bytes-long...."
```

- The first secret signs; any listed one verifies, so a rotation breaks nothing.
- `yerd({ secret })` takes a string or a list and wins over the variable. Under 32 bytes stops the boot.

| `NODE_ENV` | Without `YERD_SECRET` |
| --- | --- |
| unset or `development` | a random one saved to `node_modules/.cache/yerd/secret`, so dev restarts keep you signed in |
| `production` | one per process, with a boot warning: restarts empty every cart and break open forms; instances reject each other's cookies |
| anything else (`test`) | one per process, no warning |

Built servers run with `NODE_ENV=production` unless you set it ([deploying](11-deploying.md#yerd_secret)).

## Cross-site requests

Another site can't post to the cart. A POST, PUT, PATCH or DELETE from elsewhere is a 403 before any guard, handler or action runs. With `Origin: https://evil.example`, then `Sec-Fetch-Site: cross-site`:

```answer
POST /cart
_yx=(the remove form's token)
>>>
403 Forbidden
content-type: application/json; charset=utf-8

{"error":"Cross-origin requests are refused","code":"forbidden"}
---
POST /logout
403 Forbidden
content-type: application/json; charset=utf-8

{"error":"Cross-site requests are refused","code":"forbidden"}
```

The checks, in order:

1. An `Origin` in `trustedOrigins` passes.
2. `Sec-Fetch-Site: cross-site` or `same-site` is refused; `same-origin` or `none` passes.
3. `Origin: null` (sandboxed iframes, some redirects) is refused.
4. Otherwise `Origin`, or else `Referer`, must match the `Host` (or `X-Forwarded-Host` with `trustProxy`).
5. A request with none of these headers passes: it can't be a browser carrying a victim's cookies (curl, webhooks).

```ts
yerd({
  trustedOrigins: ["https://admin.paperyard.example"], // other origins allowed to post here
  trustProxy: true, // behind a proxy: compare against X-Forwarded-Host
  // csrf: false,   // turns the check off entirely
});
```

- It's the main CSRF defense: for visitors without a session (unbound tokens), it and `SameSite` cookies are what stop a cross-site form.
- With `csrf: false`, plain POST handlers, sessionless actions (the login form) and prerendered tokens are open. Turn it off only when something in front does the same job.
- GET and HEAD are never checked, so GET handlers change nothing: a link, an `<img>` or a [prefetch](06-interactivity.md#prefetching) can send one.
- `same-site` counts as cross-site: `shop.example.com` can't post to `api.example.com` unless it's trusted.

> [!TAKE]
> There's no CSRF token to remember. Every write is checked by origin and every action is signed, so a form you forgot about is covered too. You give up cross-site posts you didn't list in `trustedOrigins`.

## Action tokens

The cart's remove button is bound to one product: `() => this.remove({ id: product.id })`. Its `_yx` token names the class, action and argument, signed with HMAC-SHA256. Its first half, decoded:

```json
{"c":"CartPage","a":"remove","p":{"id":7},"e":1792443115,"s":"crsxcqNGN3UqUzSN0ZTMIX"}
```

Change `7` to `2` and keep the signature, or post someone else's token:

```answer
POST /cart
_yx=(the remove form's token, its id changed to 2)
>>>
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Invalid action signature","code":"bad_request"}
---
POST /cart
_yx=(another visitor's remove token)
>>>
403 Forbidden
content-type: application/json; charset=utf-8

{"error":"This form was made for a different session; reload the page and try again","code":"forbidden"}
```

- **Can't be forged.** Changing the action or an argument breaks the signature: a 400.
- **Readable.** Signed, not encrypted: anyone holding the page can read the arguments. Bind ids, not secrets.
- **Expires** after `actionTtl` seconds (`e`, default 86400): a 403 asking for a reload, which the runtime does ([stale pages](#stale-pages)).
- **Bound to the session** (`s`): a visitor with a session gets tokens tied to its nonce, and a leaked one is the 403 above. Turn sessions on if forms matter.
- **Forms never start a session.** A visitor without one gets an unbound token and no cookie, so pages stay cacheable. An unbound token works only while there's still no session.
- **Signing in renews the nonce.** `regenerate()` (called by `auth.login()`) and `clear()` make earlier forms stale; after a scripted action starts or rotates the session, the runtime re-fetches the page's tokens.
- **Prerendered pages** have tokens with no expiry and no session: only the signature and the cross-site check protect them. Keep signed-in actions off them, or check the user in the action.

> [!WARNING]
> A signed token proves your server rendered those arguments, not that this user may act on them: pages change hands (a shared screen, a stale tab after logout). The receipt page checks: `orders.get(id, user)` treats another user's order as missing.

### Values the browser fills in

`el.value`, `ref("#x").checked` and `drag.data("id")` in an action lambda are browser input, like form fields; only where they go is signed. Validate them, for example with [parse](api:yerd.parse):

```tsx
class MoveCard {
  @is.string({ validate: matches(/^c\d+$/, "Not a card id") }) card!: string;
  @is.oneOf(["todo", "doing", "done"]) to!: "todo" | "doing" | "done";
}

// rendered: <section action={({ drag }) => this.move({ card: drag.data("id"), to: "done" })} trigger="drop">
@action move(args: { card: string; to: string }) {
  const { card, to } = parse(MoveCard, args); // `card` came from the browser; `to` was signed
  // ...
}
```

### Stale pages

When a token is expired, signed with a dropped secret, or made for another session (or for none, and the visitor now has one), the runtime gets a `yx-stale` response, re-fetches the page and asks the user to try again. The action didn't run, so retrying is safe. Without JavaScript it's the 403 page.

## Sessions

The cart's cookie, over plain HTTP, then over HTTPS:

```answer
POST /products/7
_yx=(the form's token)
>>>
303 See Other
location: /products/7
set-cookie: yerd_session=VOz5FmKh...; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax
---
POST /products/7
_yx=(the form's token)
>>>
303 See Other
location: /products/7
set-cookie: __Host-yerd_session=kYJUuUXO...; Max-Age=1209600; Path=/; HttpOnly; Secure; SameSite=Lax
```

- **Sealed.** The default [CookieStore](api:yerd.CookieStore) encrypts and authenticates the cookie with AES-256-GCM. Id stores seal only a random id; `MemoryStore` keys records by its hash, so a store dump can't be replayed.
- **Its own key**, separate from [seal()](api:yerd.seal) / [unseal()](api:yerd.unseal): nothing your app seals passes for a session.
- **Cookie flags.** `HttpOnly`, `SameSite=Lax`, `Path=/`; over HTTPS also `Secure` and the `__Host-` prefix, which stops subdomains planting it. Behind a proxy, set `trustProxy` ([deploying](11-deploying.md#behind-a-proxy)).
- **Expiry.** `maxAge` idle (14 days, the `Max-Age` above) and `absoluteMaxAge` from creation (30 days, never extended).
- **Not cached.** HTML for a visitor with a session gets `Cache-Control: private, no-cache` unless you set your own. Making a page with forms cacheable yourself? Send `Vary: Cookie`: its tokens belong to whoever it was rendered for.

The rest is in [sessions and auth](09-sessions-and-auth.md).

### Signing in and out

[createAuth](api:auth.createAuth)'s `login(user)` rotates the session id (no session fixation) and starts afresh if a different user was signed in, so their cart never reaches the next. `logout()` destroys the session and cookie; an id whose user is gone is dropped. See [login and logout](09-sessions-and-auth.md#login-and-logout).

### Passwords

The shop hashes the demo password at boot and checks it on sign-in:

```ts
// src/users.ts
@onBoot async seed() {
  this.#users.push({ id: "u1", name: DEMO_ACCOUNT.name, passwordHash: await hashPassword(DEMO_ACCOUNT.password) });
}

// src/routes/auth.tsx
// Spends a full hash even for unknown names, so timing doesn't reveal who has an account.
if (!(await verifyPassword(input.password, user?.passwordHash)) || !user) {
  return this.#fail("Wrong username or password.", input.name);
}
```

```text
$argon2id$v=19$m=19456,t=2,p=1$FFENKpfSnIu5lEaCDdoaLQ$0fLU1TYPg4-yeaz57BE8C9UIDRZLbJ1xBL6c6S4kDII
```

- [hashPassword](api:auth.hashPassword) uses argon2id at OWASP's minimum (19 MiB, 2 passes), in PHC format so the parameters can be raised later.
- [verifyPassword](api:auth.verifyPassword) compares in constant time. Pass it `undefined` for an unknown user, as above.

## Redirects

Sign-in sends the visitor back to `?next=`, but a link to `/login?next=//evil.example` can't bounce them off-site:

```answer
POST /login?next=//evil.example
_yx=(the form's token)&name=ada&password=analytical-engine
>>>
303 See Other
location: /
set-cookie: yerd_session=cqr108Ui...; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax
```

| `safeNext(...)` gets | It returns |
| --- | --- |
| `/checkout`, `/orders/1001?x=1` | the same |
| `//evil.example`, `/\evil.example`, `https://evil.example`, `javascript:alert(1)` | `/` |

- [safeNext](api:auth.safeNext) passes only same-site paths; `/\t/evil.com` and paths that normalize to `//host` fall back too. Run every `?next=` through it.
- [redirect()](api:yerd.redirect) doesn't check where it points (it percent-encodes non-ASCII and refuses line breaks), so never pass it a request URL without `safeNext`.
- A no-JavaScript action redirects back to the form's page, from a same-host `Referer` only, checked like `safeNext`.
- The client runtime never navigates to `javascript:`, `data:` or `vbscript:` URLs.

## Output

A search for `<script>alert(1)</script>` comes back as text, in the box and in the message:

```answer
GET /?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E
200 OK
content-type: text/html; charset=utf-8

<!-- ... --><input type="search" name="q" value="&lt;script&gt;alert(1)&lt;/script&gt;" placeholder="Search" aria-label="Search"><!-- ... --><p class="empty">Nothing matches &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;.</p><!-- ... -->
```

- **Escaping.** Text and attributes always are; [raw()](api:yerd.raw) is the only way around. URL attributes block `javascript:`, `vbscript:` and `data:` (`" java\tscript:"` too); [json()](api:yerd.json) makes data safe in inline scripts. See [what renders how](05-pages-and-layouts.md#what-renders-how).
- **Headers.** Values with line breaks, NUL or other control characters are refused, so request data can't split a response. Every response gets `X-Content-Type-Options: nosniff`.
- **Errors.** A non-`YerdError` is a 500 saying `Internal Server Error`; message and stack go to the log. `YerdError` messages show below 500. Stacks on the [error page](05-pages-and-layouts.md#error-pages) in development only.
- **Logs.** Fields named like secrets (`password`, `token`, `cookie`...) are redacted; see [logging](10-logging.md#redaction-and-limits).

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
- No secrets in action arguments: tokens are readable.
- Values from `el`, `ref()` and `drag` validated like form fields.
- GET handlers change nothing.
- Every `?next=` goes through `safeNext`; `redirect()` never gets a raw URL from the request.
- `raw()` only on trusted or sanitized HTML.
- `trustProxy` only behind a proxy that sets the forwarded headers and strips the client's.
- `trustedOrigins` lists only origins you control.
- Separate `sessionKey`s for separate kinds of sign-in.
- `bodyLimit` raised only as far as your uploads need.
- The error page shows `error.stack` only outside production.
