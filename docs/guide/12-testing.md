# Testing

This page covers testing yerd apps with vitest: real HTTP requests against a test server, sessions and action forms, fake services, and unit tests for services, guards and DTOs.

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

## A test server

Start the app on a free port, hit it with `fetch`, close it afterwards.

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

Node's `fetch` has no cookie jar, so bring a tiny one. Action tokens are bound to the session they were rendered for, so fetch the form and post it with the same cookies.

```ts
import { expect, it } from "vitest";

function client(base: string) {
  let cookies = "";
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      redirect: "manual",
      ...init,
      headers: { cookie: cookies, ...(init.headers as Record<string, string>) },
    });
    for (const c of res.headers.getSetCookie()) cookies = /Max-Age=0/.test(c) ? "" : c.split(";")[0]!;
    return res;
  };
}

/** The action token from a page's form, fetched with the same jar you'll post with. */
async function tokenFrom(c: ReturnType<typeof client>, path: string) {
  const html = await (await c(path, { headers: { accept: "text/html" } })).text();
  return /name="_yx" value="([^"]+)"/.exec(html)![1]!;
}

it("signs up", async () => {
  const c = client(server.url);
  const res = await c("/signup", {
    method: "POST",
    headers: { yx: "1" },
    body: new URLSearchParams({ _yx: await tokenFrom(c, "/signup"), name: "ada", password: "correct horse" }),
  });
  expect(res.status).toBe(200);
});
```

- The jar keeps one cookie (the session), which is all yerd sets. Grow it if your app sets more.
- `redirect: "manual"` lets you assert on redirects instead of following them.
- `yx: "1"` posts the way yerd's client runtime does: you get the action's own result (204 for nothing, the returned JSX or data, a `yx-location` header for a redirect). Without it you get what a browser without JavaScript gets: a 303 back to the page.

> [!TIP]
> A token fetched with one jar and posted with another is a 403. That's the session binding working, and it's worth a test of its own.

To test pages behind `auth.required`, log in once with this helper and keep using the same `c`: the session cookie now carries the user.

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

server = await yerd({ routes: [Signup], services: [SmtpMailer], handleSignals: false })
  .sessions()
  .services((s) => s.value(Mailer, fakeMailer))
  .listen(0, "127.0.0.1");
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

server = await yerd({ routes: [Hello], services: [], handleSignals: false })
  .services((s) => s.value(ILogger, { write: (r) => records.push(r) }))
  .logging({ filter: "info" })
  .listen(0, "127.0.0.1");

it("logs an access line", async () => {
  const res = await fetch(server.url + "/hello");
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
import { HttpError, createGuard, type YerdContext } from "@toyz/yerd";

const weekdays = createGuard("weekdays", (ctx) => {
  const day = new Date(ctx.headers.date ?? Date.now()).getDay();
  return (day !== 0 && day !== 6) || new HttpError(403, "Closed on weekends");
});

it("closes on weekends", async () => {
  const saturday = { headers: { date: "Sat, 17 Oct 2026 12:00:00 GMT" } } as unknown as YerdContext;
  const result = await weekdays.run(saturday);
  expect((result as HttpError).status).toBe(403);
});
```

A named `@guard` method is just a method on a service: `app.scope(() => resolve(Flags).beta(ctx))`.

DTO classes are checked with [parse](api:yerd.parse), the same function `form.parse()` and `@body` use. It returns the typed object or throws a 400 `HttpError` with the issues in `details`.

```ts
import { expect, it } from "vitest";
import { HttpError, parse } from "@toyz/yerd";

it("validates signups", () => {
  expect(parse(SignupForm, { name: "ada", password: "correct horse" })).toEqual({ name: "ada", password: "correct horse" });

  try {
    parse(SignupForm, { name: "a", password: "x" });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).details).toMatchObject({ issues: [{ path: "name" }, { path: "password" }] });
  }
});
```

> [!NOTE]
> Decorator registries are per module graph, and vitest gives each test file its own. Routes defined in one test file don't leak into another.
