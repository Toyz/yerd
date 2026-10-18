# Logging

The shop logs every request and every receipt. Here we read those lines, time the checkout, and keep the customer's address out.

## A logger per class

`Receipts` mails a receipt by logging it. [@logger](api:yerd.logger) gives a class its own [Logger](api:yerd.Logger), targeted by the class name:

```ts
// src/receipts.ts
import { logger, on, service, type Logger } from "@toyz/yerd";

@service
export class Receipts {
  @logger accessor log!: Logger; // target "Receipts"

  @on(OrderPlaced) send(event: OrderPlaced) {
    this.log.info("receipt sent", { order: event.orderId, to: event.email, total: formatPrice(event.total) });
  }
}
```

After a checkout, in the terminal running `npm run shop`:

```text
14:44:48.666  INFO receipt sent order=1001 to=ada@example.com total=$24.00 (Receipts)
```

- Levels: `trace`, `debug`, `info`, `warn`, `error`. A call below the active level builds nothing.
- The second argument is fields. An `Error` under `error` (or `log.error(err)`) is logged with its stack.
- Outside a class, import [log](api:yerd.log): `log.info("server starting", { port: 3000 })` logs as target `app`.
- `@logger("mail")` sets your own target. A singleton's logger still logs into whichever request is running.

| Method | Does |
| --- | --- |
| `trace/debug/info/warn/error(message, fields?)` | write an event |
| `child(fields)` | a logger that adds these fields to every record |
| `for(target)` | the same logger under another target |
| `span(name, fields, fn, level = "info")` | run `fn` inside a span: enter and exit records, duration, nesting across `await` |
| `enabled(level)` | whether `level` would be written, to skip building expensive fields |

## Requests are spans

Every request is a span, and ends with one access line. A product page, adding it to the cart, a wrong id, a checkout:

```text
14:44:48.632  INFO request{method=GET path=/products/7} status=200 4.69ms
14:44:48.637  INFO request{method=POST path=/products/7} status=200 3.01ms
14:44:48.638  WARN request{method=GET path=/products/99} status=404 1.25ms
14:44:48.667  INFO request{method=POST path=/checkout} status=200 2.07ms
```

The span's id goes back to the client, and a well-formed one sent in is reused:

```answer
GET /api/products/7
200 OK
content-type: application/json; charset=utf-8
x-request-id: 34346f8637642f41

{"id":7,"name":"Field notebook","category":"notebooks","price":2400,"stock":12,"description":"Waterproof paper for notes in the rain."}
```

- The access line is `info` for 2xx and 3xx, `warn` for 4xx, `error` for 5xx, at target `yerd::request`.
- Every event logged during the request carries its id; handlers read it as `currentContext().requestId`.
- An incoming W3C `traceparent` is continued: every record gets its trace id.
- Crashes are logged with their stack; the client only sees "Internal Server Error".

> [!NOTE]
> The request span exists only while `yerd::request` is on at `info`. With `YERD_LOG=warn` there's no access line and no `x-request-id` (`requestId` still works).

## @instrument

Placing an order is the step worth timing. [@instrument](api:yerd.instrument) wraps a method in a span: arguments as fields, the return value and duration on exit, a throw logged at `error` and rethrown.

```ts
// src/orders.ts
import { instrument /* , ... */ } from "@toyz/yerd";

@service
export class Orders {
  @instrument({ level: "info" })
  async place(user: User, details: CheckoutForm, cart: CartLine[]): Promise<Order> {
    // ...unchanged
  }
}
```

```text
14:44:48.666  INFO   Orders::place{user={"id":"u1","name":"ada","passwordHash":"[redacted]"} details={"CheckoutForm":{"name":"Ada Lovelace","email":"ada@example.com","address":"12 St James's Square, London"}} cart=[{"id":7,"qty":1}]}
14:44:48.666  INFO   Orders::place ret={"id":1001,"userId":"u1",...,"total":2400,"placedAt":"2026-10-18T20:44:48.666Z"} 0.34ms
14:44:48.666  INFO receipt sent order=1001 to=ada@example.com total=$24.00 (Receipts)
14:44:48.667  INFO request{method=POST path=/checkout} status=200 2.07ms
```

- `passwordHash` was redacted on its own; the email and address weren't ([redaction](#redaction-and-limits) fixes that).
- The receipt has no request id: event handlers run after the response.
- When the level is off, the method is called directly, and sync methods stay sync.

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `"Class::method"` | span name |
| `level` | `"debug"` | level of the span's records |
| `target` | the class name | target, for filtering |
| `skip` | `[]` | arguments or nested fields to leave out (below) |
| `skipAll` | `false` | record no arguments |
| `fields` | none | `(self, args) => ({ ... })`, extra or derived fields |
| `ret` | `true` | record the return value on exit |
| `err` | `true` | log a throw at `error` (it's always rethrown) |

### Skipping, checked by the compiler

`skip` takes parameter names, positions and dotted paths into nested objects and arrays. Only the logged copy loses them.

```ts
interface Signup {
  email: string;
  password: string;
  billing: { card: string; cvc: string };
}

export class Accounts {
  @instrument({ skip: ["input.billing.cvc", "1.headers.authorization", "items.*.secret", "**.ssn"] })
  create(input: Signup, request: { headers: { authorization: string } }, items: Array<{ secret: string }>) {
    return input.email;
  }
}
```

| Path | Leaves out |
| --- | --- |
| `input.billing.cvc` | one nested field. `"input.billing.pin"` is a compile error naming the missing field |
| `1.headers.authorization` | by position: the second argument's field |
| `card.*` | every field of `card` (it's logged as `{}`) |
| `items.*.secret` | `secret` in every item |
| `*.password` | `password` one level inside any argument |
| `**.ssn` | `ssn` anywhere, at any depth |

- A misspelled parameter name throws when the class loads; positional paths are checked fully at compile time.
- What comes before the first wildcard is still checked (`"card.nope.*"` errors). A wildcard is a whole segment (`"card.num*"` is refused).
- Names come from the compiled source, so keep server code unminified (the Vite plugin does).

## Filtering with YERD_LOG

To see only receipts, quiet the rest. `YERD_LOG`, or `filter` in code, works like Rust's `RUST_LOG`: a default level, then overrides per target or span.

```ts
// src/app.ts
return yerd(options)
  .logging({ filter: "warn,Receipts=info" })
  // ...layout, errorPage, sessions, auth
```

The same session now writes one line:

```text
14:45:28.159  INFO receipt sent order=1001 to=ada@example.com total=$24.00 (Receipts)
```

```sh
YERD_LOG=info                    # everything at info and above
YERD_LOG=warn,Orders=info        # quiet, except one class
YERD_LOG=info,yerd=warn          # hush yerd's own logs (targets start with yerd::)
YERD_LOG=info,[stripe]=trace     # everything inside a span named stripe
YERD_LOG=off                     # nothing at all
```

- A target covers its children (`yerd` matches `yerd::request`). The most specific match wins; a later directive for the same target replaces an earlier one.
- `[name]=level` sets the level inside spans with that name, whatever the target. The innermost matching span decides.
- Default: `info`, or `warn` when `NODE_ENV=test`. A typo (`Orders=chatty`) is a boot error.
- yerd's targets include `yerd::request`, `yerd::lifecycle`, `yerd::boot` and `yerd::stream`.

## app.logging()

`app.logging()` sets the filter, format and redactions. In production the console writes JSON, a record per line; the `Orders::place` enter record, spread out:

```json
{
  "t": "2026-10-18T20:44:48.666Z", "level": "info", "target": "Orders", "msg": "Orders::place", "kind": "span-enter",
  "spans": [
    { "name": "request", "id": "350a7ce21ab0c5db", "fields": { "method": "POST", "path": "/checkout" } },
    { "name": "Orders::place", "id": "d6df599cabc1be23", "fields": {
      "user": { "id": "u1", "name": "ada", "passwordHash": "[redacted]" },
      "details": { "CheckoutForm": { "name": "Ada Lovelace", "email": "ada@example.com", "address": "12 St James's Square, London" } },
      "cart": [{ "id": 7, "qty": 1 }]
    } }
  ],
  "trace": "4da42990240c961483e5e709d1a87457"
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `filter` | `YERD_LOG`, else `info` (`warn` under tests) | directives, as above |
| `format` | `YERD_LOG_FORMAT`, else `pretty` on a terminal outside production, `json` otherwise | console output format |
| `redact` | `[]` | field paths to mask as `"[redacted]"` in every record ([below](#your-own-redactions)) |

- `YERD_LOG` and `YERD_LOG_FORMAT` win over these, so a deploy can change them without a rebuild.
- JSON keys: `t`, `level`, `target`, `msg`, plus `kind`, `fields`, `spans`, `ms`, `error` and `trace` when present.
- Info and below go to stdout in batches; warnings and errors to stderr at once.

## Redaction and limits

Every field is sanitized before any sink sees it: that's why `passwordHash` came out as `[redacted]`.

- A key is redacted at any depth when one of its words is `password`, `pass`, `secret`, `token`, `auth`, `authorization`, `cookie`, `session`, `credential`, `signature`, `otp`, or `api key` / `private key`.
- Words split on camelCase, `_`, `-` and `.`; a trailing number is ignored (`password2`). Whole words only: `csrfToken` and `sessionId` are redacted, `passengers` and `tokenizer` aren't.
- Values are bounded: depth 4, strings 256 characters, arrays 20 items, objects 30 keys. Circular references, binary data and class instances are summarized.

> [!TAKE]
> Secret-looking keys are masked by default, everywhere, with no opt-in. A log line is copied to more places than any database row. You give up seeing a harmless field named `token`; rename it.

### Your own redactions

The word list can't guess that an email or a street address is personal. List paths in `logging({ redact })`, with the same wildcards as `skip`:

```ts
// src/app.ts
.logging({ redact: ["**.email", "**.address", "to"] })
```

```text
14:45:27.510  INFO   Orders::place{user={"id":"u1","name":"ada","passwordHash":"[redacted]"} details={"CheckoutForm":{"name":"Ada Lovelace","email":"[redacted]","address":"[redacted]"}} cart=[{"id":7,"qty":1}]}
14:45:27.511  INFO receipt sent order=1001 to=[redacted] total=$24.00 (Receipts)
```

- Paths start at the record's fields: a span's arguments by name, its `ret` on exit (masked here too). `**.` matches a key anywhere.
- Paths match keys, not values: `to` holds an email too, so it's listed by name.
- Fields are masked, not removed. A malformed path stops the boot.
- `skip` decides what one method records; `redact` is the app-wide net, library logs included.

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
- `flush()` is optional and runs when the app stops. The sink must be a singleton.
- Keep the console too with [teeLogger](api:yerd.teeLogger): `s.value(ILogger, teeLogger(new ConsoleLogger({ format: "pretty" }), new HttpLogger()))`. `ConsoleLogger` takes `format` and `color` (on for a terminal unless `NO_COLOR` is set).
