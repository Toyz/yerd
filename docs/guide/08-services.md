# Services

Dependency injection: declaring services, wiring them together, and running code at startup, on a timer and at shutdown.

## Your first service

Mark a class with `@service` and inject it into routes, services or guards with `@inject`.

```tsx
import { get, inject, route, service } from "@toyz/yerd";

@service
export class Clock {
  now() {
    return new Date();
  }
}

@service
export class TodoRepo {
  @inject(Clock) accessor clock!: Clock;
  #todos: { title: string; at: Date }[] = [];

  add(title: string) {
    this.#todos.push({ title, at: this.clock.now() });
  }
  list() {
    return this.#todos;
  }
}

@route("/todos")
export class Todos {
  @inject(TodoRepo) accessor repo!: TodoRepo;

  @get list() {
    return this.repo.list();
  }
}
```

- Services are created with `new Class()`, so no constructor arguments; dependencies come through `@inject accessor` fields (TC39 has no parameter decorators).
- `@inject` needs the `accessor` keyword; a plain field is a type error.
- Injection is lazy: the field resolves on first read, then follows the service's lifetime.
- A `@service` registers when its module is imported. `yerd({ services: [...] })` registers only those.

## Lifetimes

[service](api:yerd.service) defaults to singleton; the three lifetimes come from ASP.NET Core.

| Lifetime | One instance per | Typical use |
| --- | --- | --- |
| `singleton` | app | repositories, caches, clients, config |
| `scoped` | request | a unit of work, per-request counters, anything holding the current user |
| `transient` | resolution (one per injecting instance) | cheap helpers, id generators |

Set it with an option or a shorthand decorator (stack in any order):

```ts
import { scoped, service, transient } from "@toyz/yerd";

@service({ lifetime: "scoped" })
export class RequestStats {
  queries = 0;
}

@scoped
@service
export class UnitOfWork {}

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
import { inject, service } from "@toyz/yerd";
import { RequestStats } from "./stats.js"; // the scoped service above

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

## Tokens for interfaces and config

Interfaces don't exist at runtime, so [token](api:yerd.token) makes a key for one and `provides` registers a class under it.

```ts
import { inject, maybe, service, token } from "@toyz/yerd";

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

export const Analytics = token<{ track(event: string): void }>("Analytics");

@service
export class Signup {
  @inject(Mailer) accessor mailer!: Mailer;
  @maybe(Analytics) accessor analytics: { track(event: string): void } | undefined;

  async run(email: string) {
    await this.mailer.send(email, "Welcome!");
    this.analytics?.track("signup");
  }
}
```

- Naming the token after the interface is legal TypeScript.
- [maybe](api:yerd.maybe) gives `undefined` when nothing is registered, instead of failing boot.

## Registering in code

Register config objects, third-party classes and things needing constructor arguments with `app.services()`.

```ts
import { resolve, token, yerd } from "@toyz/yerd";

interface Config {
  databaseUrl: string;
}
const Config = token<Config>("Config");
const CurrentUser = token<string>("CurrentUser");

class Pool {
  async [Symbol.asyncDispose]() {} // close connections
}
class Db {
  constructor(readonly pool: Pool, readonly user: string) {}
}

export const app = yerd().services((s) =>
  s
    .value(Config, { databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost/app" })
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

Function components and plain functions get services with [resolve](api:yerd.resolve).

```tsx
import { resolve } from "@toyz/yerd";

export function TodoCount() {
  const repo = resolve(TodoRepo);
  return <span class="count">{repo.list().length} todos</span>;
}
```

It works inside a request, a lifecycle hook, or `app.scope()`, and throws anywhere else.

## Request data in a service

Request accessors (`@session`, `@query`, `@header`, `@auth.user`, your own [createAccessor](03-request-data.md#your-own-accessors)) work on any class, so a scoped service can gather "who's looking" once for layouts and components:

```tsx
import { resolve, scoped, service, session, type LayoutProps, type Session } from "@toyz/yerd";

interface Prefs {
  theme?: "light" | "dark";
  cart?: string[];
}

@scoped
@service
export class Viewer {
  @session accessor session!: Session<Prefs>;

  get theme(): "light" | "dark" {
    return this.session.theme ?? "light";
  }

  get cartCount(): number {
    return this.session.cart?.length ?? 0;
  }
}

export function ShopLayout({ children }: LayoutProps) {
  const viewer = resolve(Viewer);
  return (
    <div class={`theme-${viewer.theme}`}>
      <header>Cart ({viewer.cartCount})</header>
      {children}
    </div>
  );
}
```

Reading them outside a request (an `@every` job, an `@on` handler, boot) throws, so make such services `@scoped`.

## Disposal

Give a service `[Symbol.dispose]` or `[Symbol.asyncDispose]` and yerd cleans it up, newest first.

```ts
import { service } from "@toyz/yerd";

@service({ lifetime: "scoped" })
export class Transaction {
  committed = false;

  async [Symbol.asyncDispose]() {
    if (!this.committed) await this.rollback();
  }
  async rollback() {}
}
```

- Scoped services are disposed at the end of the request; singletons when the app stops.
- A transient lives as long as whatever holds it.
- Factory results are tracked like classes; `value()` registrations are never disposed.

## Lifecycle: boot, timers, shutdown

Singleton services can hook into the app's life (hooks on other lifetimes are a boot error).

```ts
import { every, onBoot, onShutdown, service } from "@toyz/yerd";

@service
export class Cache {
  #entries = new Map<string, { value: string; expires: number }>();

  @onBoot async warm() {
    // runs before the server accepts requests
  }

  @every("1m") sweep() {
    const now = Date.now();
    for (const [key, entry] of this.#entries) if (entry.expires < now) this.#entries.delete(key);
  }

  @onShutdown async flush() {
    // runs after requests drain
  }
}
```

| Decorator | Runs |
| --- | --- |
| [onBoot](api:yerd.onBoot) | at startup, awaited, in registration order, before `listen()` resolves |
| [every](api:yerd.every) | every interval (`"500ms"`, `"5s"`, `"1m"`, `"2h"`, `"1d"` or ms); `{ immediate: true }` also runs it at startup |
| [onShutdown](api:yerd.onShutdown) | at stop, after background work ends, in reverse registration order |

- `@every` runs never overlap: the next is scheduled when the previous finishes.
- The method gets an `AbortSignal` that fires at shutdown; pass it to `fetch` and friends.
- A failing run is logged and the timer keeps going.

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
- `app.start()` runs hooks, timers and hosted services without an HTTP server, for worker processes; `app.stop()` shuts them down.

## Events and calls

To set off background work when something happens, emit an event that singleton services handle with `@on`; to get an answer from another service, make a call that one `@handles` method answers. See the [events guide](14-events.md).

## Scripts: app.scope()

`app.scope()` boots the container and runs a function in a fresh scope, so even scoped services resolve; use it for seeds, migrations and CLI commands.

```ts
import { resolve } from "@toyz/yerd";
import { app } from "./app.js";

await app.scope(async () => {
  const repo = resolve(TodoRepo);
  repo.add("from a script");
});
await app.stop(); // dispose singletons
```

- The scope is disposed when the function returns.
- It doesn't start the app: no `@onBoot` hooks or timers until you call `app.start()`. `@on` handlers still hear events emitted in it (see [events](14-events.md)).
- Call `app.stop()` at the end, which also waits for running handlers.
