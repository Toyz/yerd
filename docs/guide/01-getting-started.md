# Getting started

The shop starts here: install yerd and serve its first page.

## Install

yerd needs Node 24 or newer. Vite and esbuild are only for the Vite plugin, the easiest way to run and build an app.

```sh
npm install @toyz/yerd
npm install -D typescript @types/node vite esbuild
```

> [!TAKE]
> yerd has no runtime dependencies: router, renderer, validation, DI, sessions, events and the client runtime are all in the one package. You audit one thing and upgrades don't cascade. The price is that yerd brings what a web app needs and stops there: the database, mail and payments are yours to pick.

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

| Option | Value | Why |
| --- | --- | --- |
| `target` | `ES2022` or later | Standard decorators and `accessor` fields compile as they are. |
| `jsx` | `react-jsx` | The automatic JSX transform: no `import React`. |
| `jsxImportSource` | `@toyz/yerd` | JSX compiles to yerd's own runtime, not React's. |
| `lib` | includes `"DOM"` | Vite's client types (`import.meta.glob`) need it. |

> [!WARNING]
> Don't turn on `experimentalDecorators`: it switches TypeScript to the legacy decorator model, which is incompatible.

## The smallest app

One route that answers `/`. A route is a class: [@route](api:yerd.route) gives it a path, and [@get](api:yerd.get) marks the method that handles GET.

```tsx
// src/routes/home.tsx
import { get, route } from "@toyz/yerd";

@route("/")
export class Home {
  @get page() {
    return <h1>Paperyard</h1>;
  }
}
```

```answer
GET /
200 OK
content-type: text/html; charset=utf-8

<h1>Paperyard</h1>
```

- The handler returns; yerd makes the response. JSX is HTML, an object would be JSON ([Responses](04-responses.md)).
- Imports in your own files end in `.js`, even for `.tsx`: with `nodenext` you import the file the compiler emits.

## Run it with Vite

The plugin compiles decorators, serves your app on the dev server and reloads routes when you save.

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

export default yerd().discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

```sh
npx vite                                    # dev, on http://localhost:5173
npx vite build && node dist/server/server.js # production, on PORT or 3000
```

- The entry default-exports the app and never calls `listen()`: the plugin serves it.
- [discover()](api:yerd.YerdApp) registers every route file `import.meta.glob` found. `entry` defaults to `/src/main.ts`.
- Production builds are covered in [Deploying](11-deploying.md).

## Run it without Vite

Compile with `tsc` and start a module that calls `listen()`.

```ts
// src/server.ts
import { yerd } from "@toyz/yerd";

const server = await yerd()
  .discover(new URL("./routes/", import.meta.url))
  .listen(Number(process.env.PORT ?? 3000));

console.log(`listening on ${server.url}`);
```

```sh
npx tsc && node dist/server.js
```

- Given a directory URL, `discover()` imports every `.js` file under it. Node can't run decorators or TSX from source, hence `tsc` first.
- `discover()` is optional: importing a route module registers its routes.

## Next

[Your first app](13-your-first-app.md) builds the shop's catalog, product pages and cart from here. The guides after it each add a piece:

- [Routing](02-routing.md): paths, params, groups, guards, middleware, content negotiation.
- [Request data](03-request-data.md): query strings, bodies, forms, uploads, validation.
- [Responses](04-responses.md): what a handler returns, status codes, cookies, caching, errors.
- [Pages and layouts](05-pages-and-layouts.md): TSX, components, metadata, assets, prerendering.
- [Interactivity](06-interactivity.md): actions, Regions, boosted links, local state.
- [Streaming and live](07-streaming-and-live.md): SSE, NDJSON, channels.
- [Services](08-services.md) and [Events](14-events.md): dependency injection, background work.
- [Sessions and auth](09-sessions-and-auth.md): sessions, sign-in, guards.
- [Logging](10-logging.md), [Deploying](11-deploying.md), [Testing](12-testing.md), [Security](15-security.md), [Recipes](16-recipes.md).
