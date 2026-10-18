# Testing

Testing with vitest: requests through the whole app with no server, sessions and action forms, events, fake services, and unit tests for services, guards and DTOs.

## Set up vitest

Vite can't lower TC39 decorators, so add yerd's decorator plugin.

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

[app.request()](api:yerd.YerdApp/request) sends a request through the whole pipeline (middleware, sessions, guards, actions, error pages, streaming) in-process and returns a fetch `Response`. No port.

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

- Paths resolve against `http://localhost`; pass a full URL for another host, or `https://...` to test TLS behaviour (`__Host-` cookies, `Secure`).
- The response resolves once headers are written, so SSE and NDJSON can be read as they arrive. `reader.cancel()` is the client hanging up: the route's signal fires.
- The first request starts the app (`@onBoot`, `@every`, hosted services), so `app.stop()` it afterwards.
- `routes` and `services` limit the app to those classes; otherwise it picks up every decorated class the test imported.
- [app.fetch(request)](api:yerd.YerdApp/fetch) takes a `Request` you built, and doubles as a handler for fetch-style runtimes.

### A client that keeps cookies

[app.client()](api:yerd.YerdApp/client) is a small test browser: it keeps cookies, sends a same-origin `Origin` on writes, and can submit the action forms a page rendered.

```ts
const client = app.client();
await client.action("/login", { name: "ada", password: "hunter22" }); // the page's form, its token, your fields
expect(await client.page("/account")).toContain("Signed in as ada");

await client.request("/logout", { method: "POST" });
expect(client.cookies.has("yerd_session")).toBe(false);
```

`client.action(page, fields, { index, to, script })` fetches `page`, takes its first action token (or the `index`-th), and posts it with your fields. By default it posts like the runtime (`yx` header: no redirects, JSON errors); `script: false` posts like a plain form.

## A real server

For tests about the network itself (keep-alive, a proxy, Playwright), listen on a free port.

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
- `handleSignals: false` leaves Ctrl-C to vitest.
- `server.close()` runs the full shutdown.

## Boot checks are tests too

Captive dependencies, unknown guards and missing services fail at boot, so one test catches them all.

```ts
import { it } from "vitest";
import { app } from "../src/app.js";

it("boots", async () => {
  await app.boot(); // throws a BootError listing every problem
});
```

## Sessions and action forms

Action tokens are bound to their session, so fetch the page and post its form with the same client:

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

| | Like the runtime (default) | `script: false`, like a plain form |
| --- | --- | --- |
| returns nothing | 204 | 303 back to the page |
| returns JSX | 200, the JSX without layouts | 303 back to the page |
| returns `redirect(url)` | 200 with a `yx-location` header | 303 to `url` |
| throws a validation error | 400, JSON `{ error, issues }` | your error page (or the flash-and-redirect you wrote) |

- A token rendered for one client and posted by another is a 403; worth a test of its own.
- For pages behind `auth.required`, sign in once with `client.action("/login", {...})` and keep using that client.

### Actions on other elements, and browser values

`client.action()` counts every action on the page, forms and other elements, in page order. Values a lambda reads in the browser (`el.value`, `ref("#x").checked`, `drag.data("id")`) travel as `_yxh0`, `_yxh1`, ... in first-read order, so pass them as fields:

```ts
it("searches as you type", async () => {
  const res = await app.client().action("/people", { _yxh0: "ada" }); // the search input's el.value
  expect(await res.text()).toContain("Ada Lovelace");
});
```

Without them the action answers 400.

## Testing events

Create an `Events.waitFor()` before the request that emits; see [testing events](14-events.md#testing-events).

## Faking services

`app.services()` registrations override `@service` ones for the same key:

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

It works for class keys too: `s.value(TodoRepo, new InMemoryTodoRepo())`, if the fake has the same shape.

## Testing services directly

[`app.scope()`](08-services.md#scripts-appscope) runs a function in a fresh request scope, so you can `resolve()` anything without HTTP.

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

## Capturing logs

Register an [ILogger](api:yerd.ILogger) that collects records. Under vitest the default level is `warn`, so set a filter.

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

See [logging](10-logging.md) for what's in a [LogRecord](api:yerd.LogRecord).

## Guards and DTOs, no server

A `createGuard` guard keeps its function as `.run`; call it with a stand-in context holding what the guard reads.

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

A named `@guard` is a service method: `app.scope(() => resolve(Flags).beta(ctx))`.

Check DTOs with [parse](api:yerd.parse), which returns the typed object or throws a 400 `YerdError` with the issues in `details`:

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
> Vitest gives each test file its own module graph, so routes defined in one test file don't leak into another.
