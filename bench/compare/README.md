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
- NestJS runs on `@nestjs/platform-fastify` (which pins its own Fastify, 5.12.5).
- Noise: between two full runs most cells moved by about 10% or less (yerd params by 14%); the first
  run also had a yerd ssr result 26% low while other work was running on the host, so it was run
  again. Treat gaps under ~10% as ties. The benchmark itself keeps 5-6 threads busy, which is most of
  the load average during a run.
- Found while building this: yerd reads request bodies with `for await (const chunk of req)`
  (`src/server/body.ts`, `readAll`). On bare `node:http` that costs ~12% versus `data`/`end`
  listeners for this 1 KB POST (about 88k vs 100k req/s), which accounts for part of yerd's gap in
  `body`.

## Latest results

<!-- results:start -->
Generated 2026-10-18 on AMD Ryzen 9 7950X3D 16-Core Processor (32 cores, 62 GB), Linux 7.2.10-1-cachyos x64, Node v26.12.0. Load average 2.27 3.01 3.56 at start.

### JSON hello (`json`)

| framework | req/s | vs best | p50 ms | p99 ms | MB/s | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| node:http (baseline) | 129,650 | - | 0.72 | 1.46 | 24.24 | 0 |
| Fastify | 121,397 | 100% | 0.78 | 1.56 | 22.82 | 0 |
| Hono | 120,249 | 99% | 0.78 | 1.52 | 20.68 | 0 |
| NestJS (Fastify) | 106,171 | 87% | 0.88 | 1.71 | 19.96 | 0 |
| yerd | 103,599 | 85% | 0.91 | 1.85 | 22.79 | 0 |
| Koa | 91,347 | 75% | 1.06 | 1.88 | 17.08 | 0 |
| Express | 71,146 | 59% | 1.33 | 2.78 | 17.93 | 0 |

### Route and query params (`params`)

| framework | req/s | vs best | p50 ms | p99 ms | MB/s | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| node:http (baseline) | 126,570 | - | 0.76 | 1.48 | 25.06 | 0 |
| Fastify | 116,253 | 100% | 0.81 | 1.57 | 23.13 | 0 |
| Hono | 113,951 | 98% | 0.83 | 1.59 | 20.85 | 0 |
| Koa | 86,697 | 75% | 1.13 | 1.91 | 17.17 | 0 |
| NestJS (Fastify) | 86,672 | 75% | 1.11 | 2.06 | 17.25 | 0 |
| yerd | 84,838 | 73% | 1.02 | 3.79 | 19.60 | 0 |
| Express | 59,642 | 51% | 1.59 | 2.95 | 15.69 | 0 |

### Validated JSON body (`body`)

| framework | req/s | vs best | p50 ms | p99 ms | MB/s | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| node:http (baseline) | 93,776 | - | 1.04 | 1.78 | 19.88 | 0 |
| Fastify | 83,103 | 100% | 1.16 | 1.86 | 17.70 | 0 |
| Hono | 78,023 | 94% | 1.23 | 1.91 | 15.37 | 0 |
| yerd | 60,612 | 73% | 1.57 | 2.95 | 14.85 | 0 |
| Koa | 53,488 | 64% | 1.77 | 3.20 | 11.34 | 0 |
| Express | 43,694 | 53% | 2.21 | 4.21 | 12.10 | 0 |
| NestJS (Fastify) | 42,305 | 51% | 2.29 | 3.20 | 9.22 | 0 |

### Server-rendered page (`ssr`)

| framework | req/s | vs best | p50 ms | p99 ms | MB/s | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| node:http (baseline) | 21,140 | - | 4.70 | 7.65 | 325.47 | 0 |
| yerd | 11,265 | 100% | 8.84 | 14.16 | 174.02 | 0 |
| Fastify | 9,462 | 84% | 10.84 | 18.67 | 145.71 | 0 |
| Koa | 9,159 | 81% | 10.92 | 16.25 | 141.03 | 0 |
| NestJS (Fastify) | 8,644 | 77% | 11.55 | 18.22 | 133.11 | 0 |
| Express | 8,574 | 76% | 12.21 | 15.65 | 132.60 | 0 |
| Hono | 8,310 | 74% | 12.08 | 20.36 | 127.96 | 0 |

### Auth middleware (`middleware`)

| framework | req/s | vs best | p50 ms | p99 ms | MB/s | errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| node:http (baseline) | 125,971 | - | 0.74 | 1.43 | 24.69 | 0 |
| Fastify | 120,846 | 100% | 0.80 | 1.55 | 23.81 | 0 |
| Hono | 101,589 | 84% | 0.91 | 1.98 | 18.39 | 0 |
| yerd | 98,858 | 82% | 0.95 | 1.88 | 22.64 | 0 |
| NestJS (Fastify) | 97,789 | 81% | 0.98 | 1.60 | 19.26 | 0 |
| Koa | 87,660 | 73% | 1.12 | 1.72 | 17.18 | 0 |
| Express | 69,767 | 58% | 1.39 | 2.17 | 18.21 | 0 |

<!-- results:end -->
