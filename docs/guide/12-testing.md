# Testing

This page covers testing yerd apps with vitest: requests through the whole app with no server, sessions and action forms, events, fake services, and unit tests for services, guards and DTOs.

## Set up vitest

Vitest runs on Vite, and Vite's transformer can't lower TC39 decorators. Add yerd's decorator plugin and you're done.

```sh
npm install -D vitest vite esbuild
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { yerdDecorators } from "@toyz/yerd/vite";

export default defineConfig({
  plugins: [yerdDecorators()],
});
```

Use [yerdDecorators](api:vite.yerdDecorators), not the full `yerd()` plugin: tests don't need the dev server or the build.

## No server at all: app.request()

Most tests don't need a port. [app.request()](api:yerd.YerdApp/request) sends a request through the whole pipeline (middleware, sessions, guards, actions, error pages, streaming) in the same process and gives you a fetch `Response`. Nothing listens, so there's no port to pick and nothing to close but the app.

```ts
import { afterAll, expect, it } from "vitest";
import { yerd } from "@toyz/yerd";
import { Todos } from "../src/routes/todos.js";

const app = yerd({ routes: [Todos], services: [], handleSignals: false });
afterAll(() => app.stop());

it("adds a todo", async () => {
  const res = await app.request("/todos", {
    method: "POST",
    body: JSON.stringify({ title: "milk" }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  expect(await (await app.request("/todos")).json()).toEqual({ todos: ["milk"] });
});
```

- Paths resolve against `http://localhost`; pass a full URL for another host, or `https://...` to test what happens over TLS (`__Host-` cookies, `Secure`).
- The response resolves as soon as its headers are written, so an SSE or NDJSON stream can be read as it arrives. Cancelling the body (`reader.cancel()`) is the client hanging up: the route's signal fires and its stream's `finally` runs.
- The first request starts the app (`@onBoot`, `@every`, hosted services), so `app.stop()` it after the tests.
- [app.fetch(request)](api:yerd.YerdApp/fetch) is the same for a `Request` you built yourself. It's also the handler for runtimes that speak fetch.

### A client that keeps cookies

[app.client()](api:yerd.YerdApp/client) is a small browser for tests. It remembers cookies between requests, so sessions and sign-in carry over. It sends a same-origin `Origin` on writes, like a form post would, so actions pass the cross-site check. And it can submit the action forms a page rendered:

```ts
const client = app.client();
await client.action("/login", { name: "ada", password: "hunter22" }); // the page's form, its token, your fields
expect(await client.page("/account")).toContain("Signed in as ada");

await client.request("/logout", { method: "POST" });
expect(client.cookies.has("yerd_session")).toBe(false);
```

`client.action(page, fields, { index, to, script })` fetches `page`, takes its first action token (or the `index`-th, counting forms and element actions), and posts it with your fields. By default it posts the way the runtime does (`yx` header: no redirects, JSON errors); `script: false` posts like a plain browser form.

## A real server

When the test is about the network itself (keep-alive, a proxy, a real browser with Playwright), start the app on a free port, hit it with `fetch`, close it afterwards.

```ts
import { afterAll, beforeAll, expect, it } from "vitest";
import { yerd, type RunningServer } from "@toyz/yerd";
import { Hello } from "../src/routes/hello.js";

let server: RunningServer;
beforeAll(async () => {
  server = await yerd({ routes: [Hello], services: [], handleSignals: false }).listen(0, "127.0.0.1");
});
afterAll(() => server.close());

it("says hello", async () => {
  const res = await fetch(server.url + "/hello");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ hello: "world" });
});
```

- `listen(0, "127.0.0.1")` picks a free port; `server.url` has it.
- `handleSignals: false` leaves Ctrl-C to vitest instead of the app.
- `routes` and `services` limit the app to the classes you list. Without them, the app picks up every decorated class the test file imported, which gets confusing fast.
- `server.close()` runs the full shutdown: `@onShutdown` hooks, disposal, the lot.

## Boot checks are tests too

Captive dependencies, unknown guards and missing services fail at boot. One cheap test catches them all before you deploy.

```ts
import { it } from "vitest";
import { app } from "../src/app.js";

it("boots", async () => {
  await app.boot(); // throws a BootError listing every problem
});
```

## Sessions and action forms

Action tokens are bound to the session they were rendered for, so a test fetches the page and posts its form with the same cookies. That's what `client.action()` does:

```ts
import { afterAll, expect, it } from "vitest";
import { yerd } from "@toyz/yerd";
import { SignupPage } from "../src/routes/signup.js";

const app = yerd({ routes: [SignupPage], services: [], handleSignals: false }).sessions();
afterAll(() => app.stop());

it("signs up", async () => {
  const client = app.client();
  const res = await client.action("/signup", { name: "ada", email: "ada@example.com", age: "36" });
  expect(res.headers.get("yx-location")).toBe("/welcome");
});

it("says what's wrong, by field", async () => {
  const res = await app.client().action("/signup", { name: "a", email: "nope", age: "7" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ issues: [{ path: "name" }, { path: "email" }, { path: "age" }] });
});

it("works without JavaScript too", async () => {
  const client = app.client();
  const res = await client.action("/signup", { name: "a", email: "nope", age: "7" }, { script: false });
  expect(res.status).toBe(303); // back to the form
  expect(await client.page("/signup")).toContain("Must be 2 to 40 characters");
});
```

What a posted action answers depends on how it was posted:

| | Like the runtime (default) | `script: false`, like a plain form |
| --- | --- | --- |
| returns nothing | 204 | 303 back to the page |
| returns JSX | 200, the JSX without layouts | 303 back to the page |
| returns `redirect(url)` | 200 with a `yx-location` header | 303 to `url` |
| throws a validation error | 400, JSON `{ error, issues }` | your error page (or the flash-and-redirect you wrote) |

> [!TIP]
> A token rendered for one client and posted by another is a 403. That's the session binding working, and it's worth a test of its own: take a token from `a.page("/signup")` and post it with `b.request(...)`.

To test pages behind `auth.required`, sign in once with `client.action("/login", {...})` and keep using the same client: its session cookie now carries the user.

### Actions on other elements, and browser values

`client.action()` counts every action on the page, forms and other elements alike, in page order; pick one with `index`. Values an action lambda reads from the page (`el.value`, `ref("#x").checked`, `drag.data("id")`) travel as `_yxh0`, `_yxh1`, ... in the order the lambda first read them, so pass them as fields:

```ts
it("searches as you type", async () => {
  const res = await app.client().action("/people", { _yxh0: "ada" }); // the search input's el.value
  expect(await res.text()).toContain("Ada Lovelace");
});
```

Without the `_yxh` fields the action answers 400: it needs values only a browser running the runtime can send.

## Testing events

Events go out once the app has started, and the first request starts it. Wait for one with `waitFor`, created before the request that emits it:

```ts
import { Events } from "@toyz/yerd";
import { OrderPlaced } from "../src/events.js";

it("announces the order", async () => {
  await app.start(); // the container exists, and @on handlers are listening
  const placed = app.container.get(Events).waitFor(OrderPlaced, { timeout: "2s" });
  await app.client().action("/checkout");
  expect((await placed).totalCents).toBeGreaterThan(0);
});
```

More in the [events guide](14-events.md#testing-events).

## Faking services

`app.services()` registrations override `@service` ones for the same key. Swap in fakes per test app.

```ts
import { yerd } from "@toyz/yerd";
import { Mailer, SmtpMailer } from "../src/mail.js";
import { Signup } from "../src/routes/signup.js";

const sent: string[] = [];
const fakeMailer: Mailer = {
  async send(to) {
    sent.push(to);
  },
};

const app = yerd({ routes: [Signup], services: [SmtpMailer], handleSignals: false })
  .sessions()
  .services((s) => s.value(Mailer, fakeMailer));
```

This works for tokens and classes alike: `s.value(TodoRepo, new InMemoryTodoRepo())` replaces a class-keyed service, as long as the fake has the same shape.

## Testing services directly

`app.scope()` boots the container and runs your function in a fresh request scope, so you can `resolve()` anything, scoped services included. No HTTP needed.

```ts
import { expect, it } from "vitest";
import { resolve, yerd } from "@toyz/yerd";

it("keeps one basket per scope", async () => {
  const app = yerd({ routes: [], services: [Basket], handleSignals: false });
  const items = await app.scope(() => {
    resolve(Basket).items.push("socks");
    return resolve(Basket).items;
  });
  expect(items).toEqual(["socks"]);
  await app.stop();
});
```

`app.scope()` doesn't run `@onBoot` hooks. Call `await app.start()` first if the service needs them, and `app.stop()` at the end either way, so singletons are disposed.

## Capturing logs

Register an [ILogger](api:yerd.ILogger) that pushes records into an array. Under vitest `NODE_ENV` is `test`, which makes the default level `warn`, so set the filter you want to see.

```ts
import { expect, it } from "vitest";
import { ILogger, yerd, type LogRecord } from "@toyz/yerd";

const records: LogRecord[] = [];

const app = yerd({ routes: [Hello], services: [], handleSignals: false })
  .services((s) => s.value(ILogger, { write: (r) => records.push(r) }))
  .logging({ filter: "info" });

it("logs an access line", async () => {
  const res = await app.request("/hello");
  await new Promise((r) => setTimeout(r, 5)); // the access line is written after the response
  const access = records.find((r) => r.target === "yerd::request" && r.kind === "span-exit");
  expect(access?.fields).toEqual({ status: 200 });
  expect(res.headers.get("x-request-id")).toBe(access?.spans[0]?.id);
});
```

See [10-logging.md](10-logging.md) for what's in a [LogRecord](api:yerd.LogRecord).

## Guards and DTOs, no server

A guard made with `createGuard` keeps its function as `.run`. Call it with a stand-in context holding just what the guard reads.

```ts
import { expect, it } from "vitest";
import { Forbidden, createGuard, type YerdContext } from "@toyz/yerd";

const weekdays = createGuard("weekdays", (ctx) => {
  const day = new Date(ctx.headers.date ?? Date.now()).getDay();
  return (day !== 0 && day !== 6) || new Forbidden("Closed on weekends");
});

it("closes on weekends", async () => {
  const saturday = { headers: { date: "Sat, 17 Oct 2026 12:00:00 GMT" } } as unknown as YerdContext;
  const result = await weekdays.run(saturday);
  expect(result).toBeInstanceOf(Forbidden);
});
```

A named `@guard` method is just a method on a service: `app.scope(() => resolve(Flags).beta(ctx))`.

DTO classes are checked with [parse](api:yerd.parse), the same function `form.parse()` and `@body` use. It returns the typed object or throws a `ValidationFailed` (a 400) with the `issues`.

```ts
import { expect, it } from "vitest";
import { ValidationFailed, parse } from "@toyz/yerd";

it("validates signups", () => {
  expect(parse(SignupForm, { name: "ada", password: "correct horse" })).toEqual({ name: "ada", password: "correct horse" });

  try {
    parse(SignupForm, { name: "a", password: "x" });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationFailed);
    expect((error as ValidationFailed).issues).toMatchObject([{ path: "name" }, { path: "password" }]);
  }
});
```

> [!NOTE]
> Decorator registries are per module graph, and vitest gives each test file its own. Routes defined in one test file don't leak into another.
