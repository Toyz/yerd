# Deploying

This page covers building and running a yerd app in production, with or without Vite, plus static files, environment variables, proxies and shutdown.

## With Vite (recommended)

The Vite plugin gives you a dev server with reloads and a one-command production build. Install `vite` and `esbuild` as dev dependencies, then:

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

The entry default-exports the app and doesn't call `listen()`: the plugin runs it for you, in dev and in production.

| Option | Default | Meaning |
| --- | --- | --- |
| `entry` | `"/src/main.ts"` | module whose default export is the yerd app |
| `client` | `[]` | client build entries (stylesheets, assets), relative to the Vite root; hashed in production |
| `outDir` | `"dist"` | build output directory, relative to the Vite root |

See [YerdViteOptions](api:vite.YerdViteOptions). The plugin also lowers TC39 decorators with esbuild, because Vite's own transformer doesn't support them yet.

## Dev: vite

```sh
npx vite
```

One server, one port: Vite serves its assets and yerd gets everything else. When you change a server file, the next request stops the old app (hosted services, timers, `@onShutdown`, disposal), re-imports your code and serves from the fresh app. Boot errors show up in Vite's error overlay.

## Build: vite build

```sh
npx tsc --noEmit && npx vite build
node dist/server/server.js
```

Vite's `base` option carries through: with `base: "/app/"` the built server serves the client files under `/app/` and every asset URL (`assetUrl()`, `<Stylesheet>`, the `css` stylesheet from `<Styles />`) points there; with a full URL (`base: "https://cdn.example.com/"`) the links go to the CDN while the server still serves the files from `/` for the CDN to pull. Your routes keep their own paths either way.

Vite doesn't type-check, so run `tsc --noEmit` first. The built server runs with `NODE_ENV=production` unless you set it to something else, so production behavior (JSON logs, no stack traces, the missing-secret warning) is the default. The build writes:

```text
dist/
  client/                   your `client` entries, hashed, plus prerendered pages
    .vite/manifest.json
    .yerd/prerendered.json
  server/
    server.js               the entry to run: serves dist/client, listens on PORT
    prerender.js            the app without listening, used during the build
```

- `server.js` listens on `PORT` (default 3000) and `HOST` (default: all interfaces).
- Link stylesheets with `<Stylesheet href="src/styles.css" />` (or `assetUrl()`). In production they resolve through the manifest to hashed file names.
- Files in `public/` (Vite's `publicDir`) are copied into `dist/client` as they are and served from the site root: `public/robots.txt` is `/robots.txt`, in dev and production. Refer to them by their path from `public/`: `assetUrl("favicon.svg")` or plain `/favicon.svg`, never `public/favicon.svg`. In development, `assetUrl()` warns about that mistake, about missing files, and about source files missing from `client` (they'd work in dev and 404 after the build). See [assets](05-pages-and-layouts.md#assets).
- Routes marked `@prerender` are rendered to HTML files in `dist/client` at build time and served as files from then on. See [05-pages-and-layouts.md](05-pages-and-layouts.md).
- The client runtime (`/_yerd/runtime.js`) isn't a build output. The server generates it from its own source, compresses it once (brotli and gzip, about 8 KB), and serves it with an `ETag` so browsers get a cheap 304 on later pages.

> [!NOTE]
> Vite's server build leaves packages from `node_modules` (yerd included) as imports. Deploy `dist/` together with `package.json` and production dependencies (`npm ci --omit=dev`). yerd itself has no dependencies, so that's small.

## Without Vite: tsc and node

yerd runs on plain `tsc` output too. Call `listen()` yourself and discover routes from the compiled directory.

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
- `listen(port, host?)` resolves once `@onBoot` hooks have run and the port is open. It returns `{ server, url, close }`.
- There's no client build in this mode: link plain files from `public/` yourself.

## Static files

`app.static(prefix, dir)` serves files from a directory. Routes always win; files fill the URLs no route matched.

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

- Hashed names like `app-C8SwBHde.css` get `public, max-age=31536000, immutable`. Everything else gets `no-cache` and revalidates with its `ETag` (a 304 when unchanged).
- If `style.css.br` or `style.css.gz` sits next to `style.css` and the client accepts it, yerd serves the precompressed file. yerd doesn't create them; your build step does.
- Traversal (`..`, encoded or not), NUL bytes and dotfiles are refused.

- A request for a directory (`/`, `/docs/`) gets its `index.html`. Turn that off with `{ index: false }`. Routes still win: a `/` route answers before the file.

## Environment variables

| Variable | Used for |
| --- | --- |
| `YERD_SECRET` | signing action tokens and sealing cookie sessions; comma-separated list to rotate, newest first, each at least 32 bytes ([security](15-security.md#secrets)) |
| `YERD_LOG` | log filter, e.g. `info,UserRepo=debug` ([10-logging.md](10-logging.md#filtering-with-yerd_log)) |
| `YERD_LOG_FORMAT` | `pretty` or `json` console output |
| `NODE_ENV` | `production`: JSON logs by default and a boot warning if `YERD_SECRET` is missing; `test`: default log level `warn` |
| `PORT`, `HOST` | where the Vite-built `server.js` listens |
| `NO_COLOR` | no colors in pretty logs |

> [!WARNING]
> Set `YERD_SECRET` in production. Without it every process invents its own secret, so restarts log everyone out and multiple instances reject each other's forms and cookies.

## Behind a proxy

Behind nginx, a load balancer or a platform router, tell yerd to believe the forwarded headers.

```ts
yerd({
  trustProxy: true,
  trustedOrigins: ["https://admin.example.com"],
});
```

- `trustProxy` makes the cross-site check compare against `X-Forwarded-Host`, and makes sessions use `X-Forwarded-Proto` to decide on `Secure` cookies (with the `__Host-` prefix).
- `trustedOrigins` lists other origins allowed to send POST, PUT, PATCH and DELETE requests.

> [!WARNING]
> Only turn on `trustProxy` behind a proxy that sets those headers and strips any the client sent. Otherwise anyone can claim to be on HTTPS or on your host.

## Graceful shutdown

`listen()` handles `SIGINT` and `SIGTERM` for you. On a signal, yerd:

1. stops accepting connections and closes idle keep-alive sockets;
2. ends long-lived streams (SSE, NDJSON) and waits for in-flight requests;
3. aborts `@hosted` services and `@every` timers and waits for them;
4. runs `@onShutdown` hooks (newest first), disposes singletons and flushes the logger;
5. exits with code 0 (1 if shutdown failed).

Steps 2 and 3 each wait at most `shutdownTimeout` (default 10 seconds). After that, remaining connections are cut and shutdown carries on.

```ts
import { yerd } from "@toyz/yerd";

const server = await yerd({ shutdownTimeout: 5_000, handleSignals: false }).listen(3000);

process.on("SIGTERM", async () => {
  await server.close(); // same steps, but you decide when to exit
  process.exit(0);
});
```

Pass `handleSignals: false` (to `yerd()` or as `listen(port, host, { handleSignals: false })`) when something else owns the process's signals, like a test runner or your own supervisor.

## Before you go live

Run through the [security checklist](15-security.md#checklist): a real `YERD_SECRET`, sessions on, `trustProxy` only behind a proxy that sets the headers, and actions that check who may do what. With several instances, sessions need a shared store (or the default cookie store) and events need a [transport](14-events.md#several-instances-and-other-apps); channels need a [backend](07-streaming-and-live.md#channels).
