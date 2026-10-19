# {{name}}

A [yerd](https://toyz.github.io/yerd/) app: one page, a layout and an action.

```sh
{{run_dev}}      # dev server with reloads, on http://localhost:5173
{{run_test}}     # vitest, in-process: no port, no browser
{{run_check}}    # type-check (Vite doesn't)
{{run_build}}    # production build: dist/client and dist/server/server.js
{{run_start}}    # node dist/server/server.js, on PORT or 3000
```

Copy `.env.example` to `.env` and set `YERD_SECRET` before you deploy: it
signs forms and seals the session cookie.

| File | What |
| --- | --- |
| `src/main.ts` | the Vite entry: the app with every route under `src/routes/` |
| `src/app.ts` | `createApp()`: layout, error page, sessions; shared with the tests |
| `src/layouts.tsx` | `RootLayout`, the document; `ErrorPage` for 404s and crashes |
| `src/routes/home.tsx` | `GET /` and its `click` action |
| `src/styles.css` | linked with `<Stylesheet>`, hashed in the build |
| `test/app.test.ts` | `app.request()` and `app.client()` tests |

Next: [your first app](https://toyz.github.io/yerd/#/guide/your-first-app)
walks through routes, pages, forms and sessions.
