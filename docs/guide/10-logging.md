# Logging

The logger: structured events, spans, `@instrument`, filtering with `YERD_LOG`, request ids, and custom sinks.

## Log something

Import [log](api:yerd.log) and call a level; the second argument is structured fields.

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

- Levels: `trace`, `debug`, `info`, `warn`, `error`.
- `(app)` is the target; `log` logs as `app`.
- An `Error` under `error` (or passed straight to `log.error(err)`) is logged with its stack.
- A call below the active level builds nothing.

## A logger per class

`@logger` gives a class its own [Logger](api:yerd.Logger), targeted by the class name, which filters match on.

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

`@logger("billing")` sets your own target. A singleton's logger still logs into whichever request is running.

## Requests are spans

Every request gets a root span with an id that every event logged during it carries, ending with one access line:

```text
12:04:01.239  INFO request{method=GET path=/todos/7} status=200 5.1ms
```

- The access line is `info` for 2xx and 3xx, `warn` for 4xx, `error` for 5xx, at target `yerd::request`.
- The id is sent back as `x-request-id`; a well-formed incoming `x-request-id` is reused.
- An incoming W3C `traceparent` is continued: every record gets its trace id.
- Handlers read the id as `currentContext().requestId`.
- Crashes are logged with their stack; the client only sees "Internal Server Error".

> [!NOTE]
> The request span only exists while `yerd::request` is enabled at `info`. With `YERD_LOG=warn` there's no access line and no `x-request-id` header (`requestId` still works).

## @instrument

[instrument](api:yerd.instrument) wraps a method in a span: arguments as fields, return value and duration on exit, throws logged at `error` and rethrown.

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

When the level is off the method is called directly, and sync methods stay sync.

### Skipping, checked by the compiler

`skip` takes parameter names, positions, and dotted paths into nested objects and arrays. Only the logged copy loses those fields.

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

- Paths are type-checked: `"input.billing.pin"` is a compile error naming the missing field.
- Parameter names themselves are checked when the class loads (a misspelling throws before any request); positional paths (`"0.password"`) are checked fully at compile time.

### Wildcards

A segment can be `*` (any one key or index) or `**` (any number of keys):

```ts
@instrument({ level: "info", skip: ["card.*", "**.cvc", "*.password", "items.*.secret"] })
charge(card: Card, user: User, items: LineItem[]) { ... }
```

| Path | Leaves out |
| --- | --- |
| `card.*` | every field of `card` (it's logged as `{}`) |
| `*.password` | `password` one level inside any argument |
| `**.cvc` | `cvc` anywhere, at any depth |
| `items.*.secret` | `secret` in every item |
| `0.*` | every field of the first argument |

- What comes before the first wildcard is still checked (`"card.nope.*"` errors).
- A wildcard must be a whole segment (`"card.num*"` is refused).

> [!TIP]
> Argument names come from the compiled source, so keep server code unminified (the Vite plugin does). Positional paths don't depend on names.

## Filtering with YERD_LOG

`YERD_LOG` works like Rust's `RUST_LOG`: a default level, then overrides per target or span.

```sh
YERD_LOG=info                          # everything at info and above
YERD_LOG=warn,UserRepo=debug           # quiet, except one class
YERD_LOG=info,yerd=warn                # hush yerd's own logs (targets start with yerd::)
YERD_LOG=info,[stripe]=trace           # everything inside a span named stripe
YERD_LOG=off                           # nothing at all
```

- A target directive covers the target and its children (`yerd` matches `yerd::request`). The most specific match wins; a later directive for the same target replaces an earlier one.
- `[name]=level` sets the level inside spans with that name, whatever the target, louder or quieter. The innermost matching span decides.
- Default: `info`, or `warn` when `NODE_ENV=test`.
- A typo (`UserRepo=chatty`) is a boot error.
- yerd's targets include `yerd::request`, `yerd::lifecycle`, `yerd::boot` and `yerd::stream`.

## app.logging()

`app.logging()` sets the filter, format and redactions in code.

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
| `redact` | `[]` | field paths to mask as `"[redacted]"` in every record ([your own redactions](#your-own-redactions)) |

- `YERD_LOG` and `YERD_LOG_FORMAT` win over these, so a deploy can change them without a rebuild.
- JSON output is one object per line (`t`, `level`, `target`, `msg`, plus `kind`, `fields`, `spans`, `ms`, `error`, `trace` when present).
- Info and below go to stdout in batches; warnings and errors to stderr immediately.

## Custom sinks

Records go to the [ILogger](api:yerd.ILogger) service; register one to replace the [ConsoleLogger](api:yerd.ConsoleLogger).

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
- The sink must be a singleton.

Keep the console too with [teeLogger](api:yerd.teeLogger):

```ts
import { ConsoleLogger, ILogger, teeLogger, yerd } from "@toyz/yerd";

export const app = yerd().services((s) =>
  s.value(ILogger, teeLogger(new ConsoleLogger({ format: "pretty" }), new HttpLogger())),
);
```

`ConsoleLogger` takes `format` and `color` (on for a terminal unless `NO_COLOR` is set).

## Redaction and limits

Every field is sanitized before any sink sees it.

```ts
log.info("login", { user: "ada", password: "hunter2", headers: { authorization: "Bearer x" } });
// fields: { user: "ada", password: "[redacted]", headers: { authorization: "[redacted]" } }
```

- A key is redacted at any depth (`@instrument` arguments included) when one of its words is `password`, `pass`, `secret`, `token`, `auth`, `authorization`, `cookie`, `session`, `credential`, `signature`, `otp`, or `api key` / `private key`. Words split on camelCase, `_`, `-` and `.`; a trailing number is ignored (`password2`).
- Whole words only: `csrfToken`, `x-api-key` and `sessionId` are redacted, `passengers` and `tokenizer` aren't.
- Values are bounded: depth 4, strings 256 characters, arrays 20 items, objects 30 keys. Circular references, binary data and class instances are summarized.

### Your own redactions

List paths for secrets the word list can't guess (card numbers, emails, national ids) in `logging({ redact })`, with the same wildcards as `skip`. They're masked in every record, including span fields, `@instrument` arguments and library logs.

```ts
export const app = yerd().logging({
  redact: ["**.ssn", "**.email", "card.number", "headers.x-forwarded-for"],
});

log.info("signup", { user: { email: "ada@example.com", name: "ada" }, card: { number: "4242", brand: "visa" } });
// fields: { user: { email: "[redacted]", name: "ada" }, card: { number: "[redacted]", brand: "visa" } }
```

- Paths start at the record's fields (a span's fields are its method's arguments by name); `**.` matches a key anywhere.
- Fields are masked, not removed.
- `skip` decides what one method records; `redact` is the app-wide net. A malformed path stops the boot.
