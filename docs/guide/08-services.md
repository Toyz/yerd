# Services

The shop keeps its state in three services: `Catalog`, `Orders` and `Users`, one instance each, handed to every route that asks.

## Your first service

Every request must see the same shelves. Mark the class with [@service](api:yerd.service) and inject it with [@inject](api:yerd.inject), into routes or other services:

```ts
// src/catalog.ts
@service
export class Catalog {
  @inject(Channels) accessor channels!: Channels;
  #products = PRODUCTS.map((p) => ({ ...p }));
  // ...search, get, find

  async take(id: number, qty: number): Promise<void> {
    const product = this.find(id);
    product.stock -= qty;
    await this.channels.publish(stockChannel(id), { id, stock: product.stock });
  }
}

// src/orders.ts
@service
export class Orders {
  @inject(Catalog) accessor catalog!: Catalog;
  // ...place() checks the stock, then this.catalog.take() for each line
}

// src/routes/api.ts
@route("/api/products/:id", { session: false })
export class ProductApi {
  @inject(Catalog) accessor catalog!: Catalog;
  // ...
}
```

One checkout (signed in, a notebook in the cart) takes stock off the shelf every route reads:

```answer
GET /api/products/7
200 OK
content-type: application/json; charset=utf-8

{"id":7,"name":"Field notebook","category":"notebooks","price":2400,"stock":12,"description":"Waterproof paper for notes in the rain."}
---
POST /checkout
_yx=(the form's token)&name=Ada+Lovelace&email=ada%40example.com&address=12+St+James%27s+Square%2C+London
>>>
303 See Other
location: /orders/1001
---
GET /api/products/7
200 OK
content-type: application/json; charset=utf-8

{"id":7,"name":"Field notebook","category":"notebooks","price":2400,"stock":11,"description":"Waterproof paper for notes in the rain."}
```

- Injection is lazy: the field resolves on first read, then follows the service's lifetime. `@inject` needs the `accessor` keyword; a plain field is a type error.
- A `@service` registers when its module is imported. `yerd({ services: [...] })` registers only those.

> [!TAKE]
> Dependencies are fields, not constructor parameters. TC39 decorators can't decorate parameters, so services are made with `new Class()`, and lazy fields let two services use each other. You give up using a dependency in the constructor: do that work in [@onBoot](#lifecycle-boot-timers-shutdown).

## Lifetimes

`@service` defaults to singleton; the three lifetimes come from ASP.NET Core.

| Lifetime | One instance per | Typical use |
| --- | --- | --- |
| `singleton` | app | repositories, caches, clients, config (the shop's three) |
| `scoped` | request | a unit of work, per-request counters, anything holding the current user |
| `transient` | resolution (one per injecting instance) | cheap helpers, id generators |

Set it with an option or a shorthand decorator (stack in any order):

```ts
import { scoped, service, transient } from "@toyz/yerd";

@service({ lifetime: "scoped" })
export class RequestStats {
  queries = 0;
}

@transient
@service
export class IdGen {
  readonly id = crypto.randomUUID();
}
```

Route classes are scoped by default; `@singleton` on a route keeps one instance for the app's life.

## Captive dependencies are boot errors

A singleton can't hold a scoped service, since one request's data would leak into the next; yerd refuses to boot.

```ts
@service
class Cache {
  @inject(RequestStats) accessor stats!: RequestStats; // scoped!
}
```

```text
BootError: yerd refused to start:
  - Cache (singleton) -> RequestStats (scoped): a singleton can't hold a per-request service
```

- Boot lists every problem at once, including an `@inject` nothing provides; [BootError](api:yerd.BootError) has them as `error.problems`.
- Two services may inject each other (fields resolve lazily). A constructor or factory that resolves its own key while being created throws `Circular dependency: A -> B -> A`.
- When a singleton should see the current request's instance, say so with [`@inject.scoped`](#choosing-the-lifetime-where-you-inject).

## Choosing the lifetime where you inject

Say the shop's `Orders` keeps an audit trail per request. It's a singleton, so plain `@inject(AuditLog)` is refused; `@inject.scoped` reads the current request's log on every read instead of holding one:

```ts
@scoped
@service
export class AuditLog {
  readonly lines: string[] = [];
}

@service
export class Orders {
  @inject.scoped(AuditLog) accessor audit!: AuditLog;

  place(id: number) {
    this.audit.lines.push(`order ${id} placed`);
  }
}

@route("/api/orders")
export class OrdersApi {
  @inject(Orders) accessor orders!: Orders;
  @inject(AuditLog) accessor audit!: AuditLog;

  @post place() {
    this.orders.place(1001);
    this.orders.place(1002);
    return this.audit.lines;
  }
}
```

The route and `Orders` share one log per request, and the next request starts a fresh one:

```answer
POST /api/orders
200 OK
content-type: application/json; charset=utf-8

["order 1001 placed","order 1002 placed"]
---
POST /api/orders
200 OK
content-type: application/json; charset=utf-8

["order 1001 placed","order 1002 placed"]
```

| Form | One instance per |
| --- | --- |
| `@inject(Key)` | as registered (the default) |
| [`@inject.scoped(Key)`](api:yerd.Inject) | request, shared by everything in it |
| [`@inject.transient(Key)`](api:yerd.Inject) | read of the field |
| [`@inject.instance(Key)`](api:yerd.Inject) | holder (the instance with the field), kept for its life |

- Only class and factory registrations can be re-scoped. A `s.value()` registration has one object, so using it with a form is a boot error naming the class and field.
- `.scoped` of a singleton is a per-request instance of its own, not the singleton; of a scoped service, the usual one. Read outside a request (an `@every` job, `@onBoot`) it throws; `app.scope()` and event handlers have a scope.
- `.transient` instances made in a request are disposed at its end; outside one they're yours to dispose. Read it into a local when you need the same one twice.
- `.instance` is disposed with its holder: a route's at the end of the request, a singleton's at shutdown.
- `app.services()` overrides still apply: a form changes the lifetime, not the implementation. `@maybe` has no forms.

## Tokens for interfaces and config

A real shop mails its receipts, and `Receipts` shouldn't care through whom. Interfaces don't exist at runtime, so [token](api:yerd.token) makes a key for one and `provides` registers a class under it:

```ts
import { inject, service, token } from "@toyz/yerd";

export interface Mailer {
  send(to: string, body: string): Promise<void>;
}
export const Mailer = token<Mailer>("Mailer");

@service({ provides: Mailer })
export class ConsoleMailer implements Mailer {
  async send(to: string, body: string) {
    console.log(`to ${to}: ${body}`);
  }
}

@service
export class Receipts {
  @inject(Mailer) accessor mailer!: Mailer;
  // ...
}
```

- Naming the token after the interface is legal TypeScript.
- [maybe](api:yerd.maybe)`(Analytics)` instead of `@inject` gives `undefined` when nothing is registered, instead of failing boot.

## Registering in code

Register config objects, third-party classes and things needing constructor arguments with `app.services()`.

```ts
import { resolve, token, yerd } from "@toyz/yerd";

const Config = token<{ databaseUrl: string }>("Config");
const CurrentUser = token<string>("CurrentUser");

export const app = yerd().services((s) =>
  s
    .value(Config, { databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost/shop" })
    .singleton(Pool)
    .scoped(CurrentUser, () => "ada")
    .scoped(Db, (c) => new Db(c.get(Pool), resolve(CurrentUser))),
);
```

| Method | Registers |
| --- | --- |
| `s.value(key, value)` | an existing value, as a singleton |
| `s.singleton(Class)` | a class under its own key |
| `s.singleton(key, Class)` | a class under a token or another class |
| `s.singleton(key, (c) => ...)` | a factory; same for `scoped` and `transient` |

- These override `@service` registrations for the same key, which is how tests swap in fakes (see [testing](12-testing.md)).
- A factory gets the [Container](api:yerd.Container); `c.get(key)` is fine for singletons, but use [resolve](api:yerd.resolve) for scoped dependencies so it sees the current request.

## resolve() in components

Functions that aren't classes get services with [resolve](api:yerd.resolve). The shop's sign-in loads the user from `Users` that way:

```ts
// src/users.ts
export const auth = createAuth<User>({
  load: (id) => resolve(Users).get(id),
  loginPath: "/login",
});
```

It works inside a request, a lifecycle hook, or `app.scope()` (components too), and throws anywhere else.

## Request data in a service

Request accessors (`@session`, `@query`, `@header`, `@auth.user`, your own [createAccessor](03-request-data.md#your-own-accessors)) work on any class, so a scoped service can gather "who's looking" once for layouts and components:

```tsx
@scoped
@service
export class Viewer {
  @session(Cart) accessor cart!: Session<Cart>;
  @auth.maybeUser accessor me: User | undefined;

  get greeting(): string {
    return `${this.me?.name ?? "Guest"}, ${this.cart.count} in the cart`;
  }
}

// in a component or layout:
const viewer = resolve(Viewer);
```

Reading them outside a request (an `@every` job, an `@on` handler, boot) throws, so make such services `@scoped`.

## Disposal

Give a service `[Symbol.dispose]` or `[Symbol.asyncDispose]` and yerd cleans it up, newest first.

```ts
@service({ lifetime: "scoped" })
export class Transaction {
  committed = false;

  async [Symbol.asyncDispose]() {
    if (!this.committed) await this.rollback();
  }
  async rollback() {}
}
```

- Scoped services are disposed at the end of the request, singletons when the app stops, a transient with whatever holds it.
- Factory results are tracked like classes; `value()` registrations are never disposed.

## Lifecycle: boot, timers, shutdown

The demo account needs a hashed password before anyone signs in, and hashing is async. Singleton services can hook into the app's life:

```ts
// src/users.ts
@service
export class Users {
  #users: User[] = [];

  /** Hashing is async, so the demo account is made at boot, before the first request. */
  @onBoot async seed() {
    this.#users.push({ id: "u1", name: DEMO_ACCOUNT.name, passwordHash: await hashPassword(DEMO_ACCOUNT.password) });
  }
  // ...get, byName
}
```

```answer
POST /login?next=/checkout
_yx=(the form's token)&name=ada&password=analytical-engine
>>>
303 See Other
location: /checkout
```

| Decorator | Runs |
| --- | --- |
| [onBoot](api:yerd.onBoot) | at startup, awaited, in registration order, before `listen()` resolves |
| [every](api:yerd.every) | every interval (`"500ms"`, `"5s"`, `"1m"`, `"2h"`, `"1d"` or ms); `{ immediate: true }` also runs it at startup |
| [onShutdown](api:yerd.onShutdown) | at stop, after background work ends, in reverse registration order |

```ts
@every("1m") sweep(signal: AbortSignal) { /* drop expired entries */ }
@onShutdown async flush() { /* runs after requests drain */ }
```

- Hooks on scoped or transient services are a boot error.
- `@every` runs never overlap: the next is scheduled when the previous finishes. A failing run is logged and the timer keeps going.
- The method gets an `AbortSignal` that fires at shutdown; pass it to `fetch` and friends.

## Hosted services

[hosted](api:yerd.hosted) is for long-running background work (a queue consumer, a websocket client): a singleton whose `run(signal)` starts after boot.

```ts
import { hosted, inject, type HostedService } from "@toyz/yerd";

@hosted
export class QueueWorker implements HostedService {
  @inject(Mailer) accessor mailer!: Mailer;

  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, 1000)); // poll, process, repeat
    }
  }
}
```

- Return when `signal` aborts. Shutdown waits up to `shutdownTimeout` (10 s) for hosted services and timers.
- `app.start()` runs all of this without an HTTP server, for worker processes; `app.stop()` shuts it down.

## Events and calls

To set off background work when something happens, emit an event that singleton services handle with `@on`, as the shop's `Receipts` does for each order; to get an answer from another service, make a call that one `@handles` method answers. See the [events guide](14-events.md).

## Scripts: app.scope()

`app.scope()` boots the container and runs a function in a fresh scope, so even scoped services resolve; use it for seeds, migrations and CLI commands.

```ts
// scripts/low-stock.ts
import { resolve } from "@toyz/yerd";
import { createApp } from "../src/app.js";
import { Catalog } from "../src/catalog.js";

const app = createApp();
await app.scope(() => {
  for (const p of resolve(Catalog).search()) if (p.stock < 5) console.log(`${p.name}: ${p.stock} left`);
});
await app.stop(); // dispose singletons
```

- The scope is disposed when the function returns.
- It doesn't start the app: no `@onBoot` hooks or timers until you call `app.start()`. `@on` handlers still hear events emitted in it (see [events](14-events.md)).
- Call `app.stop()` at the end, which also waits for running handlers.
