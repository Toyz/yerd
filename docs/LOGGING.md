# yerd logging: tracing, like Rust's `tracing`

> **Built (2026-10-17), server side.** In `src/log/`: the `ILogger` sink token
> and `teeLogger`, the `Logger` facade (`log`, `@logger`, `child`, `span`),
> `ConsoleLogger` (pretty / json), `YERD_LOG` filtering with target and span
> directives, `@instrument`, the safe serializer with redaction, parameter
> names from compiled source, and the request root span (request id from
> `x-request-id`, `traceparent` continued, one access log record at
> `yerd::request`: info, warn for 4xx, error for 5xx). yerd's own messages go
> through it (`yerd::request`, `yerd::lifecycle`, `yerd::stream`,
> `yerd::channels`, `yerd::boot`). Not built yet: the browser side and
> `collectClient`, `traceparent` on outgoing fetch (`propagate`),
> `instrument` via `createWrapper` (it's a plain method decorator for now),
> and per-call-site caching beyond the per-target cache. Configure with
> `yerd().logging({ filter, format })`; tests run at `warn` unless YERD_LOG
> says otherwise.

Structured logs with spans, built on the decorator kit. `@instrument` is Rust's
`#[instrument]`: it wraps a method, records its arguments as fields, times it,
logs the return value or error, and nests under whatever span is already open.
Everything goes to an `ILogger` from DI. Register your own and yerd uses it;
register nothing and yerd uses its built-in console logger.

No pino, no winston, no OpenTelemetry SDK.

## What it looks like

```ts
@service
export class UserRepo {
  @logger accessor log!: Logger;                 // category "UserRepo", like ILogger<UserRepo>
  @inject(Db) accessor db!: Db;

  @instrument()
  async find(id: number) {
    const row = await this.db.one("select * from users where id = $1", [id]);
    if (!row) this.log.warn("user missing", { id });
    return row;
  }

  @instrument({ skip: ["password"], ret: false, level: "info" })
  async create(email: string, password: string) { ... }

  @instrument({ fields: (self, [order]) => ({ orderId: order.id, total: order.total }) })
  async charge(order: Order) { ... }
}
```

Dev output (pretty, indented by span depth):

```
12:04:01.233  INFO request{id=7f3a method=GET path=/users/7}
12:04:01.234 DEBUG   UserPage::show{id=7}
12:04:01.234 DEBUG     UserRepo::find{id=7}
12:04:01.239  WARN       user missing id=7
12:04:01.239 DEBUG     UserRepo::find ret=null 5.1ms
12:04:01.241 DEBUG   UserPage::show ret=404 7.0ms
12:04:01.241  INFO request status=404 8.2ms
```

Production output: one JSON object per line, every event carrying its span
chain.

```json
{"t":"2026-10-17T12:04:01.239Z","level":"warn","target":"UserRepo","msg":"user missing","fields":{"id":7},"spans":[{"name":"request","id":"7f3a","fields":{"method":"GET","path":"/users/7"}},{"name":"UserPage::show","fields":{"id":7}},{"name":"UserRepo::find","fields":{"id":7}}],"trace":"4bf92f3577b34da6a3ce929d0e0e4736"}
```

## `ILogger`: bring your own, or don't

```ts
// core, src/log/ilogger.ts
export const ILogger = token<ILogger>("ILogger");

export interface ILogger {
  write(record: LogRecord): void;
  /** optional fast path: skip building records nobody will write */
  enabled?(level: Level, target: string): boolean;
  /** optional, called at shutdown */
  flush?(): void | Promise<void>;
}

export interface LogRecord {
  time: number;
  level: "trace" | "debug" | "info" | "warn" | "error";
  target: string;            // category: class name or explicit
  message: string;
  fields: Record<string, unknown>;
  spans: SpanRecord[];       // root -> current
  kind: "event" | "span-enter" | "span-exit";
  durationMs?: number;       // span-exit only
  error?: { name: string; message: string; stack?: string };
  traceId?: string;
  spanId?: string;
}
```

`ILogger` is the sink, deliberately one method. Users never call it directly.
What code talks to is the `Logger` facade (`info`, `debug`, `warn`, `error`,
`trace`, `span`, `child`), which builds records and hands them to whichever
`ILogger` is registered.

**Resolution:** at boot yerd does the equivalent of `@maybe(ILogger)`.
- Registered (by `@service` on a class that `implements ILogger` with
  `provides: ILogger`, or `s.singleton(ILogger, MyLogger)`): that's the sink.
- Not registered: `ConsoleLogger`, built in.

```ts
// user-land: ship logs somewhere else. Their dep, if any.
@service({ provides: ILogger })
export class HttpLogger implements ILogger {
  #buf: LogRecord[] = [];
  write(r: LogRecord) { this.#buf.push(r); if (this.#buf.length >= 100) void this.flush(); }
  async flush() { await fetch(LOG_URL, { method: "POST", body: JSON.stringify(this.#buf.splice(0)) }); }
}
```

Fan-out to several sinks: `s.singleton(ILogger, teeLogger(ConsoleLogger, HttpLogger))`.

## Built-in `ConsoleLogger`

- **pretty** when stdout is a TTY and not production: aligned levels, colors
  (hand-written ANSI), indentation by span depth, durations on span exit.
- **json** otherwise: one line per record, the shape above.
- Override with `YERD_LOG_FORMAT=pretty|json`.
- Writes go to `process.stdout` / `process.stderr` (warn and error), buffered and
  flushed on shutdown so the last lines before exit aren't lost.

## Filtering: `YERD_LOG`, like `RUST_LOG`

```
YERD_LOG=info                          # everything at info+
YERD_LOG=warn,UserRepo=debug           # quiet, except one class
YERD_LOG=info,yerd::router=debug       # yerd internals have yerd:: targets
YERD_LOG=info,[charge]=trace           # any span named charge, and everything inside it
```

Same idea as `tracing_subscriber::EnvFilter`: comma-separated directives, most
specific wins, span-name directives enable everything nested in that span. Also
settable in code: `yerd().logging({ filter: "info,UserRepo=debug" })`.

**Disabled means free.** The filter decision for each call site
(class + method + level) is computed once and cached, and recomputed only when
the filter changes. When a span is disabled, `@instrument` calls the method
directly: no argument serialization, no timing, no record.

## `@instrument`

Built with `createWrapper` and `ctx.call` (see DECORATORS.md), no private hooks.

| Option       | Default        | Like Rust's         | Does                                                  |
|--------------|----------------|---------------------|-------------------------------------------------------|
| `name`       | `Class::method`| `name = "..."`      | span name                                             |
| `level`      | `"debug"`      | `level = "..."`     | level of enter/exit records                           |
| `skip`       | `[]`           | `skip(a, b)`        | parameter names to leave out                          |
| `skipAll`    | `false`        | `skip_all`          | record no arguments                                   |
| `fields`     | none           | `fields(...)`       | `(self, args) => ({...})` extra or derived fields      |
| `ret`        | `true`         | `ret`               | log the return value on exit                          |
| `err`        | `true`         | `err`               | log thrown errors / rejections at `error`, rethrow    |
| `target`     | class name     | `target = "..."`    | category for filtering                                |

**Argument names.** JS has no runtime parameter names, so yerd parses them from
the method's compiled source (`fn.toString()`, the same trick tier 2 sprinkles
use), once, at decoration time. `find(id, opts)` logs `id=7 opts={...}`.
Destructured or rest params fall back to `arg0`, `arg1`. A shitpost technique
that happens to work, because tsc output is predictable.

**Safe serialization.** Hand-written, never throws: depth limit 4, string limit
256 chars, array limit 20 items, circular references printed as `[Circular]`,
class instances as `ClassName{...}`, `Buffer`/`Uint8Array` as length only,
errors as `{ name, message }`.

**Redaction by default.** Fields whose names match
`/pass|secret|token|authorization|cookie|session|api[-_]?key/i`, at any depth,
are written as `[redacted]`. Configurable, but on by default, because
`@instrument` on a login method would otherwise log the password. `skip` is
for leaving fields out; redaction is the safety net when someone forgets.

## Spans

- **Context propagates through `AsyncLocalStorage`** on the server, so spans nest
  across `await` without passing anything around, and events logged inside a
  span carry the whole chain's fields (Rust's span field inheritance).
- **Every request is a root span**: `request{id method path}`, closed with
  `status` and duration. That's yerd's access log, built from the same system.
  Request ids come from `x-request-id` if present (validated), else generated.
- **Manual spans** when there's no method to decorate:
  ```ts
  await this.log.span("import-batch", { size: rows.length }, async () => { ... });
  ```
- **W3C trace context.** Incoming `traceparent` headers are parsed and continued;
  span ids are 8-byte hex, trace ids 16-byte hex, so a user-written sink can map
  records onto OpenTelemetry spans without translation. Outgoing `fetch` from
  inside a request can get `traceparent` added via `yerd().logging({ propagate: true })`.

## Logger in DI, C# style

- `@logger accessor log!: Logger` is a `Logger` with `target` set to the owning
  class name, like injecting `ILogger<UserRepo>`. `@logger("billing")` sets an
  explicit category.
- `@inject(Logger)` also works and gives the untargeted root logger.
- Lifetimes don't matter: the facade reads the current span from ALS on every
  call, so a singleton service logs into the current request's span tree.
- yerd's internals use the same facade with `yerd::router`, `yerd::render`,
  `yerd::di`, `yerd::boot` targets. Boot validation errors are log records too,
  so a custom `ILogger` sees them.

## In the browser

`@toyz/yerd/kit` is isomorphic, so `@instrument` and `@logger` work on island methods.

- Default client sink logs to the browser console, spans as
  `console.groupCollapsed`, levels mapped to `console.debug/info/warn/error`.
- Filter from `localStorage.YERD_LOG` or a `data-yerd-log` attribute on
  `<html>`, same directive syntax.
- Spans nest across `await` in islands too, through yerd's browser
  `AsyncLocalStorage` polyfill (see DYNAMICS.md, "AsyncLocalStorage in the
  browser"). Code tsc didn't compile into the client graph loses span context
  after a native `await`; log through the span's own logger (`span.log.info(...)`)
  there.
- Optional: `yerd().logging({ collectClient: "warn" })` makes the client sink
  batch warn+ records to a built-in endpoint and replay them into the server's
  `ILogger` with `target` prefixed `client::`. Rate-limited, size-capped, and
  only from pages yerd rendered (CSRF token required).

## Files

```
src/log/
  ilogger.ts        ILogger token + LogRecord types
  logger.ts         Logger facade, child(), span()
  console.ts        ConsoleLogger: pretty + json
  filter.ts         YERD_LOG directive parser, call-site cache
  span.ts           span stack on @toyz/yerd/async-context (ALS on Node, polyfill in browser), trace context
  instrument.ts     @instrument, built with createWrapper
  serialize.ts      safe serializer + redaction
  params.ts         parameter-name extraction from fn.toString()
  tee.ts            teeLogger
```

## Tests that must exist

- No `ILogger` registered: `ConsoleLogger` is used. Registered: it receives every record, including yerd's boot and request records.
- Disabled level: the wrapped method runs, no serializer call happens (spy on it).
- `skip`, `skipAll`, `fields`, `ret: false`, `err` rethrows the original error.
- Redaction catches `password`, nested `{ auth: { token } }`, and `Authorization` headers.
- Circular, huge and binary arguments don't throw or blow up output size.
- Spans nest across `await` on the server; a singleton service's log lands in the right request's span.
- `YERD_LOG` precedence: `warn,UserRepo=debug` and span-name directives.
- Sync methods stay sync when wrapped.
- `traceparent` in, same trace id out.
