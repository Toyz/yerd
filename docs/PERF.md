# Performance

Measured 2026-10-17 on the dev machine (32 cores, Node 26.12, one process
per server, autocannon with 50 connections, 5 s per scenario after a 5 s
warm-up). Numbers are for comparison between runs, not absolute claims.

Reproduce: `npm run bench` (builds `bench/` with tsc, runs `bench/run.mjs`).
Micro benchmark for the renderer: `npx tsc -p tsconfig.bench.json && node dist/bench/render-loop.js`.

## Results

| scenario | before | after | raw node:http |
|---|---:|---:|---:|
| `/plain` (text) | 80,851 req/s | **113,120** | 131,066 |
| `/json` | 78,675 | **108,576** | 134,541 |
| `/rows/7` (DI + parsed param + query) | 73,018 | **98,899** | |
| `/page` (layout + 100 component rows) | 4,522 | **15,498** | |
| `/page-async` (same, async component) | 4,492 | **14,745** | |

yerd's request path now runs at ~86% of a bare `node:http` handler; the
rest is routing, the request context, DI and coercion. Server-side rendering
of a 400-element page went from ~220 µs to ~45 µs.

## What changed

**Renderer: synchronous first.** It used to be an async generator per node,
so every element paid for a generator, a promise and several microtasks even
when nothing was async. Now every render function returns `undefined` when it
finished synchronously, or a promise when it had to wait; the walk only goes
async at an actual await (an async component, a promise child). Chunks are
still flushed exactly at those points, so streaming behaves the same.

**Renderer: no repeated work.** Tag and attribute names are validated once
and remembered (capped sets, in case names come from user data);
`classNames` flattens arrays and objects in one pass with no intermediate
arrays; the skipped-props Set became two comparisons.

**Request context: a class, lazily filled.** It was an object literal with a
dozen getter closures, plus an AbortController, a `res.on("close")` listener,
a `URL`, a `URLSearchParams` and a `Map` on every request. Now it's a
`RequestContext` class (getters on the prototype) and each of those is built
on first use. Plain-body responses never create an abort signal at all.
Request targets are split by hand instead of parsed with `URL` (absolute-form
targets still go through `URL`).

**One async context instead of two.** Each request ran `AsyncLocalStorage`
twice (request context, then DI scope), for both the handler and the send. DI
now reads its scope from the request context, so it's one `run` per phase.

**Smaller things.** `YerdKey.set` assigns instead of `Object.defineProperty`
(symbol keys are already invisible to `for...in`, `Object.keys` and JSON);
an empty DI scope skips its async dispose.

**Second pass.** `escapeHtml` keeps V8's native regex search as the fast
path for strings with nothing to escape (a pure `charCodeAt` loop measured
7-15x slower there: 104 ns vs 15 ns short, 8.5 µs vs 0.5 µs for 1 KB), and
only when something needs replacing switches to a hand-written scan from the
first hit. That scan beats `replace` with a callback (4.2 µs vs 4.9 µs on
dense markup). A 500k-string differential fuzz against the old version
matched exactly. `send()` copies headers with a plain loop instead of
rest-destructuring. Neither moves the page benchmark outside its noise.

**After the hardening pass.** The audit fixes added work on the hot paths,
measured and partly bought back: request handling is back where it was
(`/plain` 113.6k, `/json` 110k, `/rows/7` 98.6k req/s) after two fixes found
by profiling. Page streams were primed through an extra async-context run
for every response (now only for streamed bodies), and the DI container
recorded each instance's disposal list in a `WeakMap` (now a symbol
property, as `OWNER` is; WeakMap entries are costly for the GC at one route
instance per request). Pages are ~5% slower (`/page` 14.7k vs 15.5k): the
price of the new rendering checks (URL scheme neutralising, enumerated
attributes, void-element children, custom attribute lookup, folded into one
cached lookup per attribute name).

**Logging.** With request logging off (`YERD_LOG=warn`) the request path is
unchanged (`/plain` 114k req/s): no span, no id, one cached filter lookup.
With the access log on, `/plain` does about 84k req/s, writing one JSON line
per request to stdout; the cost is mostly the write itself, plus
`JSON.stringify`. Span and trace ids come from a pooled random buffer (a
crypto call per id took it down to 69k). `npm run bench` runs with
`YERD_LOG=warn`; set `YERD_LOG=info` to measure with the access log.

## Profile after

Running `/plain` under load, the biggest single cost is
`writeUtf8String` (the socket write, which raw node:http pays too), then GC.
The renderer profile is now dominated by the tree walk itself, `jsx()` object
creation (the page building its tree) and HTML escaping.

## Not done yet

- Static subtrees could be pre-rendered to strings once (compile-time JSX
  hoisting, like what some frameworks' compilers do).
- No HTTP/2.
