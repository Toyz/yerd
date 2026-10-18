# The yerd builder

> **Status: parked.** Vite is yerd's build path (see [BUILD.md](BUILD.md)), and
> raw mode ships as "raw lite": tsc, client graph compile, import-map hashing,
> nothing else. This doc is the design for growing raw lite into a full builder
> later, if that turns out to be worth doing. Nothing here is scheduled.
>
> **TS 7 caveat (M0):** TypeScript 7 has no JS compiler API, so the custom
> transformer design below would need TS 6.x via an npm alias or another engine.

Raw mode's build tool, written by hand. The only compile engine is the
TypeScript compiler API (the app's own `typescript`), extended with custom
transformers. No esbuild, no Rollup, no Vite. tsc was already masking as a
template engine; now it's masking as a bundler too.

The user runs `npm run build` (`yerd build`) or `npm run dev` (`yerd dev`) and
never touches the builder directly.

## What it does

```
yerd build
  1. load      tsconfig.json (+ optional yerd.config.ts)
  2. server    ts.Program, emit ES2022 to dist/server/, transformers:
                 strip CSS imports, assets -> URLs, define
  3. graph     import the built server app once (no listen), read @island
               registrations, scan emitted imports -> client graph
  4. check     client graph: server-leak check, type-check without @types/node
  5. client    second ts.Program over the client graph only, emit ES2016,
               transformers: same as server + import.meta.env (public vars)
  6. assets    CSS + images + fonts referenced by any module: copy, hash
  7. hash      content-hash every client file
  8. manifest  dist/yerd-manifest.json: module -> hashed URL, imports, CSS
  9. compress  precompressed .br and .gz next to every client file (node:zlib)
 10. public    copy public/ to dist/client/
```

Output:

```
dist/
  server/              node runs this: node dist/server/main.js
  client/              served under /_yerd/
    m/components/counter.3f2a9c.js
    m/components/counter.3f2a9c.js.br
    css/card.81bd02.css
    assets/logo.c0ffee.png
  yerd-manifest.json
```

## Hashing without rewriting imports

Every emitted client module keeps its plain relative imports
(`import { x } from "./util.js"`). The builder doesn't rewrite them. Instead
the page's import map remaps every module URL to its hashed file:

```html
<script type="importmap">
{ "imports": {
    "@toyz/yerd/client": "/_yerd/client/index.9e1f.js",
    "@toyz/yerd/kit":    "/_yerd/kit/index.44aa.js",
    "/_yerd/m/components/counter.js": "/_yerd/m/components/counter.3f2a9c.js",
    "/_yerd/m/components/util.js":    "/_yerd/m/components/util.d10e77.js"
} }
</script>
```

Import maps remap URL-like specifiers, not just bare names, so relative imports
resolve to the hashed files with zero source rewriting. Hashed files get
`Cache-Control: immutable`; deploying changes the hashes, the import map changes
with it, the HTML is never cached long. Only modules the page can reach are
listed (the graph knows), so the map stays small.

## No waterfall, still no bundling

Unbundled ESM's classic problem: the browser discovers imports one level at a
time. The builder knows the whole graph, so for each island a page renders,
yerd emits `<link rel="modulepreload">` for that island's **entire** import
closure in one go. The browser fetches everything in parallel on the first
round trip. With HTTP/2 or HTTP/1.1 keep-alive that's close enough to a bundle
for a site with islands, and every file stays individually cacheable.

## Transformers

Custom `ts.TransformerFactory`s passed to `program.emit()`. This is where the
builder actually does builder things, inside tsc:

| Transformer        | Does                                                                 |
|--------------------|----------------------------------------------------------------------|
| `css`              | `import "./card.css"` removed from JS; file recorded on the module's manifest entry. Pages link CSS only for modules they rendered (server components included). |
| `cssModules`       | `import s from "./card.module.css"` becomes an object of hashed class names; CSS rewritten with a small hand-written selector scanner. |
| `assets`           | `import logo from "./logo.png"` becomes the hashed URL string. Types come from `declare module "*.png"` etc. shipped in `@toyz/yerd`. |
| `define`           | `import.meta.env.YERD_PUBLIC_X` replaced with literals in client builds; only `YERD_PUBLIC_*` vars, so secrets can't be inlined into browser code by accident. `import.meta.env.DEV` / `PROD` on both sides. |
| `jsxDev`           | dev only: source file + line on elements, so render errors point at TSX. |
| `strip`            | removes `@devOnly` blocks and `import.meta.env.DEV` dead branches in prod. |

Node can't import `.css` or `.png` either, so the same transformers run on the
server build. Nothing Vite-specific is needed for `import "./x.css"` to work in
a server component.

## `yerd dev`

- **Incremental.** `ts.createWatchProgram` with `incremental: true` and a
  `.tsbuildinfo`; a save recompiles changed files only. Client graph recomputed
  only when an import edge or `@island` changes.
- **Server changes.** Restart the server process (`node:child_process`, the
  builder supervises it). ESM modules can't be unloaded, so in-process
  re-import would leak; a restart is a few hundred ms and always correct.
  Sessions survive if the store does (`FileStore` / cookie store do).
- **Island HMR.** Island modules are native ESM, so hot reload is: re-import the
  changed module with a `?t=<time>` query, swap the class on live islands,
  carry `@state` when field names match, morph. Pushed over an SSE endpoint the
  dev server exposes (`/_yerd/dev`), with a tiny client script injected in dev.
- **CSS changes** swap the `<link>` href in place, no reload.
- **Errors.** Type and boot errors go to the terminal and to an overlay rendered
  by yerd itself into the page (a yerd component, obviously).
- No hashing or compression in dev; source maps on.

## Manifest: one shape for both builders

`dist/yerd-manifest.json` uses the same shape as Vite's
`.vite/manifest.json` (file, imports, css, isEntry). yerd's runtime has one
code path, "read manifest, map island module to URL, emit preloads and CSS
links", whichever builder produced it. Raw mode and Vite mode only differ at
build time.

## Config

Optional. Zero-config is the default; `yerd.config.ts` only when needed:

```ts
import { defineConfig } from "@toyz/yerd/builder";

export default defineConfig({
  entry: "src/main.ts",
  publicDir: "public",
  outDir: "dist",
  publicEnvPrefix: "YERD_PUBLIC_",
  compress: ["br", "gzip"],
  transformers: [myTransformer],   // extra ts.TransformerFactory, user's own
});
```

The config file itself is TypeScript, loaded by compiling it with
`ts.transpileModule` and importing the result from a temp file.

## Builder rules

- **tsc is the only compiler.** Everything a transformer does happens on tsc's
  AST through the public compiler API. If something can't be done that way, it
  doesn't go in the builder.
- **Uses the app's `typescript`.** The builder loads it with a dynamic
  `import()`; `@toyz/yerd` still has no `dependencies`.
- **Deterministic output.** Same input, same hashes, same manifest. Tested.
- **The server-leak check is part of the build**, not an option.

## Stretch (pure bit)

- **`yerd bundle`**: actual bundling. Concatenate each island's closure into
  one file with a hand-written module wrapper (a 30-line registry like the old
  CommonJS bundlers). Optional, for HTTP/1.1-without-keep-alive hosting
  nightmares.
- **`yerd minify`**: comment and whitespace removal via the TS printer, then
  local identifier mangling with scope analysis from the type checker. Absurd
  amount of work for a few KB. Very on-brand.
- **Builder plugins**: a hook API so libraries can ship transformers.

## Files

```
src/builder/
  index.ts          yerd build / yerd dev orchestration
  program.ts        ts.Program setup per environment (server ES2022, client ES2016)
  graph.ts          import scanner, client graph, closures for preloads
  transformers/     css, cssModules, assets, define, jsxDev, strip
  hash.ts           content hashing (node:crypto), deterministic
  manifest.ts       Vite-compatible manifest writer
  compress.ts       brotli + gzip (node:zlib)
  watch.ts          watch program, process supervisor, SSE dev channel
  overlay.tsx       dev error overlay, rendered by yerd
  config.ts         yerd.config.ts loading
```

## If it ever happens

Raw lite already has the program setup, client graph, import-map hashing and
manifest writer. Growing it into this builder, in order:

1. transformers: CSS, assets, `define` (makes raw lite feature-equal with Vite
   for most apps)
2. full-closure modulepreload, compression
3. island HMR and CSS hot swap over SSE, error overlay
4. stretch: `yerd bundle`, `yerd minify`, builder plugins

## Tests

- Build twice, byte-identical output.
- `import "./x.css"` in a server component: no CSS import left in `dist/server`, CSS linked only on pages that rendered that component.
- `YERD_SECRET` referenced as `import.meta.env.YERD_SECRET` in an island stays `undefined`; `YERD_PUBLIC_X` is inlined.
- Import map remap: hashed module graph loads in a real browser (Playwright) with relative imports untouched.
- Preload closure matches the actual set of modules the browser requests (Playwright network log).
- Island HMR keeps `@state`; server change restarts and the page reloads.
