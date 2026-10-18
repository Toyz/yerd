# Logging

This page covers yerd's logger: structured events, spans, `@instrument`, filtering with `YERD_LOG`, request ids, and sending logs somewhere other than the console.

## Log something

Import [log](api:yerd.log) and call a level. The second argument is structured fields, not string interpolation.

```ts
import { log } from "@toyz/yerd";

log.info("server starting", { port: 3000 });
log.warn("cache cold");
log.error("charge failed", { orderId: 42, error: new Error("card declined") });
```

```text
12:04:01.239  INFO server starting port=3000 (app)
12:04:01.240  WARN cache cold (app)
12:04:01.241 ERROR charge failed orderId=42 (app)
                Error: card declined
                    at ...
```

Levels are `trace`, `debug`, `info`, `warn` and `error`. The `(app)` at the end is the target: `log` logs as `app`. An `Error` under the `error` field (or passed straight to `log.error(err)`) is logged with its stack. A call below the active level costs one cached lookup and builds nothing.

## A logger per class

`@logger` gives a class its own [Logger](api:yerd.Logger), with the class name as its target. Targets are what filters match on.

```ts
import { logger, service, type Logger } from "@toyz/yerd";

@service
export class Billing {
  @logger accessor log!: Logger; // target "Billing"

  async charge(order: { id: string; total: number }) {
    const orderLog = this.log.child({ orderId: order.id });
    orderLog.info("charging", { total: order.total });

    await this.log.span("stripe", { amount: order.total }, async () => {
      orderLog.debug("calling the payment API");
    });
  }
}
```

| Method | Does |
| --- | --- |
| `trace/debug/info/warn/error(message, fields?)` | write an event |
| `child(fields)` | a logger that adds these fields to every record |
| `for(target)` | the same logger under another target |
| `span(name, fields, fn, level = "info")` | run `fn` inside a span: enter and exit records, duration, nesting across `await` |
| `enabled(level)` | whether `level` would be written, to skip building expensive fields |

`@logger("billing")` picks a target of your own. Lifetimes don't matter: a singleton's logger still logs into whichever request is running.

## Requests are spans

Every request gets a root span with an id, and every event logged while handling it carries that span, from any service. When the request finishes you get one access line.

```text
12:04:01.239  INFO request{method=GET path=/todos/7} status=200 5.1ms
```

- The access line is `info` for 2xx and 3xx, `warn` for 4xx and `error` for 5xx, at target `yerd::request`.
- The request id is sent back as `x-request-id`. A well-formed incoming `x-request-id` (from your load balancer, say) is reused instead.
- An incoming W3C `traceparent` header is continued: every record gets its trace id.
- Handlers can read the id as `currentContext().requestId`.
- Crashes are logged with their stack; the client only ever sees "Internal Server Error".

> [!NOTE]
> The request span only exists while `yerd::request` is enabled at `info`. With `YERD_LOG=warn` there's no access line and no `x-request-id` header (though `requestId` still works in handlers).

## @instrument

[instrument](api:yerd.instrument) wraps a method in a span with its arguments as fields, plus the return value and duration on exit. A throw is logged at `error` and rethrown.

```ts
import { instrument, service } from "@toyz/yerd";

@service
export class UserRepo {
  @instrument() async find(id: number) {
    return { id, name: "ada" };
  }

  @instrument({ skip: ["password"], level: "info" })
  async create(email: string, password: string) {
    return { email };
  }

  @instrument({ skipAll: true, ret: false, fields: (_self, [order]) => ({ orderId: order.id }) })
  ship(order: { id: string }) {}
}
```

```text
12:04:01.239 DEBUG   UserRepo::find{id=7}
12:04:01.244 DEBUG   UserRepo::find ret={"id":7,"name":"ada"} 5.1ms
```

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `"Class::method"` | span name |
| `level` | `"debug"` | level of the span's records |
| `target` | the class name | target, for filtering |
| `skip` | `[]` | arguments or nested fields to leave out (see below) |
| `skipAll` | `false` | record no arguments |
| `fields` | none | `(self, args) => ({ ... })`, extra or derived fields |
| `ret` | `true` | record the return value on exit |
| `err` | `true` | log a throw at `error` (it's always rethrown) |

When the span's level is off, the method is called directly: no argument capture, no timing. Sync methods stay sync.

### Skipping, checked by the compiler

`skip` takes parameter names, positions, and dotted paths into either, down through nested objects and arrays. The logged copy loses those fields; the real argument is untouched.

```ts
import { instrument } from "@toyz/yerd";

interface Signup {
  email: string;
  password: string;
  billing: { card: string; cvc: string };
}

export class Accounts {
  @instrument({ skip: ["input.password", "input.billing.cvc", "1.headers.authorization"] })
  create(input: Signup, request: { headers: { authorization: string } }) {
    return input.email;
  }
}
```

The paths are type-checked: `"input.billing.pin"` or `"1.headers.cookie"` is a compile error naming the field that doesn't exist. TypeScript can't see parameter *names*, only positions and types, so the part after a name is checked by the compiler and the name itself when the class loads (a misspelled name throws right there, before any request). Positional paths (`"0.password"`) are checked end to end.

> [!TIP]
> Argument names are read from the compiled function source, so keep server code unminified (the Vite plugin does). If a name ever trips you up (a bundler renamed it), positional paths don't depend on names at all.

## Filtering with YERD_LOG

`YERD_LOG` works like Rust's `RUST_LOG`: a default level, then overrides per target or per span.

```sh
YERD_LOG=info                          # everything at info and above
YERD_LOG=warn,UserRepo=debug           # quiet, except one class
YERD_LOG=info,yerd=warn                # hush yerd's own logs (targets start with yerd::)
YERD_LOG=info,[stripe]=trace           # everything inside a span named stripe
YERD_LOG=off                           # nothing at all
```

- A target directive covers the target and everything under it: `yerd` matches `yerd::request`. The most specific match wins, and a later directive for the same target replaces an earlier one (`$DEFAULTS,UserRepo=trace`).
- A span directive (`[name]=level`) sets the level for everything logged inside a span with that name, whatever its target: louder (`info,[stripe]=trace`) or quieter (`debug,[healthcheck]=warn`). The innermost matching span decides.
- Without `YERD_LOG`, the level is `info`, or `warn` when `NODE_ENV=test`.
- A typo (`UserRepo=chatty`) is a boot error, not a silent no-op.

yerd's own targets include `yerd::request`, `yerd::lifecycle` (hooks, hosted services, `@every`), `yerd::boot` and `yerd::stream`.

## app.logging()

Set the filter and output format in code with `app.logging()`.

```ts
import { yerd } from "@toyz/yerd";

export const app = yerd().logging({
  filter: "info,UserRepo=debug",
  format: "json",
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `filter` | `YERD_LOG`, else `info` (`warn` under tests) | directives, as above |
| `format` | `YERD_LOG_FORMAT`, else `pretty` on a terminal outside production, `json` otherwise | console output format |

> [!TIP]
> `YERD_LOG` and `YERD_LOG_FORMAT` win over what you pass here, so the values in code are defaults that a deploy can still change without a rebuild.

JSON output is one object per line (`t`, `level`, `target`, `msg`, plus `kind`, `fields`, `spans`, `ms`, `error` and `trace` when present), ready for any log shipper. Info and below go to stdout in batches; warnings and errors go to stderr immediately.

## Custom sinks

Code always talks to `Logger`. Where records end up is the [ILogger](api:yerd.ILogger) service: register one and yerd uses it instead of its [ConsoleLogger](api:yerd.ConsoleLogger).

```ts
import { ILogger, service, type LogRecord } from "@toyz/yerd";

@service({ provides: ILogger })
export class HttpLogger implements ILogger {
  #buffer: LogRecord[] = [];

  write(record: LogRecord) {
    this.#buffer.push(record);
  }

  async flush() {
    const batch = this.#buffer.splice(0);
    if (batch.length) await fetch("https://logs.example.com/ingest", { method: "POST", body: JSON.stringify(batch) });
  }
}
```

- `write(record)` is synchronous and must not throw; a failing sink is reported to `console.error` and never breaks a request.
- `flush()` is optional and runs when the app stops.
- The sink must be a singleton (anything else is a boot error).

To keep the console and add your own, fan out with [teeLogger](api:yerd.teeLogger):

```ts
import { ConsoleLogger, ILogger, teeLogger, yerd } from "@toyz/yerd";

export const app = yerd().services((s) =>
  s.value(ILogger, teeLogger(new ConsoleLogger({ format: "pretty" }), new HttpLogger())),
);
```

`ConsoleLogger` takes `format` and `color` (default: on for a terminal unless `NO_COLOR` is set).

## Redaction and limits

Every field passes through a sanitizer before it reaches any sink, yours included.

```ts
log.info("login", { user: "ada", password: "hunter2", headers: { authorization: "Bearer x" } });
// fields: { user: "ada", password: "[redacted]", headers: { authorization: "[redacted]" } }
```

- A key is redacted (`"[redacted]"`, at any depth, `@instrument` arguments included) when one of its words is a secret-sounding one: `password`, `pass`, `secret`, `token`, `auth`, `authorization`, `cookie`, `session`, `credential`, `signature`, `otp`, or `api key` / `private key`. Words are split on camelCase, `_`, `-` and `.`, and a trailing number is ignored (`password2`).
- Values are bounded: depth 4, strings 256 characters, arrays 20 items, objects 30 keys. Circular references, binary data and class instances are summarized.

> [!NOTE]
> Whole words, so `csrfToken`, `x-api-key` and `sessionId` (a session id is a credential) are redacted, but `passengers` and `tokenizer` aren't.
