# Building and running a yerd app

**Vite is the build path.** It's the default, the one the scaffold sets up, the
one yerd's own examples use, and the one every feature is designed and tested
against first. Raw mode exists for people (and jokes) that want no build tool
beyond tsc, and it's deliberately small. A full hand-written yerd builder is
parked in [BUILDER.md](BUILDER.md) as a maybe-later.

| | **Vite mode** (default, primary) | **Raw lite** (tsc only) |
|---|---|---|
| Scaffold | `npm create @toyz/yerd my-app` | `npm create @toyz/yerd my-app -- --raw` |
| Dev | `npm run dev` -> `vite` | `npm run dev` -> `yerd dev` |
| Build | `npm run build` -> `tsc --noEmit && vite build` | `npm run build` -> `yerd build` |
| Run | `npm start` -> `node dist/server/server.js` | `npm start` -> `node dist/server/main.js` |
| Client JS | Vite bundles islands, hashed chunks, CSS, assets | tsc output, unbundled; hashed via import map remapping |
| CSS / assets | `import "./x.css"`, CSS modules, asset imports | plain files in `public/`, linked by hand |
| HMR | yes, server and islands | none; server restarts, browser reloads |

Both modes run the same app code. Switching modes is a config change, not a
rewrite. (Today only Vite mode is built, without islands; raw lite, the CLI
and the scaffold are design. See [Status](#status-2026-10-17).)

**In both modes the user runs one build command and gets server and client
output.** There's no separate client build, client tsconfig or island naming
convention to maintain. yerd works out the client side from the app: `@island`
registrations tell it which modules run in the browser, the import scan tells it
what they pull in, and it compiles that set with browser settings by itself
(Vite mode via Vite's client environment, raw lite via a second `tsc` run).

The rule still holds: **`@toyz/yerd` has no `dependencies`**. Vite and
TypeScript are the user's devDependencies; yerd's Vite plugin uses whichever
versions the app installed (declared as optional `peerDependencies`, so nothing
is pulled in for raw-lite users).

## Vite mode

```ts
// vite.config.ts
import { defineConfig } from "vite";
import yerd from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerd({ entry: "/src/main.ts", client: ["src/styles.css"] })],
});
```

Plugin options, all optional:

| Option   | Default          | Is                                                      |
|----------|------------------|---------------------------------------------------------|
| `entry`  | `"/src/main.ts"` | module whose default export is the yerd app             |
| `client` | `[]`             | client build entries relative to the Vite root (stylesheets and other assets used through `assetUrl()` / `<Stylesheet>`), hashed in production |
| `outDir` | `"dist"`         | build output directory, relative to the Vite root      |

The decorator transform is also exported on its own as `yerdDecorators({
clientTarget })` (client esbuild target, default `"es2016"`).

```ts
// src/main.ts -- same file in both modes
import { yerd } from "@toyz/yerd";

export default yerd()
  .sessions()
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
// no .listen() needed under Vite: the plugin mounts the app. Raw lite calls .listen(3000).
```

`discover()` accepts either a directory URL (raw lite, `fs.readdir` + `import()`)
or the object `import.meta.glob(..., { eager: true })` returns (Vite mode). In
both cases importing the files is what registers the decorators.

### `vite` (dev)

One server, one port:

- The plugin adds a middleware to Vite's dev server that hands requests to
  yerd's Node handler (`app.handle(req, res)`, a plain `node:http` handler). Vite
  serves assets, `/@vite/client` and island modules; yerd serves routes.
- The server side is loaded through Vite's SSR module runner (Environment API),
  so route classes, services and components get Vite's transforms and module
  graph.
- **Server reload.** Decorators register into global registries on import, so
  naive re-import would register every route twice. When a watched file
  changes, is added or is removed, the next request stops the old app
  (hosted services, timers, `@onShutdown`, singleton disposal), resets the
  route, service, guard and custom attribute registries, clears the runner's
  module cache and re-imports the entry. Every route, guard, service, group
  and attribute comes back from scratch. Reloads are serialized: requests that
  arrive during one wait for the new app. A failed import leaves the app
  marked stale, so the next request starts clean. The plugin runs its own
  module runner with HMR off (Vite's default SSR runner re-executes entries
  on change, which raced the reload and registered routes twice), and resets
  the registries through the loaded app's `resetRegistries()`: from
  node_modules, Vite externalizes `@toyz/yerd` for the app's code, so the
  plugin's own import of it would be a different copy. Closing Vite stops the
  app. A test (test/unit/vite-dev.test.ts) edits a temp app twice and checks
  all of this. (Planned: reloading the
  browser, or refetching just the regions when the change was in a component
  inside a `<Region>`.)
- **Island HMR (planned).** Island modules go through Vite's normal client HMR. Live
  islands of the changed class are re-instantiated with their current `@state`
  carried over when field names still match, then morphed.
- Island `data-src` points at the dev-server URL of the source file
  (`/src/components/counter.tsx`), so Vite compiles it on request.
- Boot validation errors (unknown guard, captive dependency, `@param` not in the
  path) show in Vite's error overlay, not only the terminal.

### `vite build`

One command, two outputs, using Vite's multi-environment build:

```
dist/
  client/              the plugin's client entries (CSS, assets; islands planned), hashed
    .vite/manifest.json
    .yerd/prerendered.json   @prerender paths -> files written next to them
  server/
    server.js          generated entry: the app's code as an SSR bundle (not
                       minified), importing yerd and other packages from
                       node_modules (Vite's default), so deploy them alongside;
                       serves dist/client, listens on PORT (and HOST)
    prerender.js       the app without listening, used for build-time prerendering
```

The yerd client runtime isn't a build output: the server generates
`/_yerd/runtime.js` from its own source at run time.

- **Client environment.** Built today from the `client` option. Planned: the
  plugin finds every `@island` module (from the
  registry after a build-time import of the app) and feeds them to Vite as
  client entries, plus the yerd client runtime. Vite bundles, splits shared
  code, hashes. Package `exports` resolve with browser conditions, so islands
  get the client twins of `@toyz/yerd/client` and `@toyz/yerd/kit` automatically.
- **Server environment.** Bundles `src/main.ts`. Node conditions pick the server
  twins. Minification is off so `@instrument` parameter names and readable stack
  traces survive.
- **Manifest wiring.** At runtime yerd reads `dist/client/.vite/manifest.json`:
  island `data-src` becomes the hashed chunk URL, and each page gets
  `<link rel="modulepreload">` for the islands it actually rendered, plus
  `<link rel="stylesheet">` for CSS those modules imported.
- **CSS.** `import "./card.css"` in a component works, server components
  included: the SSR manifest says which CSS belongs to which module, and yerd
  emits links only for what the page rendered. CSS modules work too, since Vite
  handles them.
- **Static.** `dist/client` is served by yerd's static handler, with
  `Cache-Control: immutable` for hashed files.
- `npm start` is just `node dist/server/server.js`. No Vite at runtime.

### Server code can't leak into the client bundle

Raw lite protects this with the boot-time client graph scan (DYNAMICS.md). In
Vite mode the same rule moves to build time: the plugin's `resolveId` hook in
the client environment fails the build if an island's import chain reaches
`node:*`, the server entry `@toyz/yerd`, `@toyz/yerd/auth`, or a module that
called `provide()`. The error prints the chain, same format as raw lite:
`components/cart.tsx -> lib/prices.ts -> lib/db.ts -> node:fs`.

### The compiler question

Settled by the M0 spikes ([SPIKES.md](SPIKES.md)): Vite 8 transforms TS with
Oxc, and Oxc only lowers *legacy* decorators, passing TC39 `@dec` and `accessor`
through untouched. Node 26 can't run that. TypeScript 7 (the Go compiler) has no
`transpileModule` or other emit API to call per file. Several yerd features
need the transform to get these right:

| Feature                              | Depends on                                     |
|--------------------------------------|------------------------------------------------|
| TC39 decorators, `accessor`, `context.metadata` | the transformer supporting stage 3 decorators |
| Browser `AsyncLocalStorage` across `await` | async downleveled to `__awaiter` (ES2016 target) |
| Sprinkles via `fn.toString()`        | handler source being runnable JS (any compiler), JSX helper names |
| `@instrument` parameter names        | unminified source with original param names    |

So the plugin sets `oxc: false` for app TS and runs a pre-transform with
**esbuild's `transform`**, which lowers TC39 decorators, `accessor` and
`context.metadata` exactly like tsc (spike 6/7), per file, fast. Targets per
environment: ES2022 for SSR, ES2016 for the client (so `async` becomes
generators for the async-context polyfill). JSX uses the automatic runtime
with `jsxImportSource: "@toyz/yerd"`. Sprinkle scope defines both `_jsx` and
`jsx` helper names so tsc-compiled and esbuild-compiled handlers both run.

`esbuild` is the app's devDependency and an optional peer of `@toyz/yerd`.
When Oxc gains TC39 decorator support, the plugin can switch to it behind the
same startup check (transform the decorator test file, run it, compare).

**Type checking.** Vite doesn't type-check, and yerd's typed params, `Json` prop
constraints and typed guard names only exist at type level. The scaffold's
`build` script runs `tsc --noEmit` first (TS 7 is fast enough that this
barely registers). A planned `typecheck` option would run `tsc --noEmit
--watch` as a child process during dev and forward its errors to the overlay
(no `vite-plugin-checker` dep).

## Raw lite (tsc only, planned)

For apps that want no build tool but tsc. Small on purpose: it's the minimum
that keeps islands working and safe, not a second Vite.

- `yerd build`, one command (drives the `tsc` binary; TS 7 has no emit API):
  1. `tsc` with the app's `tsconfig.json` (server, ES2022, to `dist/server/`)
  2. derive the client graph from `@island` registrations + import scan
  3. server-leak check and browser type-check (no `@types/node`)
  4. compile the client graph again with `tsc` and a generated tsconfig at ES2016 to `dist/client/`
  5. content-hash client files and write a Vite-shaped manifest; the page's
     import map remaps each module URL to its hashed file, so imports are never
     rewritten
  6. copy `public/`
- `yerd dev`: `tsc --watch` + both compiles + a supervised `node` process that
  restarts on change, plus a tiny SSE script that reloads the page after a
  restart. No HMR.
- **Not supported in raw lite:** `import "./x.css"`, CSS modules, asset imports,
  `import.meta.env`. Use `public/` and plain `<link>`/`<img>`; boot reports a
  clear error pointing at Vite mode if an app imports CSS or assets.
- Islands load through the native import map, with `modulepreload` for the
  islands a page rendered.

One example in yerd's repo runs in raw lite so it stays tested; everything else
uses Vite.

If raw lite turns out to be fun, [BUILDER.md](BUILDER.md) is the design for
growing it into a real builder (CSS and asset transformers, island HMR over SSE,
full-closure preloads, compression, `yerd bundle`, `yerd minify`).

## The `yerd` CLI (planned)

Shipped as the package's `bin`, plain Node, works in both modes:

| Command            | Does                                                        |
|--------------------|-------------------------------------------------------------|
| `yerd dev`         | raw-lite dev loop (Vite mode uses `vite`)                   |
| `yerd build`       | raw-lite build (Vite mode uses `vite build`)                |
| `yerd routes`      | print the route table, guard order, layout chain; `--types` writes `.yerd/*.d.ts` |
| `yerd check`       | run boot validation without starting a server (good for CI) |
| `yerd secret`      | print a fresh 32-byte secret for `YERD_SECRET`              |

In Vite mode, `yerd routes` and `yerd check` load the app through Vite's module
runner so they see exactly what `vite dev` sees.

## `npm create @toyz/yerd` (planned)

A `create-yerd` package (published as `@toyz/create-yerd`, same pattern as
loom's `create-loom`). Hand-written, `node:fs` + `node:readline`, zero deps:

- asks: Vite or raw, sessions on/off, include `yerd/auth`, example island
- writes `package.json` with scripts for the chosen mode, `tsconfig.json`
  (`jsxImportSource: "@toyz/yerd"`, decorators; one tsconfig, no client project),
  `vite.config.ts` if Vite, `src/main.ts`, a route, a layout, an island
- prints the three commands: `npm install`, `npm run dev`, `npm run build`

## Package additions (planned)

```json
{
  "name": "@toyz/yerd",
  "bin": { "yerd": "./dist/cli/index.js" },
  "exports": {
    "./vite": { "types": "./dist/vite/index.d.ts", "import": "./dist/vite/index.js" }
  },
  "peerDependencies": { "vite": ">=8", "esbuild": ">=0.25", "typescript": ">=7" },
  "peerDependenciesMeta": {
    "vite": { "optional": true }, "esbuild": { "optional": true }, "typescript": { "optional": true }
  },
  "dependencies": {}
}
```

The plugin imports only types from `vite` (erased by tsc) and loads `esbuild`
with a dynamic `import()`. `typescript` is only ever run as the `tsc` binary.

## Status (2026-10-17)

Built: the plugin's `client` and `outDir` options, `vite build` producing
`dist/client` (hashed client entries, `.vite/manifest.json`) and
`dist/server/server.js` (generated entry: `app.clientBuild(...)`, then
`listen(PORT)`), `app.static()`, `assetUrl()` / `<Stylesheet>`. Not yet:
islands as client entries, modulepreload links, CSS discovered from server
component imports (stylesheets are listed in `client` for now), raw-lite
hashing.

## M0 results

See [SPIKES.md](SPIKES.md). Dev server + SSR module runner + esbuild decorator
transform works on Vite 8. Still open: the client environment build of islands
and manifest wiring (M6), and module runner invalidation for server HMR (M5).
