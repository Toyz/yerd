# hello

The yerd example app: decorated routes, TSX pages, a DTO body, an NDJSON
stream, DI and background services.

From the repo root:

```sh
npm install
npm run dev          # Vite dev server on http://localhost:3000, hot reload
npm run example:raw  # no Vite: tsc, then plain node (PORT=3001 to change port)
```

Try:

```sh
curl localhost:3000/users/7
curl localhost:3000/api/stats
curl -N 'localhost:3000/api/ticks?count=5'
curl -X POST localhost:3000/api/signup -H 'content-type: application/json' -d '{"email":" ADA@x.io ","age":36}'
curl -X POST localhost:3000/api/signup -H 'content-type: application/json' -d '{"email":"nope","age":7}'
```

| File | Shows |
|------|-------|
| `src/routes/users.tsx` | `@route`, `@param` with a transform, `@query`, async components, streaming HTML |
| `src/routes/home.tsx` | JSX, JSON and text responses from the coercion table |
| `src/routes/api.ts` | DTO body (`is.*`), NDJSON streaming, `@inject` |
| `src/services.ts` | `@service`, `@hosted`, `@every`, `@onBoot`, `@onShutdown` |
| `src/main.ts` | Vite entry: default-exports the app |
| `src/server.ts` | raw entry: `listen()` |
