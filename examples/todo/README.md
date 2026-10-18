# todo

A complete todo app in yerd. Server-rendered TSX, progressively enhanced:
everything works with JavaScript off, and with it on, actions update the page
in place and every open tab stays in sync.

From the repo root:

```sh
npm run todo         # Vite dev server on http://localhost:3000
npm run todo:build   # production build: examples/todo/dist/{client,server}
npm run todo:start   # node examples/todo/dist/server/server.js
npm run todo:raw     # no Vite: tsc, then plain node
npm run e2e          # Playwright, against dev and the production build
```

`vite build` also prerenders `/about` and `/config.json` (`@prerender`): they're
written into `dist/client` and served as plain files, handlers never run.
`/about`'s account area is a `<Dynamic>`: the file ships a skeleton, and the
runtime fills in who's signed in right after the page loads.

The stylesheet is `src/styles.css`, linked with `<Stylesheet href="src/styles.css" />`:
the source file in dev, `/assets/styles-<hash>.css` (cached for a year) in production.

`/todos` and `/todos/:id` also speak JSON:
`curl -H 'accept: application/json' localhost:3000/todos?filter=active`
(`@accepts("json")` on the list, `negotiate()` on the detail page).

There's also a REST API, same login (`src/routes/api.ts`):

| Request | Answer |
|---------|--------|
| `GET /api/todos` | your todos and counts |
| `POST /api/todos` `{"title"}` | 201 + `Location` (`@status(201)`, `ctx.setHeader`) |
| `GET /api/todos/:id` | the todo |
| `PATCH /api/todos/:id` `{"title"?, "notes"?, "done"?}` | only the fields you send change (all-optional `TodoChanges` DTO) |
| `DELETE /api/todos/:id` | 204 |

A missing todo is a `TodoNotFound` from the store, a domain error that the
route's `@catches(TodoNotFound)` turns into `404 {"error", "id"}`. Bad bodies
are a 400 listing every issue; no session is a 401.

Todos are saved to `.data/todos.json` (set `TODO_FILE` to move it, or
`TODO_FILE=:memory:` to keep nothing).

## Accounts

Sign up at `/signup`; everything under the app shell needs a login
(`@group("/", { guards: [auth.required] })`). Sessions are sealed cookies,
passwords are argon2id, and each user only ever sees their own todos: routes
work through `repo.for(me.id)`, and the live feeds only carry your changes.
`src/users.ts` has the user store and `createAuth(...)`; `src/routes/auth.tsx`
the login, signup and logout routes.

## Layouts

Every HTML response, error pages included, goes through layers of layouts:

| Page | Layouts (outermost first) | How |
|------|---------------------------|-----|
| `/todos` | `RootLayout` > `AppShell` | `app.layout(RootLayout)`, `@group("/", { layout: AppShell })` |
| `/todos/:id` | `RootLayout` > `AppShell` > `CardLayout` | nested `@group("/todos/:id", { group: App, layout: CardLayout })` |
| `/about` | `RootLayout` > `MarketingLayout` | `@layout(MarketingLayout)` on the route, no group |
| `/login`, `/signup` | `RootLayout` > `AuthLayout` | `@group("/", { layout: AuthLayout })` |
| `/share/:token` | `RootLayout` > `MarketingLayout` > `SharedCard` | `@layout(MarketingLayout, SharedCard)`: two in one decorator |
| 404 / errors | `RootLayout` > `ErrorPage` | `app.errorPage(ErrorPage)` |

Layouts get `meta` (title, description, canonical URL, active nav), merged from
group meta, route meta and `setMeta()` calls in handlers. `RootLayout` turns it
into `<title>`, the meta description and Open Graph tags. `AppShell` reads the todo count straight from DI
with `resolve(TodoRepo)`.

## Reactivity

- **Actions:** `<form action={this.add}>` and `bind(this.toggle, { id })` call
  route methods. Without JS: POST, then redirect back. With JS: the action
  returns `<Region>`s (list, toolbar, header count) that are morphed into the page.
- **Boosted links:** filters and nav fetch the next page and morph it in, with history.
  Todo titles also have `prefetch`, so hovering one warms its page and the click needs no request.
- **Live:** the shell subscribes to `/todos/events` (SSE); every change refreshes all tabs.
- **Validation:** `NewTodo` / `EditTodo` DTO classes; messages appear next to the form.
- **Custom attribute:** `relative-time={iso}` (`src/attributes.tsx`, made with
  `attribute()`). The server writes "3 minutes ago" plus `datetime` and a full
  date on hover; its client half (shipped as source text, so self-contained)
  re-renders the text every 15 seconds.
- **Upload:** "Import" on `/todos` takes a `.txt` file, one todo per line: an
  action whose `ImportTodos` DTO has `is.file({ types: ["text/plain"], maxSize })`.
  `enctype="multipart/form-data"` makes it work without JavaScript; with it, the
  runtime sends the file itself and the list updates in place.

## Sharing, and pages for crawlers

"Create link" on `/todos` gives a public, read-only `/share/<token>`
(`src/routes/share.tsx`). It's one route with two `@get` handlers:

- `@get page()`: people get the live page (boosted filters, ticking times).
- `@get(isBot) crawlable()`: search engines and link unfurlers get every todo
  with full notes, no filters and no client runtime (`setMeta({ scripts: false })`).

Both set the title, description and URL that `RootLayout` renders as Open Graph
tags, and `isBot` adds `Vary: User-Agent` so caches keep the two apart. Variants
need a request to test, which is why this page isn't prerendered.
`curl -A Googlebot localhost:3000/share/<token>` shows the crawler version.

## Logging

`app.logging({ filter })` in `src/app.ts` (`YERD_LOG` still wins). `TodoRepo`
and `UserRepo` log through `@logger`. `TodoList.update` and `TodoList.addMany`
are `@instrument`ed: spans with their arguments, except `"patch.notes"` (a
compiler-checked path into the argument: notes are the user's own words).

## Files

| File | What |
|------|------|
| `src/todos.ts` | `TodoRepo` service (JSON file persistence, change events, logging), DTOs, `TodoNotFound` |
| `src/users.ts` | `UserRepo` (accounts, share tokens), `createAuth(...)` |
| `src/attributes.tsx` | the `relative-time` custom attribute and `<Ago>` |
| `src/layouts.tsx` | `RootLayout` (Open Graph), `AppShell`, `CardLayout`, `MarketingLayout`, `SharedCard`, `ErrorPage` |
| `src/components.tsx` | list, rows, toolbar, new-todo form, share panel, import form |
| `src/routes/todos.tsx` | groups, list page with actions (share, import), detail page |
| `src/routes/share.tsx` | `/share/:token`: people vs `@get(isBot)` |
| `src/routes/pages.tsx` | `/` redirect, `/about` |
| `src/routes/api.ts` | SSE live feed, REST API, live NDJSON feed (`curl -N /api/todos/changes.ndjson`), NDJSON export |
| `src/styles.css` | the stylesheet (light/dark, responsive) |
