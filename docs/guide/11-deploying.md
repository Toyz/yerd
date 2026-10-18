# Deploying

Building and running in production, with or without Vite, plus static files, environment variables, proxies and shutdown.

## With Vite (recommended)

The Vite plugin gives you a reloading dev server and a one-command production build. Install `vite` and `esbuild` as dev dependencies, then:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import yerd from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerd({ entry: "/src/main.ts", client: ["src/styles.css"] })],
});
```

```ts
// src/main.ts
/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";

export default yerd()
  .sessions()
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

The entry default-exports the app and doesn't call `listen()`; the plugin runs it in dev and production.

| Option | Default | Meaning |
| --- | --- | --- |
| `entry` | `"/src/main.ts"` | module whose default export is the yerd app |
| `client` | `[]` | client build entries (stylesheets, assets), relative to the Vite root; hashed in production. `*.client.ts` modules are added for you |
| `outDir` | `"dist"` | build output directory, relative to the Vite root |

See [YerdViteOptions](api:vite.YerdViteOptions). The plugin also lowers TC39 decorators with esbuild, which Vite can't yet.

## Dev: vite

```sh
npx vite
```

- One server, one port: Vite serves its assets and yerd gets everything else.
- Changing a module the app imports (a `?url` or `?raw` import counts) or adding a module restarts the app on the next request, with a full shutdown and fresh boot.
- Stylesheets linked with `assetUrl()`, `public/` files, and files the app reads with `node:fs` or writes don't restart it.
- Boot errors show in Vite's error overlay.

## Build: vite build

```sh
npx tsc --noEmit && npx vite build
node dist/server/server.js
```

Vite doesn't type-check, so run `tsc --noEmit` first. The build writes:

```text
dist/
  client/                   your `client` entries, hashed, plus prerendered pages
    .vite/manifest.json
    .yerd/prerendered.json
  server/
    server.js               the entry to run: serves dist/client, listens on PORT
    prerender.js            the app without listening, used during the build
```

- `server.js` listens on `PORT` (default 3000) and `HOST` (default all interfaces), with `NODE_ENV=production` unless you set it (JSON logs, no stack traces, the missing-secret warning).
- `<Stylesheet>` and `assetUrl()` resolve through the manifest to hashed names; see [assets](05-pages-and-layouts.md#assets) for `public/` files and the dev warnings.
- Files in `public/` are copied to `dist/client` and served from the site root (`public/robots.txt` is `/robots.txt`).
- `@prerender` routes become HTML files in `dist/client` (see [prerendering](05-pages-and-layouts.md#prerendering)).
- Vite's `base` carries through: with `base: "/app/"` client files and asset URLs live under `/app/`; with a full URL (a CDN) links point there while the server still serves the files from `/` for the CDN to pull. Routes keep their own paths.
- The client runtime ships prebuilt in the package and is served from `/_yerd/` with its chunks. If a proxy or CDN serves `/_yerd/` from elsewhere, keep the chunks next to `runtime.js`.

> [!NOTE]
> Vite's server build leaves `node_modules` packages (yerd included) as imports. Deploy `dist/` with `package.json` and production dependencies (`npm ci --omit=dev`); yerd itself has none.

## Without Vite: tsc and node

On plain `tsc` output, call `listen()` yourself and discover routes from the compiled directory.

```ts
// src/server.ts
import { yerd } from "@toyz/yerd";

const server = await yerd()
  .sessions()
  .discover(new URL("./routes/", import.meta.url))
  .static("/", "public")
  .listen(Number(process.env.PORT ?? 3000), process.env.HOST);

console.log(`listening on ${server.url}`);
```

```sh
npx tsc
node dist/server.js
```

- `discover(url)` imports every `.js` and `.mjs` file under the directory, recursively, before boot.
- `listen(port, host?)` resolves once `@onBoot` hooks have run and the port is open, returning `{ server, url, close }`.
- There's no client build: link plain files from `public/` yourself.

## Static files

`app.static(prefix, dir)` serves files from a directory for URLs no route matched.

```ts
yerd()
  .static("/", "public")
  .static("/src", "src", { extensions: [".css"] })
  .static("/downloads", "files", { cacheControl: () => "public, max-age=3600" });
```

| Option | Default | Meaning |
| --- | --- | --- |
| `extensions` | all | only serve these, e.g. `[".css"]` when pointing at a source folder |
| `dotfiles` | `false` | serve names starting with `.` |
| `cacheControl` | see below | `(path) => string` for the `Cache-Control` header |
| `followSymlinks` | `false` | serve symlinks pointing outside the directory |
| `index` | `true` | serve a directory's `index.html` |

- Hashed names like `app-C8SwBHde.css` get `public, max-age=31536000, immutable`; everything else `no-cache` with an `ETag`.
- A precompressed `style.css.br` or `.gz` next to `style.css` is served when the client accepts it (your build makes them).
- Traversal (`..`, encoded or not), NUL bytes and dotfiles are refused.

## Environment variables

| Variable | Used for |
| --- | --- |
| `YERD_SECRET` | signing action tokens and sealing cookie sessions; comma-separated list to rotate, newest first, each at least 32 bytes ([security](15-security.md#secrets)) |
| `YERD_LOG` | log filter, e.g. `info,UserRepo=debug` ([logging](10-logging.md#filtering-with-yerd_log)) |
| `YERD_LOG_FORMAT` | `pretty` or `json` console output |
| `NODE_ENV` | `production`: JSON logs by default and a boot warning if `YERD_SECRET` is missing; `test`: default log level `warn` |
| `PORT`, `HOST` | where the Vite-built `server.js` listens |
| `NO_COLOR` | no colors in pretty logs |

> [!WARNING]
> Set `YERD_SECRET` in production, or restarts log everyone out and instances reject each other's forms and cookies.

## Behind a proxy

Behind nginx, a load balancer or a platform router, tell yerd to believe the forwarded headers.

```ts
yerd({
  trustProxy: true,
  trustedOrigins: ["https://admin.example.com"],
});
```

- `trustProxy` makes the cross-site check use `X-Forwarded-Host`, and sessions use `X-Forwarded-Proto` for `Secure` (`__Host-`) cookies.
- `trustedOrigins` lists other origins allowed to send POST, PUT, PATCH and DELETE.

> [!WARNING]
> Only turn on `trustProxy` behind a proxy that sets those headers and strips any the client sent; otherwise anyone can claim HTTPS or your host.

## Graceful shutdown

`listen()` handles `SIGINT` and `SIGTERM`. On a signal, yerd:

1. stops accepting connections and closes idle keep-alive sockets;
2. ends long-lived streams (SSE, NDJSON, cues) and waits for in-flight requests;
3. aborts `@hosted` services and `@every` timers and waits for them;
4. runs `@onShutdown` hooks (newest first), disposes singletons and flushes the logger;
5. exits with code 0 (1 if shutdown failed).

Steps 2 and 3 each wait at most `shutdownTimeout` (10 s), then cut what's left.

```ts
import { yerd } from "@toyz/yerd";

const server = await yerd({ shutdownTimeout: 5_000, handleSignals: false }).listen(3000);

process.on("SIGTERM", async () => {
  await server.close(); // same steps, but you decide when to exit
  process.exit(0);
});
```

Pass `handleSignals: false` (to `yerd()` or `listen(port, host, { handleSignals: false })`) when a test runner or supervisor owns the signals.

## Before you go live

Run through the [security checklist](15-security.md#checklist). With several instances, sessions need a shared store (or the default cookie store), events a [transport](14-events.md#several-instances-and-other-apps), and channels a [backend](07-streaming-and-live.md#channels).

For search engines, turn on a [sitemap and robots.txt](18-sitemaps.md) with your public origin.
