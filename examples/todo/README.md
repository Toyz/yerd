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
| 404 / errors | `RootLayout` > `ErrorPage` | `app.errorPage(ErrorPage)` |

Layouts get `meta` (title, active nav), merged from group meta, route meta and
`setMeta()` calls in handlers. `AppShell` reads the todo count straight from DI
with `resolve(TodoRepo)`.

## Reactivity

- **Actions:** `<form action={this.add}>` and `bind(this.toggle, { id })` call
  route methods. Without JS: POST, then redirect back. With JS: the action
  returns `<Region>`s (list, toolbar, header count) that are morphed into the page.
- **Boosted links:** filters and nav fetch the next page and morph it in, with history.
  Todo titles also have `prefetch`, so hovering one warms its page and the click needs no request.
- **Live:** the shell subscribes to `/todos/events` (SSE); every change refreshes all tabs.
- **Validation:** `NewTodo` / `EditTodo` DTO classes; messages appear next to the form.

## Files

| File | What |
|------|------|
| `src/todos.ts` | `TodoRepo` service (JSON file persistence, change events), DTOs |
| `src/layouts.tsx` | `RootLayout`, `AppShell`, `CardLayout`, `MarketingLayout`, `ErrorPage` |
| `src/components.tsx` | list, rows, toolbar, new-todo form |
| `src/routes/todos.tsx` | groups, list page with actions, detail page |
| `src/routes/pages.tsx` | `/` redirect, `/about` |
| `src/routes/api.ts` | SSE live feed, live NDJSON feed (`curl -N /api/todos/changes.ndjson`), JSON API, NDJSON export |
| `src/styles.css` | the stylesheet (light/dark, responsive) |
