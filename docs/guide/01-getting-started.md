# Getting started

This page takes you from an empty folder to a running yerd app with a route and a layout.

## Install

yerd needs Node 24 or newer. Vite and esbuild are optional: you need them only if you use the Vite plugin, which is the easiest way to run and build an app.

```sh
npm install @toyz/yerd
npm install -D typescript @types/node vite esbuild
```

## Configure TypeScript

Routes are TC39 decorators and pages are TSX, so the compiler needs to know about both.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["ES2023", "esnext.decorators", "DOM"],
    "types": ["node"],
    "strict": true,
    "jsx": "react-jsx",
    "jsxImportSource": "@toyz/yerd",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

The three settings that matter:

| Option | Value | Why |
| --- | --- | --- |
| `target` | `ES2022` or later | Standard decorators and `accessor` fields compile as-is. |
| `jsx` | `react-jsx` | The automatic JSX transform (no `import React`). |
| `jsxImportSource` | `@toyz/yerd` | JSX compiles to yerd's own runtime, not React's. |

> [!WARNING]
> Do not turn on `experimentalDecorators`. yerd uses the standard (TC39) decorators, and the legacy flag switches TypeScript to a different, incompatible decorator model.

## Your first route

A route is a class. `@route` gives it a path, and a verb decorator like `@get` marks the method that handles the request.

```tsx
// src/routes/home.tsx
import { get, query, route } from "@toyz/yerd";

@route("/")
export class Home {
  @query("name") accessor name = "world";

  @get page() {
    return <h1>Hello, {this.name}!</h1>;
  }
}
```

Visit `/?name=Ada` and you get `<h1>Hello, Ada!</h1>`. A few things to notice:

- [`@query`](api:yerd.query) reads the query string. When `name` is missing, the field's initializer (`"world"`) is used.
- Request data lives on `accessor` fields. The `accessor` keyword is required: decorated plain fields can't do this.
- The handler returns JSX, so the response is HTML. Return an object and you get JSON instead (see [responses](04-responses.md)).

## Run it with Vite

The Vite plugin compiles decorators, mounts your app on the dev server, and reloads routes when you save. Add a config and an entry module.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import yerd from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerd({ entry: "/src/main.ts" })],
});
```

```ts
// src/main.ts
/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";

export default yerd()
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

```sh
npx vite
```

The entry module default-exports the app and does not call `listen()`: the plugin serves it for you. [`discover()`](api:yerd.YerdApp) takes the result of `import.meta.glob`, so every file under `src/routes/` is loaded and its routes register themselves.

> [!TIP]
> `entry` defaults to `/src/main.ts`, so `yerd()` with no options works if you use that path.

For production, `npx vite build` writes a client build and a server bundle, and `node dist/server/server.js` runs it. The [deploying guide](11-deploying.md) has the details.

## Run it without Vite

Plain Node works too. Compile with `tsc`, then start a server module that calls `listen()`.

```ts
// src/server.ts
import { yerd } from "@toyz/yerd";

const server = await yerd()
  .discover(new URL("./routes/", import.meta.url))
  .listen(Number(process.env.PORT ?? 3000));

console.log(`listening on ${server.url}`);
```

```sh
npx tsc
node dist/server.js
```

Given a directory URL, `discover()` imports every `.js` file under it, recursively. That is why this path needs `tsc` first: Node can't run decorators or TSX straight from source yet.

> [!NOTE]
> `discover()` is a convenience, not a requirement. Any route module that gets imported registers its routes, so `import "./routes/home.js"` works just as well.

## Add a layout

A layout is a component that wraps every page. It gets the page as `children` and the page's metadata as `meta`.

```tsx
// src/layouts.tsx
import type { LayoutProps } from "@toyz/yerd";

export function RootLayout({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>{meta.title ?? "My yerd app"}</title>
      </head>
      <body>
        <nav><a href="/">Home</a></nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
```

Register it on the app with `.layout()`:

```ts
// src/main.ts
/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";
import { RootLayout } from "./layouts.js";

export default yerd()
  .layout(RootLayout)
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

Now every JSX response is wrapped in `RootLayout`, and yerd adds `<!doctype html>` because the outermost element is `<html>`. Set a page's title with route metadata:

```tsx
import { get, route } from "@toyz/yerd";

@route("/about", { meta: { title: "About" } })
export class About {
  @get page() {
    return <p>Built with yerd.</p>;
  }
}
```

> [!NOTE]
> Imports end in `.js` even though the file is `layouts.tsx`. That is how `nodenext` module resolution works: you import the file the compiler will emit.

## What you get

yerd is one package with no runtime dependencies: a router, a TSX renderer that streams, request decorators with validation, DI, an event bus, sessions, server actions with a tiny client runtime, SSE and NDJSON streaming, and structured logging. Handlers return whatever is natural (a string, an object, JSX, a number) and yerd turns it into a response.

New to yerd? [Your first app](13-your-first-app.md) builds a small app step by step. Otherwise, read on in roughly this order:

- [Routing](02-routing.md): paths, verbs, params, groups, layouts, guards, middleware.
- [Request data](03-request-data.md): query, headers, bodies, forms, uploads, validation, your own accessors.
- [Responses](04-responses.md): what you can return, status codes, cookies, caching, errors.
- [Pages and layouts](05-pages-and-layouts.md): TSX, components, metadata, assets, prerendering.
- [Interactivity](06-interactivity.md): actions, triggers, Regions, drag and drop, boosted navigation, local state.
- [Streaming and live updates](07-streaming-and-live.md): SSE, NDJSON, channels.
- [Services](08-services.md): dependency injection and background work.
- [Events](14-events.md): reacting to what happened, calls, transports.
- [Sessions and auth](09-sessions-and-auth.md): sessions, stores, login, guards.
- [Logging](10-logging.md): request logs, spans, filters.
- [Deploying](11-deploying.md): production builds, static files, proxies.
- [Testing](12-testing.md): testing routes, actions, services and events.
- [Security](15-security.md): what yerd protects against, and a checklist for going live.
- [Recipes](16-recipes.md): complete solutions to common tasks.
