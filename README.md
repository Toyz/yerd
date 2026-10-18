# yerd

[![npm](https://img.shields.io/npm/v/@toyz/yerd)](https://www.npmjs.com/package/@toyz/yerd)
[![ci](https://github.com/Toyz/yerd/actions/workflows/ci.yml/badge.svg)](https://github.com/Toyz/yerd/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@toyz/yerd)](LICENSE)

A TypeScript web server for Node where routes are decorated classes, TSX is
the template engine, and a handler can return anything. Zero runtime
dependencies.

```tsx
import { get, param, route, toInt, yerd } from "@toyz/yerd";

@route("/users/:id")
class UserPage {
  @param("id", { transform: toInt }) accessor id!: number;

  @get show() {
    return <h1>user {this.id}</h1>; // HTML, inside the app's layouts
  }
}

await yerd().listen(3000);
```

Return a string for text, a number for a status, an object for JSON, an async
iterable for a stream, JSX for a page, `res()` / `redirect()` for full control.

## What's in it

- **Routing**: `@route`, verb decorators, `@group` with nested prefixes,
  layouts, guards and meta; content negotiation with `@accepts` / `negotiate()`.
- **Request data**: `@param` `@query` `@header` `@cookie` `@body` `@field`
  `@file` accessors with transform/validate pipelines; DTO classes (`is.*`)
  that validate bodies, forms and uploads into typed instances.
- **Layouts anywhere**: `@layout(Root, Marketing)` on routes, groups or one
  handler, or per response with `res(node, { layout })`.
- **DI**: singleton / scoped / transient services, `@inject`, disposal,
  lifecycle hooks, `@every`, hosted background services.
- **Interactivity without a client framework**: `@action` forms that post
  with or without JavaScript, morphing Regions, boosted navigation, live
  refresh over SSE, custom attributes with a client half, `prefetch`, and an
  auto mode (`<Scripts auto />`) that needs no attributes at all.
- **Sessions and auth**: sealed cookie or memory sessions, `createAuth`,
  argon2id passwords, session-bound CSRF tokens, cross-site request checks.
- **Streaming**: NDJSON and SSE, per-user channels.
- **Build**: a Vite plugin for dev and production builds, prerendering at
  build time with `<Dynamic>` per-request parts.

## Install

```sh
npm install @toyz/yerd
npm install -D typescript vite esbuild   # vite + esbuild only for @toyz/yerd/vite
```

`tsconfig.json`: `"jsx": "react-jsx"`, `"jsxImportSource": "@toyz/yerd"`,
`"target": "ES2022"` or later. Node 24+.

With Vite:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import yerd from "@toyz/yerd/vite";

export default defineConfig({ plugins: [yerd({ entry: "/src/main.ts" })] });
```

```ts
// src/main.ts
import { yerd } from "@toyz/yerd";
import { RootLayout } from "./layouts.js";

export default yerd()
  .layout(RootLayout)
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

`vite` runs it with reloads; `vite build` produces a client build and
`dist/server/server.js`.

## Docs and examples

**[toyz.github.io/yerd](https://toyz.github.io/yerd/)**: guides, plus an API
reference generated from the source on every push to main, with the version
each export and member first shipped in.

- [docs/PLAN.md](docs/PLAN.md): the design, decorator catalog, status.
- [docs/DYNAMICS.md](docs/DYNAMICS.md): actions, morphing, custom attributes, auto mode.
- [docs/AUTH.md](docs/AUTH.md): sessions, auth, the security model.
- [docs/DECORATORS.md](docs/DECORATORS.md): writing your own decorators.
- [docs/BUILD.md](docs/BUILD.md): Vite, production builds, prerendering.
- [examples/todo](examples/todo): a full app (auth, actions, live sync,
  prerendered pages). `npm run todo` from a checkout.

## License

MIT
