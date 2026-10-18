# Your first app

In this tutorial you'll build a tiny link board: a page that lists links, a form to add one, validation, delete buttons, in-place updates, and a test and a production build at the end.

Every step adds one idea and ends with something to try. Data lives in memory, so there's no database to set up. Restart the server and your links are gone, which is fine for a link board you built in twenty minutes.

## 1. Set up the project

Start from an empty folder. [Getting started](01-getting-started.md) explains each of these pieces; here you just run them.

```sh
mkdir link-board && cd link-board
npm init -y
npm pkg set type=module
npm install @toyz/yerd
npm install -D typescript @types/node vite esbuild vitest
```

Copy the `tsconfig.json` from [Getting started](01-getting-started.md#configure-typescript), with one change: add `"DOM"` to `lib`. Vite's client types and a few of yerd's own types mention browser things, and `tsc` complains without it.

```json
"lib": ["ES2023", "esnext.decorators", "DOM"],
```

Now the Vite config and the entry module. The entry default-exports the app, and the Vite plugin serves it.

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

**Try it:** run `npx vite` and open http://localhost:5173. You get a plain `Not Found`, which proves the server is up and has no routes yet. Leave it running: it picks up your changes as you save.

## 2. A layout and your first page

A route is a class: [@route](api:yerd.route) gives it a path and [@get](api:yerd.get) marks the method that answers. A layout wraps every page in the same HTML document, so pages only return their own content.

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

**Try it:** reload http://localhost:5173. You see two links, and the tab says "Links | Link board". View the source: yerd added `<!doctype html>` because the layout's outermost element is `<html>`.

Imports end in `.js` even though the file is `layouts.tsx`; that's `nodenext` resolution. [Pages and layouts](05-pages-and-layouts.md) covers components, metadata and nested layouts.

## 3. A service to hold the links

A list at the top of a route file won't scale past one route. Move it into a [@service](api:yerd.service): one instance for the whole app (a singleton), handed to whoever asks with [@inject](api:yerd.inject).

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

In `src/routes/home.tsx`, delete the `links` array and inject the service instead. Injected fields need the `accessor` keyword.

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

While you're here, handlers return anything, not just JSX. Return an array and you get JSON:

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

**Try it:** the page looks the same (that's the point). Now run `curl localhost:5173/api/links` and you get the two links as JSON, from the same service the page uses.

[Services](08-services.md) covers lifetimes, tokens and startup hooks; [Responses](04-responses.md) lists everything a handler can return.

## 4. An add form

A form calls a method directly: mark it with [@action](api:yerd.action) and pass it to the form's `action`. The submitted fields arrive as an [ActionForm](api:yerd.ActionForm), and `form.parse()` validates them against a DTO class built with [is](api:yerd.is).

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

A validator returns `true` or a message. [trim](api:yerd.trim) runs first, so a title of three spaces counts as empty. Now the form and the action:

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

The form renders as a plain POST to `/` with a signed hidden `_yx` field naming the action. The action returns nothing, so yerd redirects the browser back to the page (a 303), and the page renders with the new link.

**Try it:** add "Node.js" with `https://nodejs.org`, and the page reloads with Node.js at the bottom of the list. Now submit with an empty title: you get a raw 400 with JSON listing every problem. Accurate, but not something you'd show a human (step 6 fixes it).

> [!TIP]
> The inputs have no `required` or `type="url"` on purpose, so you can watch the server reject things. In a real app add them too; the browser's checks save a round trip, the server's checks are the ones that count.

## 5. A flash message

Let's tell people their link was added. After a redirect the page is a brand-new request, so the message has to survive one hop: that's what a session flash is for. Sessions are off until you turn them on.

```ts
// src/main.ts
export default yerd()
  .layout(RootLayout)
  .sessions()
  .discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }));
```

In `src/routes/home.tsx`, inject the session with [@session](api:yerd.session), set a flash in the action, and read it in the page:

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

`flash(key, value)` keeps a value for the next request only, and `flash(key)` reads it and uses it up. Flash values come back as `unknown`, hence the cast.

**Try it:** add a link. A green "Added ..." appears above the form. Reload the page and it's gone.

The default session store keeps everything in a sealed cookie, so there's still no server state. [Sessions and auth](09-sessions-and-auth.md) has the other stores and options.

## 6. Errors next to the form

`form.parse()` throws an [HttpError](api:yerd.HttpError) (a 400) carrying every issue. Catch it, flash the first message and what the user typed, and let the action return as usual: the redirect brings them back to a page that shows both.

Add a helper and a type at the top of `src/routes/home.tsx`, and add `HttpError` and `type Issue` to the import:

```tsx
// src/routes/home.tsx (new, above the class)
import { ActionForm, HttpError, action, get, inject, route, session, type Issue, type Session } from "@toyz/yerd";

interface Draft {
  title?: string;
  url?: string;
}

/** The first validation message, or the error's own. Anything else is a real bug: let it crash. */
function messageOf(error: unknown): string {
  if (!(error instanceof HttpError)) throw error;
  const issues = (error.details as { issues?: Issue[] } | undefined)?.issues;
  return issues?.[0]?.message ?? error.message;
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

In `page()`, read the two new flashes next to `notice`, and replace the form with one that shows them:

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

**Try it:** add "Vite" with the URL `vite.dev`. You land back on the page with "Links start with http:// or https://" under the form, and both fields still hold what you typed. Fix the URL to `https://vite.dev` and it goes through.

This is the pattern the [interactivity guide](06-interactivity.md#errors) recommends for forms that must work with and without JavaScript. Speaking of which.

## 7. Updates without a reload

So far every click is a full page load. Add [Scripts](api:yerd.Scripts) to the layout's `<head>` and yerd's small client runtime takes over forms that call actions:

```tsx
// src/layouts.tsx (the changed parts)
import { Scripts, type LayoutProps } from "@toyz/yerd";

      <head>
        {/* ...meta, title and style as before */}
        <Scripts />
      </head>
```

The runtime posts the form with `fetch` and morphs the result into the page. It only touches parts marked with a [Region](api:yerd.Region), so wrap everything that changes in one. While you're in there, add delete buttons: [bind](api:yerd.bind) attaches the link's id to the action, signed, so nobody can edit it in the HTML.

Here's the whole file:

```tsx
// src/routes/home.tsx
import { ActionForm, HttpError, Region, action, bind, get, inject, route, session, type Issue, type Session } from "@toyz/yerd";
import { Links, NewLink } from "../links.js";

interface Draft {
  title?: string;
  url?: string;
}

/** The first validation message, or the error's own. Anything else is a real bug: let it crash. */
function messageOf(error: unknown): string {
  if (!(error instanceof HttpError)) throw error;
  const issues = (error.details as { issues?: Issue[] } | undefined)?.issues;
  return issues?.[0]?.message ?? error.message;
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
              <form action={bind(this.remove, { id: link.id })}>
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

What each action does now, with JavaScript on:

- `add` still returns nothing. The runtime gets a 204, re-fetches the page in the background and morphs the Region, so the notice or the error shows up exactly as before. `data-yx-reset` clears the form after a success (after an error it falls back to the draft you flashed).
- `remove` returns the Region itself, which saves that second request: the response is just `<div id="board" ...>`, no layout.
- `key={link.id}` lets the morph match list items, and `data-yx-error` is where the runtime writes errors it gets back, like an expired form.

**Try it:** open the network tab and add a link. You'll see a POST answered with 204, one background GET, and no page load: the form clears and the notice appears in place. Delete a link and there's a single POST whose response is the Region.

**Try it with JavaScript off:** disable it in your browser's dev tools and do it all again. Adding, errors, the notice and delete all still work, with full page loads, because without the runtime yerd answers every action with a 303 back to the page.

[Interactivity](06-interactivity.md) has the rest: boosted links, `data-yx-confirm`, prefetching and auto mode.

## 8. A test

Vitest runs on Vite, which can't compile TC39 decorators on its own. [yerdDecorators](api:vite.yerdDecorators) is the decorators-only half of the plugin, made for tests.

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { yerdDecorators } from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerdDecorators()],
});
```

The test boots the real app on a free port and talks HTTP to it. Action tokens are tied to the session they were rendered for, so each test gets a tiny cookie jar and uses it for both the page and the post.

```ts
// test/links.test.ts
import { afterAll, beforeAll, expect, it } from "vitest";
import { yerd, type RunningServer } from "@toyz/yerd";
import { Links } from "../src/links.js";
import { Home } from "../src/routes/home.js";

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Home], services: [Links], handleSignals: false }).sessions().listen(0, "127.0.0.1");
});
afterAll(() => server.close());

/** fetch with a one-cookie jar, so the session (and its action tokens) carry over. */
function client() {
  let cookie = "";
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(server.url + path, { redirect: "manual", ...init, headers: { cookie, ...init.headers } });
    for (const c of res.headers.getSetCookie()) cookie = c.split(";")[0]!;
    return res;
  };
}

/** The add form's action token: the first _yx field on the page. */
const tokenIn = (html: string) => /name="_yx" value="([^"]+)"/.exec(html)![1]!;

it("adds a link and says so", async () => {
  const c = client();
  const _yx = tokenIn(await (await c("/")).text());

  const res = await c("/", { method: "POST", body: new URLSearchParams({ _yx, title: "Node.js", url: "https://nodejs.org" }) });
  expect(res.status).toBe(303);

  const page = await (await c("/")).text();
  expect(page).toContain('<a href="https://nodejs.org">Node.js</a>');
  expect(page).toContain("Added &quot;Node.js&quot;");
});

it("shows what's wrong and keeps what you typed", async () => {
  const c = client();
  const _yx = tokenIn(await (await c("/")).text());

  await c("/", { method: "POST", body: new URLSearchParams({ _yx, title: "Oops", url: "not a url" }) });

  const page = await (await c("/")).text();
  expect(page).toContain("Links start with http:// or https://");
  expect(page).toContain('value="Oops"');
});

it("refuses a token from someone else's session", async () => {
  const _yx = tokenIn(await (await client()("/")).text());
  const res = await client()("/", { method: "POST", body: new URLSearchParams({ _yx, title: "x", url: "https://x.dev" }) });
  expect(res.status).toBe(403);
});
```

- `routes` and `services` limit the app to exactly these classes, and `handleSignals: false` leaves Ctrl-C to vitest.
- `redirect: "manual"` lets you assert on the 303 instead of following it. These posts have no `yx` header, so they get the no-JavaScript treatment.
- The last test is the security model at work: a token rendered for one visitor is useless to another.

**Try it:** `npx vitest run`. Three tests pass. [Testing](12-testing.md) covers scripted posts, fake services and logs.

## 9. Build and run for production

Add scripts to `package.json` so nobody has to remember the commands. Vite doesn't type-check, so the build runs `tsc` first.

```json
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "start": "node dist/server/server.js",
  "test": "vitest run"
}
```

Action tokens and session cookies are signed with a secret. Without `YERD_SECRET`, yerd invents a random one per process, so every restart logs everyone out and breaks open forms. Generate one (it must be at least 32 bytes) and keep it out of git.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npm run build
YERD_SECRET=paste-the-value-here npm start
```

> [!NOTE]
> `vite build` boots your app once, so it prints the "no YERD_SECRET set" warning even when you're only building. It matters at `npm start`, not here.

**Try it:** open http://localhost:3000 (set `PORT` to change it). Same app, now a single `dist/server/server.js`. To deploy, ship `dist/` with `package.json` and run `npm ci --omit=dev`: yerd has no dependencies of its own, so that's quick.

The [deploying guide](11-deploying.md) covers proxies, static files, prerendering and graceful shutdown.

## Where to next

You've used most of yerd in one small app. Each piece has its own guide:

- [Routing](02-routing.md): params, groups, guards and content negotiation.
- [Request data](03-request-data.md): query strings, bodies, uploads and every `is.*` validator.
- [Responses](04-responses.md): status codes, redirects, cookies and error pages.
- [Pages and layouts](05-pages-and-layouts.md): components, metadata, assets and prerendering.
- [Interactivity](06-interactivity.md): actions, Regions, boosted links, live refresh and auto mode.
- [Streaming and live](07-streaming-and-live.md): SSE, NDJSON and channels.
- [Services](08-services.md): lifetimes, tokens, `@onBoot` and background work.
- [Sessions and auth](09-sessions-and-auth.md): logins, guards and the security model.
- [Logging](10-logging.md), [Deploying](11-deploying.md) and [Testing](12-testing.md).

Want every open tab to update when someone adds a link? [Live refresh](06-interactivity.md#live-refresh) does it with a channel and one attribute.

> [!WARNING]
> A flash is used up by the next request from the same browser, and a live refresh in another tab counts. Move the notice out of the flash before you turn on live refresh, or it can show up in the wrong tab.
