# {{name}}

A JSON API on [yerd](https://toyz.github.io/yerd/): routes are decorated
classes, bodies are validated DTOs, errors are classes with a status.

```sh
{{run_dev}}      # dev server with reloads, on http://localhost:5173
{{run_test}}     # vitest, in-process: no port
{{run_check}}    # type-check (Vite doesn't)
{{run_build}}    # production build: dist/server/server.js
{{run_start}}    # node dist/server/server.js, on PORT or 3000
```

```sh
curl localhost:5173/api/notes
curl -X POST localhost:5173/api/notes -H 'content-type: application/json' -d '{"title":"Ship it"}'
curl -X DELETE localhost:5173/api/notes/1
```

| Route | What |
| --- | --- |
| `GET /api/notes` | every note; `?done=true` filters |
| `POST /api/notes` | 201 with the note; 400 listing every invalid field; 409 for a duplicate title |
| `GET /api/notes/:id` | the note, or a 404 carrying the id |
| `PUT /api/notes/:id` | replace it |
| `DELETE /api/notes/:id` | 204, no body |
| `GET /api/health` | 204, for load balancers |

| File | What |
| --- | --- |
| `src/main.ts` | the Vite entry: the app with every route under `src/routes/` |
| `src/app.ts` | `createApp()`, shared with the tests |
| `src/notes.ts` | `NoteInput` DTO, `NoteNotFound`, the `Notes` service |
| `src/routes/notes.ts` | the routes |
| `test/notes.test.ts` | `app.request()` tests |

Add `.sessions()` in `src/app.ts` when you need cookies, and see
[request data](https://toyz.github.io/yerd/#/guide/request-data) and
[responses](https://toyz.github.io/yerd/#/guide/responses) for the rest.
