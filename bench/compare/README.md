# Framework comparison

yerd against Express, Fastify, Hono, Koa and NestJS, plus plain `node:http` as a ceiling. This is
its own package: the competitors are dependencies here, never of `@toyz/yerd`.

## Run

```sh
npm run build                 # at the repo root: yerd is used from its built dist/
cd bench/compare
npm ci
npm run build                 # tsc: servers/ -> dist/
node run.mjs                  # full run: writes results.json, refreshes the table below
node run.mjs --server-cpus 8,9 --client-cpus 10-15   # same, pinned (how the results below were made)
node run.mjs --frameworks yerd,fastify --scenarios json,ssr --duration 5   # partial: prints only
```

Options: `--frameworks`, `--scenarios`, `--duration` (10), `--warmup` (3), `--runs` (3),
`--connections` (100), `--workers` (4, client threads sharing the connections), `--write` (write
results.json from a partial run), `--server-cpus` with `--client-cpus` (pin both with `taskset`).

Pinning matters on CPUs with two dies (the 7950X3D these were run on has a V-Cache die and a
faster one): unpinned, the same server swung 103k-126k req/s between runs depending on where the
scheduler put it. `8,9` and `10-15` keep the server and the client on the same (faster) die.

Each server starts in its own child process with `NODE_ENV=production`, is checked (status,
content type, body, and that bad input is refused) before it's measured, then gets a warmup and
`runs` measured runs per scenario; the run with the median req/s is reported. Servers are killed
between frameworks. Run it on a quiet machine: the client and the server share the CPU.

## Scenarios

| id | request | measures |
| --- | --- | --- |
| `json` | `GET /json` -> `{"hello":"world"}` | routing + JSON serialization floor |
| `params` | `GET /users/42?fields=a,b` | path param to number, query parsing |
| `body` | `POST /echo`, ~1 KB JSON | body reading, JSON parse, validation of a string and a number field |
| `ssr` | `GET /page` | a layout plus 100 rows of escaped text, ~15 KB of HTML |
| `middleware` | `GET /secure` with `Authorization` | an auth check before the handler (guard, hook or middleware) |

Servers live in `servers/`, one file per framework, written the way each framework's docs would.

## Fairness notes

- One process per server, no cluster. The client is on the same host: 100 connections in total,
  pipelining 1, keep-alive on, split across 4 autocannon instances in worker threads (one
  autocannon thread tops out near 125k req/s here, which capped the fastest servers). Absolute
  numbers are machine-bound; compare ratios.
- Latency p50/p99 are computed from every 2xx response's time (autocannon's own histogram rounds
  to whole milliseconds). MB/s is decimal.
- Request logging is off everywhere (yerd `logging({ filter: "warn" })`, Fastify and Nest
  `logger: false`, the rest log nothing by default).
- Validation: yerd a DTO with `is.string()` / `is.number()`; Fastify a JSON schema; Nest
  class-validator through `ValidationPipe`; Express, Koa, Hono and the baseline one shared
  hand-written check (`servers/shared.ts`).
- SSR: yerd TSX with a layout; Hono `hono/jsx`; Express, Fastify, Koa and Nest React 19
  `renderToString`; the baseline concatenates template strings. Page sizes are checked to be within
  3% of each other (in practice they differ by 2 bytes: React and Hono write `<meta .../>`).
- yerd streams pages (chunked); the others send one buffered string with a content-length.
- yerd does more per request than a bare router: a request context, the route class instance built
  through the DI container in a request scope, decorated accessors resolved, an
  `x-content-type-options: nosniff` header. Express adds an ETag and `X-Powered-By` by default;
  left on since they're defaults.
- NestJS runs on `@nestjs/platform-fastify`.

## Latest results

<!-- results:start -->
(no full run yet)
<!-- results:end -->
