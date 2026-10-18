# Your first app

Build a tiny link board: a list of links, an add form with validation, delete buttons, in-place updates, a test and a production build.

Each step adds one idea and ends with something to try. Data lives in memory, so there's no database to set up.

## 1. Set up the project

Start from an empty folder ([Getting started](01-getting-started.md) explains each piece).

```sh
mkdir link-board && cd link-board
npm init -y
npm pkg set type=module
npm install @toyz/yerd
npm install -D typescript @types/node vite esbuild vitest
```

Copy the `tsconfig.json` from [Getting started](01-getting-started.md#configure-typescript). Keep `"DOM"` in `lib`, or `tsc` complains about Vite's client types:

```json
"lib": ["ES2023", "esnext.decorators", "DOM"],
```

Add the Vite config and the entry module, which default-exports the app:

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

**Try it:** run `npx vite` and open http://localhost:5173. A plain `Not Found` means the server is up with no routes yet. Leave it running; it reloads as you save.

## 2. A layout and your first page

A route is a class: [@route](api:yerd.route) gives it a path and [@get](api:yerd.get) marks the method that answers. A layout wraps every page in the same document.

```tsx
// src/layouts.tsx
import type { LayoutProps } from "@toyz/yerd";

const css = `
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  li form { display: inline; margin-left: .5rem; }
  .notice { background: #e6f4ea; padding: .5rem .75rem; border-radius: 4px; }
  .error { color: #c62828; }
`;

export function RootLayout({ children, meta }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{meta.title ? `${meta.title} | Link board` : "Link board"}</title>
        <style>{css}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
```

```tsx
// src/routes/home.tsx
import { get, route } from "@toyz/yerd";

const links = [
  { id: 1, title: "yerd on GitHub", url: "https://github.com/Toyz/yerd" },
  { id: 2, title: "MDN Web Docs", url: "https://developer.mozilla.org" },
];

@route("/", { meta: { title: "Links" } })
export class Home {
  @get page() {
    return (
      <main>
        <h1>Link board</h1>
        <ul>
          {links.map((link) => (
            <li>
              <a href={link.url}>{link.title}</a>
            </li>
          ))}
        </ul>
      </main>
    );
  }
}
```

Register the layout in `src/main.ts`:

```ts
// src/main.ts
/// <reference types="vite/client" />
import { yerd } from "@toyz/yerd";
import { RootLayout } from "./layouts.js";

export default yerd()
  .layout(RootLayout)
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

**Try it:** reload. You see two links and the tab says "Links | Link board". The source starts with `<!doctype html>`, added because the layout's outermost element is `<html>`.

Imports end in `.js` even for `.tsx` files (`nodenext` resolution). [Pages and layouts](05-pages-and-layouts.md) covers components, metadata and nested layouts.

## 3. A service to hold the links

Move the list into a [@service](api:yerd.service), one instance for the whole app, handed out with [@inject](api:yerd.inject).

```ts
// src/links.ts
import { service } from "@toyz/yerd";

export interface Link {
  id: number;
  title: string;
  url: string;
}

@service
export class Links {
  #nextId = 3;
  #links: Link[] = [
    { id: 1, title: "yerd on GitHub", url: "https://github.com/Toyz/yerd" },
    { id: 2, title: "MDN Web Docs", url: "https://developer.mozilla.org" },
  ];

  all(): Link[] {
    return this.#links;
  }

  add(title: string, url: string): Link {
    const link = { id: this.#nextId++, title, url };
    this.#links.push(link);
    return link;
  }

  remove(id: number): void {
    this.#links = this.#links.filter((link) => link.id !== id);
  }
}
```

In `src/routes/home.tsx`, replace the `links` array with the injected service (injected fields need `accessor`):

```tsx
// src/routes/home.tsx
import { get, inject, route } from "@toyz/yerd";
import { Links } from "../links.js";

@route("/", { meta: { title: "Links" } })
export class Home {
  @inject(Links) accessor links!: Links;

  @get page() {
    return (
      <main>
        <h1>Link board</h1>
        <ul>
          {this.links.all().map((link) => (
            <li>
              <a href={link.url}>{link.title}</a>
            </li>
          ))}
        </ul>
      </main>
    );
  }
}
```

Handlers can return anything; an array becomes JSON:

```ts
// src/routes/api.ts
import { get, inject, route } from "@toyz/yerd";
import { Links } from "../links.js";

@route("/api/links")
export class LinksApi {
  @inject(Links) accessor links!: Links;

  @get list() {
    return this.links.all();
  }
}
```

**Try it:** the page looks the same. `curl localhost:5173/api/links` returns the links as JSON from the same service.

[Services](08-services.md) covers lifetimes and startup hooks; [Responses](04-responses.md) lists what a handler can return.

## 4. An add form

Mark a method with [@action](api:yerd.action) and pass it to a form's `action`. The fields arrive as an [ActionForm](api:yerd.ActionForm), and `form.parse()` validates them against a DTO built with [is](api:yerd.is).

Add the DTO to `src/links.ts`:

```ts
// src/links.ts (add to the import, and add the class)
import { is, matches, service, trim } from "@toyz/yerd";

/** What the add form submits. */
export class NewLink {
  @is.string({ transform: trim, validate: (title: string) => title.length > 0 || "Give the link a title" })
  title!: string;

  @is.string({ transform: trim, validate: matches(/^https?:\/\/\S+$/, "Links start with http:// or https://") })
  url!: string;
}
```

A validator returns `true` or a message; [trim](api:yerd.trim) runs first, so three spaces count as empty. Now the form and the action:

```tsx
// src/routes/home.tsx
import { ActionForm, action, get, inject, route } from "@toyz/yerd";
import { Links, NewLink } from "../links.js";

@route("/", { meta: { title: "Links" } })
export class Home {
  @inject(Links) accessor links!: Links;

  @get page() {
    return (
      <main>
        <h1>Link board</h1>
        <form action={this.add}>
          <input name="title" placeholder="Title" />
          <input name="url" placeholder="https://..." />
          <button>Add</button>
        </form>
        <ul>
          {this.links.all().map((link) => (
            <li>
              <a href={link.url}>{link.title}</a>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  @action add(_: {}, form: ActionForm) {
    const { title, url } = form.parse(NewLink);
    this.links.add(title, url);
  }
}
```

The form renders as a plain POST with a signed hidden `_yx` field naming the action. An action that returns nothing redirects back to the page (303).

**Try it:** add "Node.js" with `https://nodejs.org`; it appears at the bottom. Submit an empty title and you get a raw 400 listing the problems (step 6 fixes that).

> [!TIP]
> The inputs skip `required` and `type="url"` so you can watch the server reject things. In a real app add them; the server's checks are still the ones that count.

## 5. A flash message

After a redirect the page is a new request, so a "link added" message must survive one hop: a session flash. Turn sessions on:

```ts
// src/main.ts
export default yerd()
  .layout(RootLayout)
  .sessions()
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

Inject the session with [@session](api:yerd.session), set a flash in the action, and read it in the page:

```tsx
// src/routes/home.tsx (the changed parts)
import { ActionForm, action, get, inject, route, session, type Session } from "@toyz/yerd";

@route("/", { meta: { title: "Links" } })
export class Home {
  @inject(Links) accessor links!: Links;
  @session accessor session!: Session;

  @get page() {
    const notice = this.session.flash("notice") as string | undefined;
    return (
      <main>
        <h1>Link board</h1>
        {notice ? <p class="notice" role="status">{notice}</p> : null}
        {/* ...the form and the list, unchanged */}
      </main>
    );
  }

  @action add(_: {}, form: ActionForm) {
    const { title, url } = form.parse(NewLink);
    this.links.add(title, url);
    this.session.flash("notice", `Added "${title}"`);
  }
}
```

`flash(key, value)` keeps a value for the next request; `flash(key)` reads and consumes it (as `unknown`, hence the cast).

**Try it:** add a link and a green "Added ..." appears. Reload and it's gone.

The default store keeps the session in a sealed cookie, so there's still no server state. See [Sessions and auth](09-sessions-and-auth.md).

## 6. Errors next to the form

`form.parse()` throws an [YerdError](api:yerd.YerdError) (400) carrying every issue. Catch it, flash the first message and the user's input, and the redirect brings them back to a page showing both.

Add a helper and a type at the top of `src/routes/home.tsx`, with `YerdError` and `type Issue` in the import:

```tsx
// src/routes/home.tsx (new, above the class)
import { ActionForm, ValidationFailed, YerdError, action, get, inject, route, session, type Session } from "@toyz/yerd";

interface Draft {
  title?: string;
  url?: string;
}

/** The first validation message, or the error's own. Anything else is a real bug: let it crash. */
function messageOf(error: unknown): string {
  if (!(error instanceof YerdError)) throw error;
  const issues = error instanceof ValidationFailed ? error.issues : [];
  return issues[0]?.message ?? error.message;
}
```

Replace the `add` action with one that catches:

```tsx
  @action add(_: {}, form: ActionForm) {
    try {
      const { title, url } = form.parse(NewLink);
      this.links.add(title, url);
      this.session.flash("notice", `Added "${title}"`);
    } catch (error) {
      this.session.flash("error", messageOf(error));
      this.session.flash("draft", { title: form.get("title"), url: form.get("url") });
    }
  }
```

In `page()`, read the new flashes next to `notice`, and show them in the form:

```tsx
    const error = this.session.flash("error") as string | undefined;
    const draft = (this.session.flash("draft") ?? {}) as Draft;
```

```tsx
        <form action={this.add}>
          <input name="title" placeholder="Title" value={draft.title} />
          <input name="url" placeholder="https://..." value={draft.url} />
          <button>Add</button>
          <p class="error" role="alert">{error}</p>
        </form>
```

**Try it:** add "Vite" with the URL `vite.dev`. You're back on the page with "Links start with http:// or https://" and your input kept. Fix it to `https://vite.dev` and it goes through.

This is the [interactivity guide](06-interactivity.md#errors)'s pattern for forms that work with and without JavaScript.

## 7. Updates without a reload

Add [Scripts](api:yerd.Scripts) to the layout's `<head>` and yerd's client runtime takes over forms that call actions:

```tsx
// src/layouts.tsx (the changed parts)
import { Scripts, type LayoutProps } from "@toyz/yerd";

      <head>
        {/* ...meta, title and style as before */}
        <Scripts />
      </head>
```

The runtime posts with `fetch` and morphs only the parts marked with a [Region](api:yerd.Region), so wrap everything that changes in one. Add delete buttons too: `action={() => this.remove({ id: link.id })}` attaches the id to the action, signed so nobody can edit it.

The whole file:

```tsx
// src/routes/home.tsx
import { ActionForm, Region, ValidationFailed, YerdError, action, get, inject, route, session, type Session } from "@toyz/yerd";
import { Links, NewLink } from "../links.js";

interface Draft {
  title?: string;
  url?: string;
}

/** The first validation message, or the error's own. Anything else is a real bug: let it crash. */
function messageOf(error: unknown): string {
  if (!(error instanceof YerdError)) throw error;
  const issues = error instanceof ValidationFailed ? error.issues : [];
  return issues[0]?.message ?? error.message;
}

@route("/", { meta: { title: "Links" } })
export class Home {
  @inject(Links) accessor links!: Links;
  @session accessor session!: Session;

  @get page() {
    return (
      <main>
        <h1>Link board</h1>
        {this.board()}
      </main>
    );
  }

  /** Everything that changes, in one Region. */
  board() {
    const notice = this.session.flash("notice") as string | undefined;
    const error = this.session.flash("error") as string | undefined;
    const draft = (this.session.flash("draft") ?? {}) as Draft;
    return (
      <Region id="board">
        {notice ? <p class="notice" role="status">{notice}</p> : null}
        <form action={this.add} data-yx-reset>
          <input name="title" placeholder="Title" value={draft.title} />
          <input name="url" placeholder="https://..." value={draft.url} />
          <button>Add</button>
          <p class="error" role="alert" data-yx-error>{error}</p>
        </form>
        <ul>
          {this.links.all().map((link) => (
            <li key={link.id}>
              <a href={link.url}>{link.title}</a>
              <form action={() => this.remove({ id: link.id })}>
                <button aria-label={`Delete ${link.title}`}>Delete</button>
              </form>
            </li>
          ))}
        </ul>
      </Region>
    );
  }

  @action add(_: {}, form: ActionForm) {
    try {
      const { title, url } = form.parse(NewLink);
      this.links.add(title, url);
      this.session.flash("notice", `Added "${title}"`);
    } catch (error) {
      this.session.flash("error", messageOf(error));
      this.session.flash("draft", { title: form.get("title"), url: form.get("url") });
    }
  }

  @action remove({ id }: { id: number }) {
    this.links.remove(id);
    return this.board();
  }
}
```

With JavaScript on:

- `add` returns nothing, so the runtime gets a 204, re-fetches the page in the background and morphs the Region. `data-yx-reset` clears the form after a success.
- `remove` returns the Region itself, saving that second request.
- `key={link.id}` lets the morph match list items; `data-yx-error` is where the runtime writes errors it gets back (an expired form, say).

**Try it:** in the network tab, adding a link is a POST answered with 204 plus one background GET, and no page load. Deleting is a single POST whose response is the Region.

**Try it with JavaScript off:** everything still works with full page loads, because without the runtime every action answers with a 303 back to the page.

[Interactivity](06-interactivity.md) has the rest: boosted links, `data-yx-confirm`, prefetching and auto mode.

## 8. A test

Vitest can't compile TC39 decorators on its own; [yerdDecorators](api:vite.yerdDecorators) is the decorators-only half of the plugin.

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { yerdDecorators } from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerdDecorators()],
});
```

Tests send requests straight into the app, no port needed. [app.client()](12-testing.md#a-client-that-keeps-cookies) keeps cookies like a browser, and `client.action()` fetches a page and submits its form. Action tokens are tied to their session, so the page and the post must come from the same client.

```ts
// test/links.test.ts
import { afterAll, expect, it } from "vitest";
import { yerd } from "@toyz/yerd";
import { Links } from "../src/links.js";
import { Home } from "../src/routes/home.js";

const app = yerd({ routes: [Home], services: [Links], handleSignals: false }).sessions();
afterAll(() => app.stop());

it("adds a link and says so", async () => {
  const client = app.client();
  const res = await client.action("/", { title: "Node.js", url: "https://nodejs.org" }, { script: false });
  expect(res.status).toBe(303);

  const page = await client.page("/");
  expect(page).toContain('<a href="https://nodejs.org">Node.js</a>');
  expect(page).toContain("Added &quot;Node.js&quot;");
});

it("shows what's wrong and keeps what you typed", async () => {
  const client = app.client();
  await client.action("/", { title: "Oops", url: "not a url" }, { script: false });

  const page = await client.page("/");
  expect(page).toContain("Links start with http:// or https://");
  expect(page).toContain('value="Oops"');
});

it("refuses a token from someone else's session", async () => {
  const html = await app.client().page("/");
  const _yx = /name="_yx" value="([^"]+)"/.exec(html)![1]!;
  const res = await app.client().request("/", { method: "POST", body: new URLSearchParams({ _yx, title: "x", url: "https://x.dev" }) });
  expect(res.status).toBe(403);
});
```

- `routes` and `services` limit the app to these classes; `handleSignals: false` leaves Ctrl-C to vitest. The first request starts the app and `app.stop()` shuts it down.
- `script: false` posts like a browser without JavaScript (303); without it the client posts like the runtime (204).
- `client.action()` picks the first action on the page; pass `{ index }` for another.
- The last test shows a token rendered for one visitor is useless to another.

**Try it:** `npx vitest run`. Three tests pass. [Testing](12-testing.md) covers scripted posts, fake services and logs.

## 9. Build and run for production

Add scripts to `package.json`. Vite doesn't type-check, so the build runs `tsc` first.

```json
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "start": "node dist/server/server.js",
  "test": "vitest run"
}
```

Without `YERD_SECRET`, each process signs tokens and cookies with a random secret, so every restart logs everyone out and breaks open forms (the dev server keeps its secret in `node_modules/.cache`). Generate one of at least 32 bytes and keep it out of git:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npm run build
YERD_SECRET=paste-the-value-here npm start
```

> [!NOTE]
> `vite build` boots your app once, so it prints the "no YERD_SECRET set" warning while building. Only `npm start` needs it.

**Try it:** open http://localhost:3000 (`PORT` changes it). To deploy, ship `dist/` with `package.json` and run `npm ci --omit=dev`; yerd has no dependencies of its own.

The [deploying guide](11-deploying.md) covers proxies, static files, prerendering and graceful shutdown.

## Where to next

Each piece has its own guide:

- [Routing](02-routing.md): params, groups, guards and content negotiation.
- [Request data](03-request-data.md): query strings, bodies, uploads and every `is.*` validator.
- [Responses](04-responses.md): status codes, redirects, cookies and error pages.
- [Pages and layouts](05-pages-and-layouts.md): components, metadata, assets and prerendering.
- [Interactivity](06-interactivity.md): actions, Regions, boosted links, live refresh and auto mode.
- [Streaming and live](07-streaming-and-live.md): SSE, NDJSON and channels.
- [Services](08-services.md): lifetimes, tokens, `@onBoot` and background work.
- [Events](14-events.md): background work such as a welcome mail.
- [Sessions and auth](09-sessions-and-auth.md): logins, guards and the security model.
- [Logging](10-logging.md), [Deploying](11-deploying.md) and [Testing](12-testing.md).
- [Security](15-security.md) before you go live, and [Recipes](16-recipes.md) for complete solutions.

To update every open tab when someone adds a link, see [live refresh](06-interactivity.md#live-refresh).

> [!WARNING]
> A flash is consumed by the next request from the same browser, including a live refresh in another tab. Move the notice out of the flash before turning on live refresh.
