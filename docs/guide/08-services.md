# Services

This page covers dependency injection: declaring services, wiring them together, and running code at startup, on a timer and at shutdown.

## Your first service

Mark a class with `@service` and inject it anywhere with `@inject`. Routes, services and guards can all inject.

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

- Services are created with `new Class()`, so they take no constructor arguments. Dependencies come in through `@inject accessor` fields instead (TC39 decorators can't decorate constructor parameters).
- Injection is lazy: the field resolves on first read, then follows the service's lifetime.
- Every `@service` class is registered automatically once its module is imported. Pass `yerd({ services: [...] })` to register only some.

> [!NOTE]
> `@inject` needs the `accessor` keyword. A plain field (`@inject(Clock) clock!: Clock`) is a type error.

## Lifetimes

There are three lifetimes, borrowed from ASP.NET Core. [service](api:yerd.service) defaults to singleton.

| Lifetime | One instance per | Typical use |
| --- | --- | --- |
| `singleton` | app | repositories, caches, clients, config |
| `scoped` | request | a unit of work, per-request counters, anything holding the current user |
| `transient` | resolution (one per injecting instance) | cheap helpers, id generators |

Set it with an option or a shorthand decorator. Stack the shorthands in any order.

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

Route classes have a lifetime too: scoped by default (a fresh instance per request). Put `@singleton` on a route to keep one instance for the life of the app.

## Captive dependencies are boot errors

A singleton outlives every request, so it can't hold a scoped service. yerd checks this at boot and refuses to start rather than letting one request's data leak into the next.

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

Boot also reports an `@inject` that nothing provides, along with every other problem it finds, all in one list. [BootError](api:yerd.BootError) has them as `error.problems`.

Two services may inject each other: `@inject` fields resolve lazily, so the cycle is never followed. A constructor or factory that resolves its own key while it's being created (directly, or through others) throws `Circular dependency: A -> B -> A` instead.

## Tokens for interfaces and config

Interfaces don't exist at runtime, so they need a key. [token](api:yerd.token) makes one, and `provides` registers a class under it.

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

Naming the token after the interface (`const Mailer = token<Mailer>(...)`) is legal TypeScript and reads nicely at the injection site. [maybe](api:yerd.maybe) is `@inject` that gives `undefined` when nothing is registered, instead of failing boot.

## Registering in code

Some things can't wear a decorator: config objects, third-party classes, things that need constructor arguments. Register those with `app.services()`.

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

- Registrations here override `@service` ones for the same key. That's how you swap in fakes for tests (see [12-testing.md](12-testing.md)).
- A factory gets the [Container](api:yerd.Container); `c.get(key)` is fine for singletons. For a scoped dependency, call [resolve](api:yerd.resolve) inside the factory instead, which sees the current request.

## resolve() in components

Function components and plain functions can't use decorators. [resolve](api:yerd.resolve) gets a service from the current request instead.

```tsx
import { resolve } from "@toyz/yerd";

export function TodoCount() {
  const repo = resolve(TodoRepo);
  return <span class="count">{repo.list().length} todos</span>;
}
```

It works inside a request, a lifecycle hook, or `app.scope()`. Anywhere else it throws, saying so.

## Request data in a service

Request accessors (`@session`, `@query`, `@header`, `@auth.user` and your own from [createAccessor](03-request-data.md#your-own-accessors)) aren't only for routes. They read the current request whatever class they're on, so a scoped service can gather "who's looking" once, and layouts and components ask it instead of each reading the session their own way:

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

Reading one of these outside a request (in an `@every` job, an `@on` handler, at boot) throws, the same as `currentContext()`. Make such services `@scoped`: nothing about them outlives the request.

## Disposal

Give a service `[Symbol.dispose]` or `[Symbol.asyncDispose]` and yerd cleans it up for you, newest first.

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

- Scoped services are disposed when the request ends; singletons when the app stops.
- A transient lives as long as whatever holds it: inside a singleton it goes at shutdown, inside a request at the end of the request.
- Factory results are tracked like classes. `value()` registrations are yours: yerd never disposes them.

## Lifecycle: boot, timers, shutdown

Singleton services can hook into the app's life. Hooks on scoped or transient services are a boot error.

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

`@every` runs never overlap: the next run is scheduled when the previous one finishes. The method gets an `AbortSignal` that fires at shutdown, so pass it along to `fetch` and friends. A failing run is logged and the timer keeps going.

## Hosted services

For long-running background work (a queue consumer, a websocket client), use [hosted](api:yerd.hosted). It's a singleton whose `run(signal)` starts after boot.

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

Return (or resolve) when `signal` aborts. Shutdown waits up to `shutdownTimeout` (default 10 s) for hosted services and timers, then carries on without them.

> [!TIP]
> `app.start()` runs hooks, timers and hosted services without an HTTP server, for worker processes. `app.stop()` shuts them down.

## Events and calls

When one thing happening should set off others (an order placed: send the receipt, take the stock, tell the dashboard), emit an event and let singleton services react with `@on`, in the background, after the request has succeeded. When you need an answer from another service, make it a call that one `@handles` method answers.

```ts
import { Events, inject, named, on, service } from "@toyz/yerd";

@named("signup.completed")
export class SignupCompleted {
  constructor(readonly email: string) {}
}

@service
export class Welcome {
  @on(SignupCompleted, { retries: 2 }) async send(event: SignupCompleted) {
    console.log(`welcome mail to ${event.email}`);
  }
}

@service
export class Signups {
  @inject(Events) accessor events!: Events;

  complete(email: string) {
    // In a request: sent once the handler has returned without throwing.
    this.events.emit(new SignupCompleted(email));
  }
}
```

The [events guide](14-events.md) covers it all: when events go out, retries, calls, scripts, transports for several instances, and testing.

## Scripts: app.scope()

Seeding a database, a one-off migration, a CLI command: `app.scope()` boots the container and runs your function inside a fresh scope, so even scoped services resolve.

```ts
import { resolve } from "@toyz/yerd";
import { app } from "./app.js";

await app.scope(async () => {
  const repo = resolve(TodoRepo);
  repo.add("from a script");
});
await app.stop(); // dispose singletons
```

The scope is disposed when the function returns. `app.scope()` doesn't start the app: no `@onBoot` hooks, no timers, and no `@on` handlers listening for events. Call `app.start()` first if your script needs any of them, and `app.stop()` at the end either way.
