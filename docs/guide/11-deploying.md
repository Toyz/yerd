# Deploying

Paperyard in production: build it, give it a secret, put it behind a proxy, and stop it without dropping a sale.

## Build and run

The shop builds with Vite. Without Vite, `tsc` compiles it and your own entry calls `listen()`.

```sh tab="Vite"
npx tsc --noEmit                 # Vite doesn't type-check
npm run shop:build               # vite build --config examples/shop/vite.config.ts
npm run shop:start               # node examples/shop/dist/server/server.js
```

```answer
GET /assets/styles-Cc5pgYZc.css
200 OK
content-type: text/css; charset=utf-8
cache-control: public, max-age=31536000, immutable
etag: W/"b6c-1a150c553f7"
```

```ts tab="tsc and node"
// src/server.ts. Run: npx tsc && node dist/server.js
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const server = await createApp()
  .discover(new URL("./routes/", import.meta.url))
  // No client build: serve the stylesheet from the source folder.
  .static("/src", fileURLToPath(new URL("../src/", import.meta.url)), { extensions: [".css"] })
  .listen(Number(process.env.PORT ?? 3000), process.env.HOST);

console.log(`listening on ${server.url}`);
```

```answer
GET /src/styles.css
200 OK
content-type: text/css; charset=utf-8
cache-control: no-cache
etag: W/"d7d-1a150c0c4d6"
```

- With Vite, `<Stylesheet>` links the hashed file, cached for a year; without, the source file, revalidated each time.
- `discover(url)` imports every `.js` and `.mjs` file under the directory. `listen()` resolves once `@onBoot` hooks have run and the port is open.
- The Vite entry (`src/main.ts`) never calls `listen()`: the plugin runs the app, in dev and in the build.

## What vite build writes

`npm run shop:build`, trimmed:

```text
examples/shop/dist/client/.vite/manifest.json         0.18 kB │ gzip: 0.13 kB
examples/shop/dist/client/assets/styles-Cc5pgYZc.css  2.92 kB │ gzip: 1.15 kB
examples/shop/dist/server/prerender.js                0.05 kB │ gzip: 0.07 kB
examples/shop/dist/server/server.js                   0.63 kB │ gzip: 0.39 kB
examples/shop/dist/server/assets/main-BkytboDM.js   503.13 kB │ gzip: 133.53 kB
```

| File | What |
| --- | --- |
| `dist/client/` | your `client` entries, hashed, plus `public/` files, prerendered pages and the sitemap |
| `dist/server/server.js` | the entry to run: serves `dist/client`, listens on `PORT` (3000) and `HOST` (all interfaces) |
| `dist/server/prerender.js` | the app without listening, used during the build |

- The shop's server bundle is 500 kB because it aliases yerd's source in. A real app leaves `@toyz/yerd` an import: deploy `dist/` with `package.json` and `npm ci --omit=dev` (yerd has no dependencies).
- `server.js` sets `NODE_ENV=production` unless you did: JSON logs, no stack traces, the missing-secret warning.
- `<Stylesheet>` and `assetUrl()` go through the manifest; see [assets](05-pages-and-layouts.md#assets). `@prerender` routes become HTML files ([prerendering](05-pages-and-layouts.md#prerendering)).
- Vite's `base` carries through: `/app/` moves client files under `/app/`; a full URL (a CDN) points links there while the server still serves the files. Routes keep their paths.
- The runtime is served from `/_yerd/` with its chunks; a CDN serving `/_yerd/` must keep them together.

| Plugin option | Default | Meaning |
| --- | --- | --- |
| `entry` | `"/src/main.ts"` | module whose default export is the yerd app |
| `client` | `[]` | client build entries (stylesheets, assets), hashed in production. `*.client.ts` modules are added for you |
| `outDir` | `"dist"` | build output directory, relative to the Vite root |

See [YerdViteOptions](api:vite.YerdViteOptions). The plugin also lowers TC39 decorators with esbuild, which Vite can't yet.

> [!TAKE]
> The build is a Node server, not a bundle for a platform: `node dist/server/server.js` behind any proxy is the whole deploy. You give up serverless targets out of the box; [app.fetch()](api:yerd.YerdApp/fetch) is the handler if you want to wire one.

## In development

`npm run shop` (`vite`) is one server on one port: Vite serves its assets and yerd gets everything else.

- Changing a module the app imports (`?url` and `?raw` imports count) or adding one restarts the app on the next request, with a full shutdown and fresh boot.
- Stylesheets linked with `assetUrl()`, `public/` files, and files the app reads or writes with `node:fs` don't restart it. Boot errors show in Vite's overlay.

## YERD_SECRET

Carts live in sealed cookies and forms carry signed tokens. Started without a secret, the build says what that costs:

```text
{"t":"2026-10-18T20:48:06.383Z","level":"warn","target":"yerd::boot","msg":"no YERD_SECRET set; using a random secret, so forms and sessions break across restarts and instances"}
yerd listening on http://localhost:3917
```

```sh
export YERD_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
npm run shop:start
```

| Variable | Used for |
| --- | --- |
| `YERD_SECRET` | signing action tokens and sealing cookie sessions; a comma-separated list to rotate, newest first, each at least 32 bytes ([security](15-security.md#secrets)) |
| `YERD_LOG` | log filter, e.g. `info,Orders=debug` ([logging](10-logging.md#filtering-with-yerd_log)) |
| `YERD_LOG_FORMAT` | `pretty` or `json` console output |
| `NODE_ENV` | `production`: JSON logs and the missing-secret warning; `test`: default log level `warn` |
| `PORT`, `HOST` | where the Vite-built `server.js` listens |
| `NO_COLOR` | no colors in pretty logs |

> [!WARNING]
> Without `YERD_SECRET`, every restart empties every cart and signs everyone out, and instances reject each other's forms. Keep the real one out of git.

## Behind a proxy

Behind nginx, a load balancer or a platform router, tell yerd to believe the forwarded headers.

```ts
// src/app.ts
export function createApp(options?: YerdOptions) {
  return yerd({ trustProxy: true, trustedOrigins: ["https://admin.paperyard.example"], ...options })
  // ...
}
```

- `trustProxy` makes the [cross-site check](15-security.md#cross-site-requests) compare against `X-Forwarded-Host`, sessions use `X-Forwarded-Proto` for `Secure` (`__Host-`) cookies, and [ctx.ip](api:yerd.YerdContext.ip) is the last `X-Forwarded-For` entry.
- `trustedOrigins` lists other origins allowed to send POST, PUT, PATCH and DELETE.
- Idle keep-alive connections stay open 72 s, longer than load balancers keep theirs (an AWS ALB's 60 s): a server that closes first turns the balancer's next request on that connection into a 502. If yours waits longer, raise `timeouts.keepAlive` past it (`headers` follows, a second longer).

> [!WARNING]
> Only turn on `trustProxy` behind a proxy that sets those headers and strips any the client sent; otherwise anyone can claim HTTPS or your host.

## Compression

Most proxies and CDNs compress responses. Without one in front, [app.compression()](api:yerd.YerdApp.compression) does it:

```ts
// src/app.ts
return yerd(options).compression() // brotli, else gzip, as the browser accepts
```

- Pages, JSON, CSS, JS, SVG and other text over 1 KB (`threshold`) are compressed; images, fonts and archives aren't (they're compressed already).
- A streamed page is compressed chunk by chunk, each flushed, so the top of the page still arrives before slow parts render.
- Left alone: precompressed static files (`app.js.br`), yerd's runtime script (compressed once and kept), SSE and other long-lived streams, HEAD, and `Cache-Control: no-transform`.
- Brotli runs at quality 4 (`brotliQuality`), gzip at level 6 (`gzipLevel`): most of the saving for little CPU per response. Behind a proxy that compresses, leave it off; doing it twice costs CPU for nothing.

## HTTPS without a proxy

`listen()` serves HTTPS itself when given a certificate:

```ts
// src/server.ts
await createApp().listen(443, undefined, {
  tls: { key: readFileSync("/etc/tls/privkey.pem"), cert: readFileSync("/etc/tls/fullchain.pem") },
});
```

- `tls` takes [node:https's server options](https://nodejs.org/api/https.html#httpscreateserveroptions-requestlistener): `key` and `cert`, or `pfx`, or an `SNICallback` for several hosts. Without one, `listen()` throws.
- The connection itself is TLS, so no `trustProxy` is needed: `ctx.url` is https, cookies are `Secure` and [security headers](15-security.md#security-headers) include HSTS.
- Graceful shutdown works the same. Renewed certificates need a restart (or `server.server.setSecureContext(...)`).
- Plain HTTP on port 80 redirecting to HTTPS is a second, tiny server; most deployments leave both to a proxy or the platform.

## Static files

[app.static(prefix, dir)](api:yerd.YerdApp/static) serves a directory for URLs no route matched, as the tsc entry does.

| Option | Default | Meaning |
| --- | --- | --- |
| `extensions` | all | only serve these, e.g. `[".css"]` when pointing at a source folder |
| `dotfiles` | `false` | serve names starting with `.` |
| `cacheControl` | see below | `(path) => string` for the `Cache-Control` header |
| `followSymlinks` | `false` | serve symlinks pointing outside the directory |
| `index` | `true` | serve a directory's `index.html` |

- Hashed names get `public, max-age=31536000, immutable`, the rest `no-cache` and an `ETag` (the two answers above).
- A precompressed `.br` or `.gz` next to a file is served when the client accepts it.
- Traversal (`..`, encoded or not), NUL bytes and dotfiles are refused.

## Graceful shutdown

A deploy sends `SIGTERM` while someone may be mid-checkout and product pages hold stock feeds. Stopping the shop with one feed open:

```text
yerd listening on http://localhost:3918
14:48:20.807  INFO request{method=GET path=/} status=200 3.86ms
14:48:20.813  INFO request{method=GET path=/products/7} status=200 1.28ms
14:48:21.115  INFO request{method=GET path=/products/7/stock} status=200 298.12ms
```

The feed is ended (its access line lands then), and the process exits with code 0. On `SIGINT` or `SIGTERM`, `listen()`'s server:

1. stops accepting connections and closes idle keep-alive sockets;
2. ends long-lived streams (SSE, NDJSON, cues) and waits for in-flight requests;
3. aborts `@hosted` services and `@every` timers and waits for them;
4. runs `@onShutdown` hooks (newest first), disposes singletons and flushes the logger;
5. exits with code 0 (1 if shutdown failed).

Steps 2 and 3 each wait at most `shutdownTimeout` (10 s), then cut what's left. To decide when to exit yourself:

```ts
const server = await createApp({ shutdownTimeout: 5_000, handleSignals: false }).listen(3000);

process.on("SIGTERM", async () => {
  await server.close(); // the same steps
  process.exit(0);
});
```

Pass `handleSignals: false` when a test runner or supervisor owns the signals.

If the port can't be bound (`EADDRINUSE`, `EACCES`), `listen()` rejects with that error after stopping the app: `@hosted` services and `@every` timers end and `@onShutdown` hooks run, so nothing keeps a server that never started alive. An app you `start()`ed yourself before calling `listen()` keeps running.

## Before you go live

- `npx tsc --noEmit` passes; the build ran with `NODE_ENV=production`.
- `YERD_SECRET` is set, 32 bytes or more, the same on every instance.
- `trustProxy` is on only behind a proxy that strips the client's forwarded headers.
- With several instances: sessions in the cookie store or a shared one, events on a [transport](14-events.md#several-instances-and-other-apps), channels on a [backend](07-streaming-and-live.md#channels) (or the stock feed only reaches pages on the same instance).
- For search engines, a [sitemap and robots.txt](18-sitemaps.md) with your public origin.
- The rest of the [security checklist](15-security.md#checklist).
