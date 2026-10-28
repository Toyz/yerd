# yerd: plan

A TypeScript web server for Node that is also a server-side component renderer.
Routes are classes. Everything is a TC39 decorator. Handlers return anything,
and one of the things they can return is a yerd layout, which is TSX, which is
TypeScript, compiled by tsc into calls to a JSX runtime we wrote ourselves.

No express-style `app.get(path, fn)`. No React. Nothing else either.

The decorator model is lifted from [loom](https://github.com/Toyz/loom)
(`@route`, `@group`, `@guard`, `@inject accessor`, `@prop({ param })`, stacked
transforms, register-on-import) and moved to the server. Instance lifetimes
(singleton, scoped, transient) are the user's choice, the way ASP.NET Core does it.

## The one rule

**No runtime dependencies.** What ships in `@toyz/yerd` is hand-written code on
top of `node:*` built-ins and web platform APIs, and its `dependencies` field is
empty. **devDependencies are fine** for building and testing: `typescript`,
`@types/node`, `vitest`, `happy-dom`, `@playwright/test`, benchmarking tools.

One guard on that: devDeps can't do the shipped code's job. The published
`dist/` is plain tsc output, so no bundler or transpiler sneaks into the build,
and nothing a user's app runs comes from a devDep.

Everything that ships is written by hand:

| Thing                | Normally          | yerd                                        |
|----------------------|-------------------|---------------------------------------------|
| HTTP server          | express/fastify   | `node:http` + our own router                |
| Routing DSL          | `app.get(...)`    | TC39 decorators on classes                  |
| DI                   | tsyringe/inversify| `@service` + `@inject accessor`, hand-rolled container |
| Templates            | react/ejs/etc     | TSX compiled by tsc into our `jsx-runtime`  |
| Dev reload           | nodemon/tsx       | the Vite plugin (raw lite: `tsc --watch` + `node --watch`, planned) |
| Body parsing         | body-parser, multer | hand-rolled (json, text, urlencoded, ndjson); multipart via Node's built-in `FormData` |
| Static files / mime  | serve-static      | `node:fs` + a hand-written mime table       |
| Cookies / signing    | cookie, iron      | `node:crypto` HMAC                          |
| Logging / tracing    | pino, winston, OTel SDK | `Logger` facade, `@instrument` spans, `ILogger` sink from DI, built-in console sink, request ids and access log, see [LOGGING.md](LOGGING.md) |
| Sessions / auth      | express-session, passport, jsonwebtoken | `node:crypto` (AES-GCM, HMAC, argon2id), see [AUTH.md](AUTH.md) |

Node built-ins (`node:*`) and web globals that ship in Node (`URL`,
`URLSearchParams`, `TextEncoder`, `ReadableStream`) are fair game. They're the
platform, not dependencies.

Testing uses normal devDeps: **vitest** (with **happy-dom** for DOM tests) and
**Playwright** for real-browser tests. See [Testing](#testing).

## What it looks like

```tsx
// src/routes/users.tsx
import { route, get, post, param, query, body, inject, guards, layout, toInt, redirect } from "@toyz/yerd";
import { MarketingLayout } from "../layouts.js";
import { UserRepo, UserPatch } from "../users.js";

@route("/users/:id")
@layout(MarketingLayout)                         // inside the app's root layout(s)
export class UserPage {
  @param("id", { transform: toInt }) accessor id!: number; // from the path, parsed (field type checked)
  @query("tab") accessor tab = "posts";          // from ?tab=, with a default
  @inject(UserRepo) accessor users!: UserRepo;   // DI, lazy, read-only
  @body(UserPatch) accessor patch!: Promise<UserPatch>;    // DTO class, validated when awaited

  @get
  async show() {
    const user = await this.users.find(this.id);
    if (!user) return 404;                       // number -> bare status
    return <UserProfile user={user} tab={this.tab} />; // JSX -> html, in the layouts
  }

  @post
  @guards("auth")                                // apply the named guard defined in src/auth.ts
  async update() {
    await this.users.update(this.id, await this.patch);
    return redirect(`/users/${this.id}`);        // 303 unless told otherwise
  }
}
```

```ts
// src/routes/api.ts
@route("/api/health")
export class Health {
  @get check() {
    return { ok: true, uptime: process.uptime() }; // object -> json
  }
}

@route("/ping")
export class Ping {
  @get pong() { return "pong"; }                   // string -> text/plain
}
```

```ts
// src/auth.ts -- named guards live on services, like loom
@service
export class AuthGuards {
  @guard("auth")                         // define a named guard
  check(ctx: YerdContext) {
    // true = continue, a string = redirect (loom style), anything else is the response
    return ctx.session.get("userId") ? true : `/login?next=${encodeURIComponent(ctx.path)}`;
  }
}
// (Most apps use @toyz/yerd/auth instead: guards: [auth.required], @auth.user. See AUTH.md.)
```

```ts
// src/main.ts
import { yerd } from "@toyz/yerd";
import { RootLayout } from "./layouts.js";

await yerd()
  .layout(RootLayout)                              // root layout around every page
  .sessions()                                      // sealed-cookie sessions
  .discover(new URL("./routes/", import.meta.url)) // imports every file; decorators register on import
  .listen(3000);
// Under Vite: export default yerd()...discover(import.meta.glob("./routes/**/*.{ts,tsx}", { eager: true }))
```

```tsx
// src/layouts.tsx -- layouts and components are just TSX
import { Scripts, resolve, type LayoutProps } from "@toyz/yerd";

export function RootLayout({ meta, children }: LayoutProps) {
  return (
    <html lang="en">
      <head><title>{meta.title ?? "yerd"}</title><Scripts /></head>
      <body>{children}</body>
    </html>
  );
}

// async function components: awaited during render, the page top streams first
export async function PostList({ userId }: { userId: number }) {
  const posts = await getPosts(userId);
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}

// components reach DI with resolve() (class components with @inject are planned)
export function Greeting({ name }: { name: string }) {
  const clock = resolve(Clock);
  return <p>good {clock.partOfDay()}, {name}</p>;
}
```

## Decorator catalog

Everything below except `@route`, `@group`, the verb decorators and the DI
decorators is built with the public decorator kit (`createAccessor` and
`createGuard` today; `createWrapper` and `createMeta` are planned). Users get
the same kit to make their own. See [DECORATORS.md](DECORATORS.md). Rows
marked *(planned)* aren't built yet.

| Decorator                         | Kind      | Does                                                     |
|-----------------------------------|-----------|----------------------------------------------------------|
| `@route(path, opts?)`             | class     | registers the class at `path`; `opts.group`, `opts.name`, `opts.guards`, `opts.meta` |
| `@group(prefix, opts?)`           | class     | prefix, guards, meta, layout, wrappers inherited by members; nests via `opts.group`; `inheritLayouts: false` starts the layout chain fresh (own document) |
| `@layout(A, B, ..., { inherit? })` | class / method | wraps JSX results in layouts, outermost first; on a route class, a `@group` class, or one handler method (innermost); `{ inherit: false }` makes them the whole chain; a layout already in the chain isn't repeated, so `@layout(RootLayout, MarketingLayout)` can spell the chain out; stacked `@layout`s read top to bottom. Per response: `res(node, { layout, inherit })` |
| `@get` `@post` `@put` `@patch` `@del` `@head` `@all` | method | verb handlers on a route class          |
| `@guard(name?)`                   | method    | define a named guard on a `@service` (name defaults to the method name) |
| `@guards(...refs)`                | class/method | apply guards by name or by `createGuard` value; stacked guard decorators run top to bottom as written |
| `@action` / `bind(action, args)`  | method / fn | a route method a form calls: `<form action={this.add}>`, `<button formaction={bind(this.remove, { id })}>`; signed `_yx` token, works without JS ([DYNAMICS.md](DYNAMICS.md)) |
| `attribute(name, { render?, client? })` | fn  | custom attribute: a JSX prop with a server half (what it renders) and a client half (behaviour shipped in the runtime script) ([DYNAMICS.md](DYNAMICS.md#tier-15-custom-attributes-and-prefetch)) |
| `prefetch` / `prefetch="visible"` / `prefetch={{ url, as: "json" }}` | prop | built-in attribute: warm the next page or a JSON response on intent, visibility or load |
| `@status(code)` `@setHeader(k, v)` | method   | defaults for the coerced response: the status replaces the default 200/204 (an explicit `res()` status or returned number wins); a header the result sets wins. In handlers: `ctx.setHeader` / `setCookie` / `deleteCookie` / `status`; `res(x, { cookies })` |
| `@catches(...ErrorClasses)`       | method    | error handler on a route class for its handlers, guards and actions; returns anything (JSX in the route's layouts), keeps the error's status unless it returns `res(..., { status })` or a number; undefined passes it on to `app.onError`, then the error page |
| `@param(name)` `@query(name)` `@header(name)` `@cookie(name)` | accessor | request data, per-request instance |
| `@params`                         | accessor  | the whole params object (`@queryAll` planned)            |
| `@body(opts?)` `@field(name, opts?)` | accessor | parsed body / one form field, as a **promise** (lazy: nothing is read unless awaited). Same `{ transform, validate, required }` options; body pipelines start from `unknown`. JSON, URL-encoded, multipart (files sit next to the fields, for `is.file()`), text, bytes; 413 over `bodyLimit` |
| `@file(name, opts?)` `@files(name, opts?)` | accessor | uploads from a multipart form as `Promise<File>` / `Promise<File[]>`; `{ required, types: ["image/*"], maxSize }` (400 / 415 / 413). In actions: `form.file(name)` / `form.files(name)`. Raise `bodyLimit` for big uploads |
| `is.string` `is.int` `is.number` `is.boolean` `is.oneOf([...])` `is.object(Dto)` `is.array(is.x())` `is.file(rules?)` `is.files(rules?)` `is.custom(fn)` | field | DTO classes: the class is the schema. `body(Signup)` validates into a real `Signup` instance (400 with every issue and its path, as JSON), unknown keys dropped, field initializers as defaults, numeric/boolean strings accepted so one DTO serves JSON and forms. A decorator that doesn't match its field's declared type is a compile error, so the validated type can't drift from the declared one. `dto(Signup)` is the same thing as a transform; `parse(Signup, raw)` for manual use |
| `@accepts("json", ...)`           | method    | content negotiation: a second handler for the same verb, chosen by the Accept header (q-values, type ranges; bare `*/*` never beats the default; 406 when nothing fits; `Vary: Accept`) |
| `negotiate({ html, json, ... })`  | return value | same rules from one handler; only the chosen variant runs; first key is the default |
| `@prerender` / `@prerender({ paths })` | class | render the route at `vite build`: HTML to `<path>/index.html`, other types to the path itself (`/config.json`); served as files in production, handler never runs. Request data (query, headers, cookies, session, body, signed-in user) fails the build with the route and what it read |
| `<Dynamic id fallback>{() => ...}</Dynamic>` | component | per-request part of a page: renders normally on ordinary requests; in a prerendered file it's the fallback (a skeleton) and the runtime fetches the real content after load (one `yx-dynamic` request per page, server walks the page and sends only the Dynamic parts, `no-store`). The children may read request data, since they never run at build time |
| `Channels`, `channel<T>(name)`    | service / fn | named pub/sub for live features (built in): `publish(ref, msg)` type-checked, `subscribe(refs, signal)` subscribes at once (nothing published before the first read is missed), yields per subscriber with a bounded queue, unsubscribes on return or abort (and undoes a partial subscribe if a backend throws); pluggable `ChannelBackend` (memory by default) for multi-instance setups. Any `@sse` / `@ndjson` route returning `channels.subscribe(...)` is a live feed |
| `@args(...resolvers)`             | method    | the same resolvers as method arguments, promises awaited, parameter types checked (TC39 has no parameter decorators) |
| `@request`                        | accessor  | raw request, readable from anywhere via ALS (`@response` planned) |
| `toInt` `toNumber` `toBool` `trim` `lower` `oneOf(...)` | transform | plain functions in the accessor's options: `@param("id", { transform: toInt })`, or a pipeline run left to right: `@query("sort", { transform: [trim, lower, oneOf("asc", "desc")] })`. Each step must accept the previous step's output; the field type is checked against the last one |
| `between(a, b)` `length(min, max?)` `matches(re, msg?)` | validator | `validate` option, one or an array, run on the transformed value: `{ transform: toInt, validate: between(1, 50) }`. Return `true`/nothing to pass, `false` for a generic 400, a string for a 400 with that message. Typed by the pipeline output; inline validators annotate their parameter: `(n: number) => n > 0`. Options rather than loom-style stacked decorators, because a separate `@toInt` can't change the type `@param` checks the field against |
| `@service(name? \| opts?)`        | class     | DI-registered class, singleton by default (bare or called) |
| `@singleton` `@scoped` `@transient` | class   | set lifetime on a `@service`, `@route` or `@component`   |
| `@inject(Key)` `@maybe(Key)`      | accessor  | DI, throw vs `undefined` when missing                    |
| `@factory(Key)`                   | method    | *(planned)* provider registered at boot; today: `app.services((s) => s.scoped(Key, (c) => ...))` |
| `@component`                      | class     | *(planned)* class component with `render()`; today function components use `resolve(Key)` |
| `@prop`                           | accessor  | *(planned)* component prop                               |
| `@onBoot` `@onShutdown`           | method    | lifecycle hooks on singleton services: boot hooks awaited before serving, shutdown hooks newest first after requests drain |
| `@hosted`                         | class     | background service (ASP.NET BackgroundService): singleton whose `run(signal)` starts after boot and is aborted at shutdown; type-checked to have `run` |
| `@every("5m", { immediate? })`    | method    | periodic task on a singleton; runs never overlap; gets the shutdown signal |
| `@ndjson` `@ndjson({ heartbeat })` / `ndjson(iter)` | method / fn | NDJSON response from an async generator: headers sent immediately, optional blank-line heartbeat, `{"error"}` line on failure, stopped on disconnect or shutdown |
| `@sse` `@sse({ heartbeat, retry })` / `sse(iter)` / `event({...})` | method / fn | Server-Sent Events, same behaviour, `event: error` on failure. Caveat for both: `return()` on an async generator parked at an `await` waits for it, so its `finally` runs late; pass the request signal (`@signal`) to slow waits, as `Channels.subscribe` does |
| `ndjsonBody(Dto?)`                | accessor / @args | streamed NDJSON upload as `AsyncIterable<T>`, validated line by line; no whole-body limit, each line capped at `bodyLimit` (413) |
| `@signal`                         | accessor  | `AbortSignal` that fires on client disconnect or shutdown |
| `@instrument(opts?)`              | method    | tracing span around any method, Rust `#[instrument]` style: arguments as fields (secrets redacted), return value, duration, errors ([LOGGING.md](LOGGING.md)) |
| `@logger` / `@logger(category)`   | accessor  | `Logger` targeted at the class, like `ILogger<T>` |
| `@session`                        | accessor  | the session ([AUTH.md](AUTH.md))                         |
| `createAuth({ load, ... })`: `@auth.user` `@auth.maybeUser` `auth.required` `auth.role(...)` | mixed | optional `@toyz/yerd/auth`, built only on the kit (`@can`, `@bearer` planned) |

## Decorator mechanics (stolen from loom, then adjusted)

**Standard decorators only.** No `experimentalDecorators`, no
`emitDecoratorMetadata`, no `reflect-metadata` (that'd be a dep anyway). TC39
stage 3 as implemented by tsc 5.x.

**`defineDecorator`**: yerd's version of loom's `createDecorator`. One factory
for class and method decorators: setup runs at define time; if it returns a
function, that runs per instance via `context.addInitializer`. All built-in
decorators are written with it, and it's exported so users can write their own
(`@cache("1h")`, `@rateLimit(10)`).

**Typed metadata keys.** Port of `LoomSymbol` as `YerdKey<T>`: a typed wrapper
around a `symbol` with `from/set/has` and copy-on-inherit `ownArray/ownMap`, so
a subclass adding a handler never leaks it into the base class or its siblings.

**`context.metadata` instead of staging arrays.** Member decorators evaluate
before class decorators. Loom handles that with a module-level `pendingProps`
array that `@component` flushes. yerd uses `context.metadata` (TS 5.2+): every
member decorator writes into the class's metadata object, and `@route` reads
all of it in one place when it runs last. Requires a one-line
`Symbol.metadata ??= Symbol("Symbol.metadata")` polyfill that `@toyz/yerd`'s entry
module runs before any user class is defined (ESM evaluation order guarantees
this, since user modules import `@toyz/yerd`). Metadata objects prototype-chain to the
parent class's metadata, so `ownArray` semantics still matter here.

**Register on import.** Like loom, decorators push into global registries
(routes, guards, services, factories) at class-definition time. `discover(dir)`
is a hand-rolled recursive `fs.readdir` + `import()` of every `.js` file, which
is all "file-based routing" has to mean.

**No parameter decorators exist in TC39.** So request data goes through
`accessor` fields, never method params. Request accessors (`@param`, `@query`,
`@body`, `@request`, ...) store nothing on the instance: their getters read the
current request from `AsyncLocalStorage`. So they behave the same whatever the
class's lifetime, which is what lets a singleton route or a singleton `@service`
use `@param` and `@request` safely.

**`addInitializer` runs per instance.** Scoped and transient classes are
instantiated per request or per resolution, so any initializer that registers
something globally must dedupe (loom hit this with `@prop` route bindings growing
per element). Rule: define-time work goes in the decorator body or metadata,
never in initializers.

**The decorator kit.** `defineDecorator` is the low level. On top of it sit
`createAccessor`, `createGuard`, `createWrapper`, `createMeta` and `compose`,
which every non-core built-in uses and which are exported for users. Details in
[DECORATORS.md](DECORATORS.md).

**Bare-or-called decorators.** `@service` and `@service("Name")` both work by
checking `context?.kind === "class"` on the first call, like loom's `service()`.
A naive factory would return a function from the bare form and silently replace
the class with it.

**Boot-time checks.** The compiler can't see across decorators, so `listen()`
validates the registry and refuses to start on: a `@param("x")` not in the route
pattern, duplicate route + verb, unknown guard names, unregistered `@inject`
keys. Errors name the class and member.

## Lifetimes (the C# part)

Same three lifetimes as ASP.NET Core's `AddSingleton` / `AddScoped` /
`AddTransient`, chosen per class by the user.

| Lifetime    | One instance per          | Default for                   |
|-------------|---------------------------|-------------------------------|
| `singleton` | process                   | `@service`                    |
| `scoped`    | request (the ALS scope)   | `@route` classes              |
| `transient` | resolution                | `@component` classes          |

```ts
@service                         // singleton (default)
class Clock { now() { return Date.now(); } }

@service({ lifetime: "scoped" }) // one per request
class UnitOfWork { ... }

@service({ lifetime: "transient" })
class IdGen { ... }

@route("/health", { lifetime: "singleton" }) // routes can opt out of per-request
class Health { @get check() { return { ok: true }; } }
```

Sugar for the same thing: `@singleton`, `@scoped`, `@transient`, stackable on
`@service` or `@route` (`@singleton @route("/health") class Health`).

**Rules, copied from C#:**
- **Captive dependencies fail at boot.** A singleton injecting a scoped service is
  an error at `listen()`, like `ValidateScopes` in ASP.NET Core. The message
  names the chain: `Health (singleton) -> UnitOfWork (scoped)`. Transient
  injected into a singleton is allowed but becomes effectively singleton, same
  as C#; the boot log mentions it in dev.
- **Scoped outside a request throws** with a clear message (e.g. touched from
  `@onBoot`). `yerd().scope(async () => ...)` creates a scope by hand for
  scripts and tests, like `CreateScope()`.
- **Disposal.** Instances implementing `[Symbol.asyncDispose]` or
  `[Symbol.dispose]` (TC39 explicit resource management, native in Node 26) get
  disposed in reverse creation order: scoped at the end of the request,
  singletons at shutdown. That's `IDisposable` / `IAsyncDisposable`. A
  transient lives as long as whatever holds it: one injected into a singleton
  is disposed with the singleton (at shutdown), not with the request that
  first read it; one injected into a scoped instance, or resolved inside a
  request, at the end of the request. A transient resolved directly with no
  scope (in an `@every` method, say) isn't tracked: the caller disposes it.
  Factory registrations are tracked like classes (`value()` registrations
  never are), and `container.adopt(instance, scope, lifetime)` tracks an
  instance created by hand.
- **Singleton routes share state.** Fields on a singleton route class are shared
  by every request. Request accessors are still safe (they read ALS), plain
  fields are not. That's the user's call; the docs say so loudly.

**Start and stop.** `app.start()` (called by `listen()`) boots, runs
`@onBoot` hooks and starts `@hosted` services and `@every` timers. A start
that fails tears down whatever it got running and stays failed. `app.stop()`
waits for a start still in progress, aborts long-lived streams, stops
background work, runs `@onShutdown` hooks newest first and disposes
singletons. A stopped app can't be started again; make a new one (the Vite
plugin does, on every reload).

**Implementing a token.** `@service({ provides: ILogger })` registers the class
as the implementation of a token, the decorator equivalent of
`s.singleton(ILogger, MyLogger)`. Two providers for one token is a boot error
unless one is registered programmatically (which wins, so tests can override).

**How `@inject` resolves.** The accessor resolves on first read and caches by
the target's lifetime: singletons in the container, scoped in the request's
scope map, transients on the owning instance (so `this.idGen` is one instance
per owner, not a new one per property read).

**Programmatic registration**, for things decorators can't express: interfaces
(no runtime existence in TS, so they need a token), third-party classes, and
test overrides.

```ts
const Mailer = token<Mailer>("Mailer");

yerd()
  .services((s) => s
    .singleton(Mailer, SmtpMailer)
    .scoped(Db, (sp) => sp.get(Pool).connect())
    .transient(IdGen))
  .listen(3000);

// in a test
yerd().services((s) => s.singleton(Mailer, FakeMailer));
```

`@inject(Mailer) accessor mailer!: Mailer` is typed through the token. Later
registrations override earlier ones (decorator registration runs first, at
import), so tests swap implementations without touching the classes.

### Type-level bonus: typed params without losing decorators

Plain `@param("id")` is stringly typed. Optional typed form:

```ts
const UserRoute = route("/orgs/:org/repos/:repo");

@UserRoute
class Repo {
  @UserRoute.param("repo") accessor repo!: string;
  @UserRoute.param("nope") accessor x!: string; // compile error: "nope" not in path
}
```

`route(path)` returns a decorator that also carries `.param<K extends ParamNames<P>>`,
with `ParamNames<P>` pulled out of the path literal by template literal types:

```ts
type ParamNames<P extends string> =
  P extends `${string}:${infer N}/${infer R}` ? N | ParamNames<`/${R}`> :
  P extends `${string}:${infer N}`            ? N :
  P extends `${string}*${infer N}`            ? N :
  never;
```

## The trick: tsc masking as a template engine

tsc already knows how to compile JSX to function calls. With:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "lib": ["ES2023", "esnext.decorators"],
    "strict": true,
    "jsx": "react-jsx",
    "jsxImportSource": "@toyz/yerd"
  }
}
```

tsc rewrites `<h1>{x}</h1>` into:

```js
import { jsx as _jsx } from "@toyz/yerd/jsx-runtime";
_jsx("h1", { children: x });
```

We own `@toyz/yerd/jsx-runtime`. Our `jsx()` doesn't build a virtual DOM for diffing;
it builds a dumb tree of `{ type, props }` nodes that the renderer walks once
and turns into HTML strings. That's the entire template engine.

**Resolution gotcha:** tsc does not rewrite import specifiers, so the emitted JS
literally imports `"@toyz/yerd/jsx-runtime"`. In an app that installed
`@toyz/yerd` from npm, that resolves through `node_modules` like any package.
Inside this repo (examples, tests) there's no `node_modules/@toyz/yerd`, so the
fix is package self-reference: `package.json` has `"name": "@toyz/yerd"` and an
`"exports"` map with `"./jsx-runtime"` pointing at `./dist/src/jsx/jsx-runtime.js`,
and Node resolves a package's own name from inside itself, scoped names
included. (Loom sidesteps this with `jsxImportSource: "."`, which works for a
library compiling itself but not for apps importing it.) Verify in M0.

**Types:** the `JSX` namespace's `IntrinsicElements` is hand-written in
`src/jsx/elements.ts`: a `GlobalAttributes` base plus specific entries for the
HTML (and common SVG) elements. Attribute names are the HTML names, lowercase,
exactly as they render (`tabindex`, `for`, `maxlength`); `className` is the one
alias (rendered as `class`). `on*` handlers are typed but render nothing yet
(they become sprinkles in M6). Custom attributes extend the
`CustomAttributes` interface. Typos in attribute names become compile errors.

## Request lifecycle

```
node:http request                    src/server/app.ts (handle)
  -> /_yerd/runtime.js, prerendered files
  -> router.match(path)                src/router/trie.ts      (static > :param > *splat)
       no match: static mounts, else 404 error page
  -> cross-site check (unsafe methods) crossSiteReason, see AUTH.md
  -> RequestContext + DI Scope         src/server/request-context.ts
  -> ALS.run(ctx, ...)                 src/server/context.ts   (one async context for request + DI scope)
  -> async session store read          only for a store that isn't `sync`, a session cookie, and no `session: false`;
                                       otherwise the session opens (unseal, sync store get) on first use
  -> middleware (app.use)
  -> action? (_yx in a form POST)      verify token, class guards + action's own guards, run it
  -> app, group, route, class, method guards   (first non-true result wins)
  -> resolve RouteClass                by its lifetime: scoped (default), singleton, transient
  -> resolve @args (awaiting promises); @body / @field read lazily when awaited
  -> handler method()                  returns anything
  -> coerce(result)                    src/respond/coerce.ts
       JSX? wrap in root > group > route layouts, stream render
  -> first chunk rendered              (an error here still becomes the error page)
  -> on throw: the route's @catches, then app.onError, then the error page
  -> session commit                    (only a session something opened; skipped when the handler crashed with a non-YerdError;
                                        a session's first save carries its CSRF nonce)
  -> ServerResponse; scope disposed
```

Router is a segment trie, so specificity comes free (`/users/new` beats
`/users/:id` regardless of import order, which loom had to fix by sorting on
insert).

### "Return anything" coercion table

Applies to handler results, guard results and `@catches` results alike.

| Returns                        | Response                                         |
|--------------------------------|--------------------------------------------------|
| `YerdResponse` (from `res()`, `redirect()`) | as-is                               |
| JSX element / `YerdNode`       | `text/html`, `<!doctype html>`, layouts applied, streamed |
| `string`                       | `text/plain; charset=utf-8`                      |
| `number`                       | that status code, empty body (`418` works)       |
| `undefined` / `null`           | `204 No Content`                                 |
| `Uint8Array` / `Buffer`        | `application/octet-stream`                       |
| `AsyncIterable` / generator    | chunked stream, each chunk coerced as string/bytes |
| `Promise<T>`                   | awaited, then coerced                            |
| thrown `YerdError`             | its status, via `@catches` or the error layout   |
| thrown anything else           | `500`, stack page in dev, generic page in prod   |
| plain object / array / boolean | `application/json`                               |

`@status` / `@setHeader` on the method (or `ctx.status()` / `ctx.setHeader()`
inside it) set defaults; an explicit `res()` status overrides. `YerdResponse` (behind `res()` and `redirect()`) lowercases
header names, so `Content-Type` replaces the default instead of going out next
to it; refuses a status outside 200-599 and header values containing CR, LF or
NUL. `Vary` from content negotiation is appended to a handler's own, not
substituted. `OPTIONS *` gets a 204 with `Allow`; an unparseable
absolute-form request target is a 400.

Multipart form bodies are parsed with Node's built-in `FormData`; files reach
actions as `form.file(name)` / `form.files(name)` (`ActionForm`). Uploads count
against `bodyLimit` (1 MiB by default), so raise it for them.

### Renderer

- Walks the node tree depth-first, synchronously until something is async, and
  yields string chunks (see [PERF.md](PERF.md)).
- Function components: call, await if Promise. Class components (`@component`,
  planned): instantiate, assign `@prop`s, run inside the request ALS so
  `@inject` and `@request` work, call `render()`, await if Promise.
- Text children HTML-escaped by default. `raw("<b>hi</b>")` opts out.
- `<script>` and `<style>` children are raw text, not escaped: strings, numbers,
  `raw()` and `json(value)` (JSON with `<`, `>`, `&`, U+2028/9 escaped, for
  inline data). Text that could close the element throws (`</script` or `<!--`
  in a script, `</style` in a style).
- Attributes: escaped; `true` -> bare, `false`/`null`/`undefined` -> omitted,
  except enumerated ones: `aria-*`, `draggable`, `spellcheck`,
  `contenteditable` render `"true"`/`"false"`, `translate` `"yes"`/`"no"`.
  `NaN` is omitted; `URL` and `Date` values are stringified (ISO for dates).
  `class` accepts string | array | `Record<string, boolean>`, and `class` plus
  `className` merge into one attribute. `style` accepts an object (camelCase ->
  kebab-case); keys are validated and values containing `;`, `{`, `}` or `<`
  throw.
- URL attributes (`href`, `src`, `action`, `formaction`, `poster`, ...):
  `javascript:`, `vbscript:` and `data:` URLs become `about:blank#blocked`
  (`data:image/` is allowed on `src` and `poster`); `raw()` opts out.
- `<form action={action}>` and `<button formaction={action}>` (submit buttons
  only) render the action's URL and signed token.
- Void elements never get closing tags; empty children (`null`, `""`, `[]`) are
  tolerated, real ones throw.
- `renderToString(node)` for tests, `renderToStream(node)` for responses.
  `createElement(type, props, ...children)` is exported for code without JSX.
- Streaming flushes `<head>` and the top of the page before slow async
  components finish.

### Guards (loom parity, plus a bit)

Same model as loom: guards are named methods on services, routes and groups
reference them by name.

```ts
@service
class AuthGuards {
  @inject(Sessions) accessor sessions!: Sessions;

  @guard("auth")
  checkAuth(route: GuardContext) {
    return this.sessions.current() ? true : `/login?next=${route.path}`;
  }

  @guard("admin")
  checkAdmin(route: GuardContext) {
    // route.meta carries whatever the @route / @group declared
    return route.meta.role === "admin" && this.sessions.isAdmin() ? true : false;
  }

  @guard()                                  // name defaults to "checkSubscription"
  async checkSubscription(route: GuardContext) { ... }
}

@group("/admin", { guards: ["auth"], meta: { area: "admin" } })
class AdminArea {}

@route("/billing", { group: AdminArea, guards: ["checkSubscription"], meta: { role: "admin" } })
class Billing {
  @get show() { ... }
  @post @guards("admin") cancel() { ... }   // method-level, yerd addition
}
```

**Kept from loom:**
- `@guard(name?)` on a service method; name defaults to the method name.
- Applied via `guards: [...]` on `@route` and `@group`; group chains append
  guards and merge `meta` (route overrides group), like `resolveGroupChain`.
- The guard's first argument is loom's `RouteInfo` shape: `path`, `params`,
  `query`, `pattern`, `name`, `meta`. In yerd it's the full `YerdContext` with
  `meta` added (`GuardContext`), so loom-style guards port over unchanged.
- Return `true` to continue, a **string to redirect** (303). That's a deliberate
  exception to the coercion table, for loom parity, and applies to every guard
  including kit-made ones. `false` is `403`. Anything
  else (number, JSX, `res()`, `YerdError`) is coerced as the response.

**Changed from loom:**
- **Method-level guards.** Loom routes are whole components; yerd routes have
  verbs and actions, so `@guards(...)` also goes on methods. It accepts names or
  kit guards in the same list: `@guards("auth", roles("admin"))`.
- **No rebinding trick.** Loom registers the raw method, then rebinds it to the
  instance in `addInitializer`, which only works once the service has been
  constructed. yerd registers `(ServiceClass, methodName)` and resolves the
  service through DI at check time, so `@inject` inside guards always works and
  lifetimes are respected (a scoped guard service gets the request's instance).
- **Duplicate names are a boot error**, not a `console.warn`. So are unknown
  names. Only the app's own services count (the registry is process-wide): a
  `@guard` class outside them is ignored, and referencing its name is a boot
  error with a hint saying so. A `@guard` on a base class works through a
  registered subclass.
- **Guards cover actions.** An action runs behind its class's guards (app,
  group, route `guards`, class decorators) plus its own method guards; the
  guards on the class's verb methods don't apply to it.
- **Order:** app-wide (`app.guard(...)`), then the group chain outer to inner,
  then the route's `guards` option, then class decorators, then the method.
  Stacked guard decorators run top to bottom as written. First non-`true`
  result wins, rest don't run.
- **Typed names (optional, planned).** In dev, `yerd routes --types` writes
  `.yerd/guards.d.ts` from the registry, augmenting `interface GuardNames`.
  With it present, `guards: ["auht"]` is a compile error; without it names are
  plain strings and boot validation catches typos.

**In islands.** A named guard on a client-side `@service` (one in the island
graph) works on island methods as a UX check, same as kit guards on the client.
Server guards are never shipped to the browser.

### Groups (loom parity, plus server stuff)

Declare a prefix, guards and meta once; routes opt in by pointing at the group
class. Same as loom, so the bug "the one admin route nobody remembered to guard"
can't happen.

```tsx
@group("/org/:orgId", { guards: ["auth"], meta: { area: "org" } })
class OrgGroup {
  @param("orgId") accessor orgId!: string;      // group params are real params
  @inject(Orgs) accessor orgs!: Orgs;

  @layout                                       // bare @layout on a method = this group's layout
  async frame(children: Child) {
    const org = await this.orgs.find(this.orgId);
    return <OrgShell org={org}>{children}</OrgShell>;
  }

  @get overview() { ... }                       // a group with verbs serves its own prefix: /org/:orgId
}

@group("/team/:teamId", { group: OrgGroup, guards: ["teamMember"] })
class TeamGroup {}

// /org/acme/team/alpha/member/jane
// params: { orgId: "acme", teamId: "alpha", memberId: "jane" }
// guards: auth -> teamMember -> (route guards)
// layouts: RootLayout > OrgGroup.frame > page
@route("/member/:memberId", { group: TeamGroup, meta: { role: "viewer" } })
class Member {
  @params accessor p!: { orgId: string; teamId: string; memberId: string };
  @get show() { ... }
}
```

**Kept from loom:**
- `@group(prefix, { guards?, meta? })` on a class; `@route(path, { group })` joins it.
- `@route("/", { group })` matches the group prefix exactly.
- Nested groups. Loom's stacking style works as-is:
  `@group("/admin") @route("/", { group: AppGroup }) class AdminGroup`.
  yerd also accepts `@group("/admin", { group: AppGroup })` for a group that
  isn't itself a page.
- `:param` segments in any group prefix cascade to every route below it.
- Chain resolution root to leaf: prefixes concatenate, guards run root first then
  route, `meta` merges with the deeper level winning.
- Decorator order on the class doesn't matter.

**Changed or added:**
- **Resolved at boot, not at decoration time.** Loom's `@group` patches a route
  entry that `@route` already registered, because class decorators run bottom-up.
  yerd writes both to `context.metadata` and resolves every chain once, at
  `listen()`, after `discover()` has imported everything. No patching, no order
  cases. Cycles in a group chain are a boot error.
- **Groups are request participants.** A group class is instantiated per request
  like a route (scoped by default, any lifetime allowed), so it can have
  accessors (`@param`, `@user`, `@inject`) and use them in its layout. This
  replaces loom's group-component-with-`<loom-outlet>`: the group's `@layout`
  method receives the child page as `children` and wraps it.
- **Layout options.** `@group(prefix, { layout: Component })` or
  `@layout(Component)` on the group class (a bare `@layout` method on the
  group class, as in the example above, is planned). One per group.
- **A group with verb methods is its own index route**, without stacking a
  `@route("/")` on it (stacking still works).
- **Everything kit-made inherits.** Kit guards, wrappers (`@timed`,
  `@transaction`) and metas on a group class apply to all its member routes and
  their actions. `@catches` on a group handles errors for every member.
- **Named routes compose.** `@group("/admin", { name: "admin" })` plus
  `@route("/users/:id", { name: "user", group: Admin })` gives `admin.user`, and
  `url("admin.user", { id: 7 })` builds `/admin/users/7` (loom's `buildPath`,
  with values URL-encoded). With `.yerd/routes.d.ts` from `yerd routes --types`,
  names and their params are typed.
- **Typed params through the chain.** The typed-route helper nests:
  `const Org = group("/org/:orgId"); const Team = Org.group("/team/:teamId");`
  `const Member = Team.route("/member/:memberId");` and `Member.param("orgId")`
  type-checks because the full path is concatenated at the type level.
- `yerd routes` prints a group column, plus the resolved guard order and layout
  chain per route.

### Layouts

- The chain, outermost first: the app's `app.layout()`s, group layouts
  (`{ layout }` options and `@layout` on the group class) outer to inner, the
  route class's `@layout`, the handler method's `@layout`, then any
  `res(node, { layout })` the handler returned. Each `@layout` takes several
  layouts; `{ inherit: false }` at any level starts the chain fresh there.
- A layout already in the chain is skipped rather than wrapped twice, so a
  route can name its whole chain for readability:
  `@layout(RootLayout, MarketingLayout)`.
- `bare(<div/>)` skips layouts for htmx-style partials; `@noLayout` on a
  method does it declaratively.

## Project layout

What exists today; entries marked *(planned)* are designed in these docs but
not built yet.

```
yerd/
  package.json            name "@toyz/yerd", type "module", exports map, no dependencies, devDeps for build + test
  tsconfig.json           plus tsconfig.build.json (published dist/), .examples.json, .bench.json
  src/
    index.ts              public API (polyfill import first)
    polyfill.ts           Symbol.metadata ??= ...
    assets.ts             assetUrl(), <Stylesheet>, Vite manifest lookup
    decorators/
      keys.ts             YerdKey<T>, ownArray/ownMap, local keys
      kit.ts              createAccessor, @args
      route.ts            @route @group @layout @noLayout @accepts @prerender + verb decorators
      request.ts          @param @params @query @header @cookie @body @field @request @signal @session ndjsonBody + transforms, validators
      dto.ts              is.*, parse(), dto()
      guards.ts           @guard @guards createGuard
    di/
      container.ts        Container, Scope, ServiceCollection, token(), resolve(), lifetimes, disposal
      decorators.ts       @service @singleton @scoped @transient @inject @maybe @onBoot @onShutdown @every @hosted
    server/
      app.ts              YerdApp: boot validation, routing pipeline, CSRF check, error pages, start/stop, listen
      request-context.ts  RequestContext (the YerdContext), lazy session, CSRF nonce lookup, action token signing
      context.ts          YerdContext type, ALS, currentContext(), setMeta()
      body.ts             json / form / multipart / text / ndjson / bytes with size limits
      cookies.ts          cookie parsing and serializing
      static.ts           static mounts: ETag, 304, precompressed files, immutable caching, mime table
    router/
      trie.ts             segment trie, match(), paramNames()
    respond/
      coerce.ts           the coercion table
      response.ts         res(), redirect(), bare(), YerdResponse, YerdError
      negotiate.ts        @accepts / negotiate() Accept matching
      stream.ts           sse(), ndjson(), event(), heartbeats
    jsx/
      jsx-runtime.ts      jsx, jsxs, Fragment, createElement
      jsx-dev-runtime.ts  jsxDEV
      elements.ts         JSX.IntrinsicElements and attribute types
    render/
      render.ts           tree walk, sync-first, streamed chunks; action forms, raw-text script/style
      attrs.ts            attribute rendering: class/style/boolean/enumerated, URL scheme checks
      escape.ts           escapeHtml, raw(), json()
      dynamic.ts          <Dynamic>
    actions/
      action.ts           @action, bind(), ActionForm, token signing/verification, safeBack
      components.tsx      <Region>, <Scripts>
    attributes/
      attribute.ts        attribute(), the built-in prefetch attribute, client source
    client/
      runtime.ts          the browser runtime's core (one self-contained function, served at /_yerd/runtime.js)
      runtime-*.ts        its chunks (cues, dnd, local), loaded when a page needs them
    live/
      channels.ts         Channels, channel<T>(), ChannelBackend, MemoryBackend
    session/
      session.ts          Session, SessionData, CookieStore, MemoryStore, seal/unseal
      manager.ts          load and commit per request, cookie naming, expiry
    auth/
      index.ts            @toyz/yerd/auth: createAuth, safeNext
      password.ts         hashPassword, verifyPassword
    vite/
      index.ts            @toyz/yerd/vite plugin, see BUILD.md
    log/                  (planned) ILogger, Logger, ConsoleLogger, @instrument, see LOGGING.md
    cli/                  (planned) yerd bin: dev, build, routes, check, secret
    rawlite/              (planned) raw-lite build: client graph compile, import-map hashing, manifest
  test/
    unit/                 vitest: server logic, kit, router, renderer, runtime (happy-dom)
    types/                compile-time type tests
    e2e/                  Playwright: real Chrome against the todo app, dev server and production build
  bench/                  autocannon scenarios, renderer micro benchmark (PERF.md)
  spikes/                 M0 spikes (SPIKES.md)
  examples/
    hello/                routes, DTOs, NDJSON, DI, background services; Vite and raw node
    todo/                 the full app: actions, groups, auth, live updates, prerendering
    tailwind/             Tailwind v4 next to the yerd plugin
  docs/
    PLAN.md
    DYNAMICS.md           client-side interactivity: actions, attributes, sprinkles, islands
    AUTH.md               sessions, auth, CSRF, API tokens
    DECORATORS.md         the decorator kit; how to make your own @user
    LOGGING.md            design only: ILogger, @instrument, spans, YERD_LOG filters
    BUILD.md              user workflow: Vite mode (primary), raw lite, CLI, scaffold
    BUILDER.md            parked: a full hand-written builder, maybe later
    PERF.md               benchmarks, what was optimized, what's left
    SPIKES.md             M0 results
```

## Milestones

Each one ends with something runnable.

**M0. Prove the bits** -- done, see [SPIKES.md](SPIKES.md)
- `npm i -D typescript @types/node vitest happy-dom @playwright/test`, tsconfig, package.json with self-reference exports.
- Spike 1: a `.tsx` file renders `<h1>hi</h1>` through our runtime under plain `node`.
- Spike 2: a decorated class with an `accessor` and `context.metadata` compiles
  and runs on Node 26 with the polyfill. Confirm emitted decorator helpers and
  member-before-class ordering.
- Pick the TypeScript version here. Needs stage 3 decorators + metadata (5.2+).
  If the Go-native compiler (tsgo / TS 7) is current, check its decorator and
  JSX emit before choosing it.
- If self-reference resolution fails, fallback is `"imports"` with `#yerd/*`
  and `jsxImportSource: "#yerd"`.

**Thin slice (done, 2026-10-17):** `@route` + verb decorators, `@layout`,
`createAccessor` with field-type checking, `@param` / `@query` / `@header` /
`@params`, `@body` / `@field` (promise-valued, lazy), DTO classes with `is.*` field decorators, and `@args`, all with `{ transform, validate, required }` options, typed transform pipelines and validators, segment-trie router, coercion table, streaming
renderer with escaping, root + route layouts, `bare()`, `res()`, `redirect()`,
`YerdError`, startup validation (`BootError`), `handle()` / `listen()`,
`discover()` (directory or `import.meta.glob`), minimal Vite plugin (esbuild
decorator transform, dev middleware, server hot reload). `examples/hello` runs
under both `vite` and plain `node`. 65 vitest tests + compile-time type tests.

**DI, lifecycle and streaming (done, 2026-10-17):** container with
singleton / scoped / transient, tokens, `@service` (bare or with
`lifetime` / `provides`), lifetime decorators, `@inject` / `@maybe` (lazy,
transients cached per owner), `app.services(...)` overrides, `app.scope()`,
captive-dependency and unregistered-key boot errors, disposal (scoped per
request, singletons at shutdown, newest first), route lifetimes; `@onBoot`,
`@onShutdown`, `@hosted`, `@every`, `app.start()` / `app.stop()`; graceful
`close()` (stop accepting, end streams, drain, stop background work, dispose)
on SIGINT/SIGTERM; NDJSON and SSE responses, NDJSON request streaming,
`ctx.signal`. The Vite plugin stops the old app on reload. 88 tests.

**Layouts, actions and the todo app (done, 2026-10-17):** `@group` with
nesting, prefixes, layouts and meta; `LayoutProps { children, meta }`,
`setMeta()`, `@noLayout`, `app.errorPage()` (errors and 404s in the root
layout for browsers); tier 1 dynamics from DYNAMICS.md: `@action`,
`bind()`, signed `_yx` tokens, Origin check, JS / no-JS response rules,
`<Region>`, `<Scripts>`, and the client runtime (keyed morph, boosted links,
auto-submit, confirm, live SSE refresh, `data-yx-new`); `resolve()` for DI in
components. `examples/todo` is a full app on all of it: 111 unit tests plus 9
Playwright tests against real Chrome (with and without JavaScript, two-tab
live sync, phone width).

**Production builds and negotiation (done, 2026-10-17):** `app.static()`
(traversal / dotfile safe, ETag + 304, immutable caching for hashed files,
precompressed `.br` / `.gz`, extension allowlists, routes win over files),
`assetUrl()` / `<Stylesheet>` (source paths in dev, Vite manifest in
production), the Vite plugin's `vite build` (client environment with
manifest + server bundle with a generated entry: `node dist/server/server.js`),
`@accepts` and `negotiate()`. The todo app ships a hashed stylesheet; the e2e
suite runs against both the dev server and the production build (18 tests).

**Sessions, guards and auth (done, 2026-10-17):** hand-written cookie
parsing; sessions (`app.sessions()`, AES-256-GCM sealed cookie store or
`MemoryStore`, flash, `regenerate()`, `destroy()`, idle + absolute expiry,
`__Host-` + Secure over HTTPS, secret rotation shared with action tokens);
loom-style named `@guard` on services (resolved through DI per request),
value guards via `createGuard`, `guards` on routes and groups, `@guards`,
`app.guard()`; `app.use()` middleware; `@toyz/yerd/auth`: argon2id
passwords (scrypt hashes still verify, dummy hash for unknown users), `createAuth`
(`@auth.user`, `@auth.maybeUser`, `auth.required` (login redirect for pages,
`yx-location` for scripts, 401 for APIs), `auth.role()`, `login()` with id
rotation, `logout()`, `current()`), `safeNext()`. The todo app is
multi-user: signup/login on an `AuthLayout`, todos scoped per user, live
feeds per user. 146 unit tests, 26 e2e tests (dev + production).

**Prerendering (done, 2026-10-17):** `@prerender`, `app.prerender(dir)`
called by the Vite plugin after `vite build` (a second server entry exports
the app), `.yerd/prerendered.json` so production serves those paths from
files, request-data access throwing during prerender (auth treats the visitor
as signed out, `auth.required` refuses outright), unlocked by a per-run random
token. The todo app prerenders `/about` and `/config.json`.

**Partial prerendering (done, 2026-10-17):** `<Dynamic>` with three render
modes (normal, "fallback" while prerendering, "only" for the runtime's
fill-in request), the runtime fetching deferred parts once per URL. The todo
app's prerendered `/about` ships a skeleton for the account area and fills in
the signed-in user. Also: the `clientTarget` option (on `yerdDecorators()`), and
`runtimeSource()` refusing a downleveled build (the runtime ships via
`fn.toString()` and must not reference compiler helpers). 156 unit tests, 30
e2e tests.

**Channels, noscript, layout opt-out, performance (done, 2026-10-17):**
`<Dynamic noscript={...}>` (shown instead of the skeleton with JS off);
`Channels` + `channel<T>()` (the todo app's live sync runs on it);
`@group(..., { inheritLayouts: false })` and `@layout(X, { inherit: false })`
for areas with their own document; the performance pass in
[PERF.md](PERF.md): sync-first renderer, class-based lazy request context,
one async context per request (`/plain` 80k to 113k req/s, the JSX page
4.5k to 15.5k). 166 unit tests, 31 e2e tests.

**Custom attributes and hardening (done, 2026-10-17):** `attribute(name,
{ render, client })` custom attributes (client halves appended to
`/_yerd/runtime.js`, connected by a MutationObserver, typed through
`CustomAttributes`) and the built-in `prefetch` prop (intent / visible / load,
runtime cache for boosted links, `<link rel=prefetch>` otherwise, JSON
prefetch answered by `yerd.net.fetch()`); see DYNAMICS.md. CSRF: every unsafe
method checked by Sec-Fetch-Site, Origin, then Referer (`csrf`,
`trustedOrigins`, `trustProxy`), action tokens with an expiry (`actionTtl`)
and a per-session nonce hash (unbound for visitors without a session, so
forms never start one), the last `_yx` wins so `formaction={action}`
works inside action forms; see AUTH.md. Auth: `createAuth` session-key
clashes throw, `login(user)`, clear errors without `app.sessions()`;
sessions: `trustProxy`, `secure`, `MemoryStore({ maxSize, sweepInterval })`,
writes after `destroy()` start a fresh session, hardened `safeBack` /
`safeNext`. Guards: stacked decorators run as written, actions run class plus
method guards, `@guard` only counts on the app's own services (base classes
included). Renderer: raw-text `<script>` / `<style>` with `json()`,
enumerated attributes, URL scheme neutralising, style validation, `class` +
`className` merge, typed `IntrinsicElements`, `createElement`. Pipeline:
`YerdResponse` lowercases headers and validates status and header values,
`Vary` appended, errors before the first chunk render the error page, 404 /
405 / 406 / 403 pages inside a request context and DI scope, `OPTIONS *`,
multipart bodies (`ActionForm.file()` / `files()`), per-line NDJSON limit,
no session commit after a crash. Lifecycle: a failed start tears down and
stays failed, `stop()` waits for a pending start and ends streams, no
restart after stop; Vite reloads serialized and triggered by added or
removed files. DI: a singleton's transients disposed with it,
`Container.adopt()`. Channels subscribe immediately. Client runtime: per
element Dynamic refill, live sources closed and reopened with backoff,
concurrent navigations resolve to the last, typed input survives morphs.
Then, the same day: layouts anywhere (variadic `@layout` on routes, groups
and handler methods, `res(node, { layout, inherit })`, de-duplicated chains,
`@layout` / `@guards` on a `@group` class honoured); uploads as `@file` /
`@files` accessors and `is.file()` / `is.files()` DTO fields; and the
runtime's auto mode (`<Scripts auto />`: every same-origin link and form
handled with no attributes, mousedown and pointer-path prefetching, scroll
restored on Back). The todo example runs in auto mode. 262 unit tests, 20 e2e
cases run against both the dev server and the production build.

**M1. Decorator core + router** -- mostly done (thin slice, DI paragraphs
above); not yet: `defineDecorator`, `createWrapper` / `createMeta` /
`compose`, the logging core.
- `YerdKey`, `defineDecorator`, metadata helpers.
- Decorator kit: `createAccessor` (incl. async pre-resolve), `createGuard`,
  `createWrapper`, `createMeta`, `compose`, `YerdContext`.
- `@route`, verb decorators; `@param`, `@query`, `@header` (with `{ transform, validate, required }` options) built on the kit.
- Trie router, ALS context, route classes resolved as scoped.
- Coercion for string / number / object / undefined.
- `listen()` with boot-time validation.
- Logging core: `ILogger` token, `Logger` facade, `ConsoleLogger` (pretty/json),
  `YERD_LOG` filter, request root span. yerd's own boot and request logs use it.
- vitest suite that boots on port 0 and hits it with global `fetch`.

**M2. Rendering** -- done
- Escaping, attrs, void elements, Fragment, async function components.
- Streaming renderer wired into coercion.
- Hand-written `JSX.IntrinsicElements`.

**M3. DI + guards + layouts** -- mostly done; not yet: `@factory`,
`@instrument` / `@logger` and spans, `guards.d.ts`, named routes + `url()`,
bare `@layout` group methods, `@component` class components.
- `@service`, all three lifetimes, `@inject`, `@maybe`, `@factory`, `@onBoot`.
- Programmatic registration + tokens, `provides`, captive dependency check, disposal.
- `@instrument`, `@logger`, span propagation over ALS, redaction, `traceparent`.
- `@guard`, `@guards`, `guards`/`meta` on `@route` and `@group`, string-redirect
  results, DI-resolved guard services, boot checks, optional `guards.d.ts`.
- `@group` with nesting, cascading params, group accessors and `@layout`
  methods, boot-time chain resolution, named routes + `url()`, `bare()`, `@noLayout`.
- `@component` class components with DI.

**M4. Boring-but-necessary** -- mostly done; not yet: `FileStore`, standalone
signed cookies, `@can`, bearer tokens, API keys, `@catches`, the dev stack
page. Auth landed as `createAuth` (`@auth.user`, `auth.required`,
`auth.role()`, `auth.login(user)`) rather than `UserResolver` / `@user` /
`@authenticated` / `@roles`.
- `@body` with json / text / urlencoded parsers and size limits.
- `@cookie`, signed cookies via HMAC, `@header`.
- Sessions: `@session`, `CookieStore` / `MemoryStore` / `FileStore`, flash,
  session id rotation on login, secret rotation ([AUTH.md](AUTH.md)).
- Auth: `UserResolver`, `@user`, `@authenticated`, `@roles`, `@can`, `Auth.login`
  / `logout`, `hashPassword`, `safeNext`, bearer tokens, API keys.
- `@catches`, `YerdError`, dev stack page.
- Static files with ETag/304.
- `discover()`.

**M5. Tooling: CLI, Vite, scaffold** (full design in [BUILD.md](BUILD.md)) --
the Vite plugin (dev, server reload, build, prerender) and `import.meta.glob`
discovery are done, and `examples/todo` runs on Vite; not yet: the `yerd`
bin, raw-lite `dev` / `build`, the scaffold.
- `@toyz/yerd/vite` plugin, server side, **first**: dev middleware, SSR module
  runner, registry reset for server HMR, errors in the overlay,
  esbuild decorator transform (Oxc can't, see SPIKES.md), SSR build. (Island
  bundling and the manifest land with M6.)
- `discover()` accepting `import.meta.glob` results.
- `yerd` bin: `routes`, `check`, `secret`, plus raw-lite `dev` / `build`
  (tsc + supervised restart).
- `npm create @toyz/yerd` scaffold, Vite by default, `--raw` for raw lite.
- `examples/todo` on Vite; one small example on raw lite to keep it tested.

**M6. Dynamics** (full design in [DYNAMICS.md](DYNAMICS.md)) -- tier 1
(actions) and custom attributes are done; tiers 2 and 3 and raw-lite islands
are not.
- Tier 1, actions: `@action` methods, `<form action={this.add}>`, signed bound
  args, works with no JS, morphs `<Region>`s with JS.
- Tier 2, sprinkles: `onClick={($) => ...}` in server TSX, shipped via
  `fn.toString()` of what tsc already compiled.
- Tier 3, islands: `@island` classes with `@state`, decorator twins, carried
  values; the server-leak check on the client graph.
- Vite mode for islands (primary): client environment build, manifest-based
  `data-src`, modulepreload + CSS links, island HMR, build-time leak check.
- Raw lite for islands: client graph compiled at ES2016, hashing via import-map
  remapping, manifest, modulepreload.

**M7. Stretch goals (pure bit)**
- **The yerd builder** ([BUILDER.md](BUILDER.md)), only if raw lite turns out
  to be fun: CSS/asset transformers, island HMR over SSE, `yerd bundle`,
  `yerd minify`.
- **Auth extras**: OAuth/OIDC with PKCE, passkeys with hand-parsed CBOR, TOTP.
- **Kit showcase**: `@cache("1h")`, `@rateLimit(10)`, `@timed`,
  `@transaction` as examples and tests for the decorator kit.
- **Multipart** parsing by hand. (Done differently: multipart bodies are
  parsed by Node's built-in `FormData`, so no hand-rolled parser.)
- **`<Head>` hoisting** into the layout.
- **Benchmarks** against express/fastify with `autocannon` (devDep), mostly to
  have a number to laugh at. (Benchmarks against bare `node:http` exist, see
  [PERF.md](PERF.md); express/fastify not yet.)

## Scripts (package.json)

| Script | Does |
|--------|------|
| `build` | `tsc -p tsconfig.build.json`: the published `dist/` |
| `check` | `tsc -p . --noEmit`: type-check everything, type tests included |
| `test` | `vitest run` |
| `e2e` | `playwright test`: the todo app on the dev server and a production build |
| `dev` / `example` | `vite` on `examples/hello` |
| `example:raw` | `examples/hello` without Vite: tsc, then plain `node` |
| `todo` / `todo:raw` | `examples/todo` under Vite / tsc + node |
| `todo:build` / `todo:start` | production build of the todo app, then `node examples/todo/dist/server/server.js` |
| `tailwind` | `vite` on `examples/tailwind` |
| `screenshots` | `node test/e2e/screenshots.mjs` |
| `bench` | build `bench/` with tsc, run `bench/run.mjs` ([PERF.md](PERF.md)) |

## Testing

- **Unit (vitest).** Router, coercion, decorator kit, DI lifetimes, sessions,
  crypto, logging, renderer. DOM-side code (morph, trace, client renderer) runs
  under happy-dom, so loom's ~87 morph/trace/hydration cases port almost as-is.
- **Integration (vitest).** Boot yerd on port 0, hit it with global `fetch`.
- **E2E (Playwright).** Anything that depends on **tsc's actual output** or a real
  browser runs here, against `dist/`:
  - islands loaded through the native import map
  - the `AsyncLocalStorage` polyfill with the ES2016 client target
  - sprinkles extracted via `fn.toString()`
  - `@instrument` parameter names parsed from compiled source
  - actions with and without JS, CSRF, view transitions

  vitest transforms code with esbuild, not tsc, so tests of tsc-shaped behaviour
  would be testing the wrong compiler. Those belong in e2e.
- AUTH.md and LOGGING.md list the security and logging tests that must exist;
  they're vitest unless marked browser.

## Publishing

Published to npm as **`@toyz/yerd`** (same scope as `@toyz/loom`). Subpath
exports today: `@toyz/yerd` (server), `@toyz/yerd/jsx-runtime`,
`@toyz/yerd/jsx-dev-runtime`, `@toyz/yerd/vite`, `@toyz/yerd/auth`,
`@toyz/yerd/client` (types for client modules). Ships
`dist/` (tsc output of `tsconfig.build.json`, with `.d.ts` files), `LICENSE`
and `README.md`, with zero runtime `dependencies`; requires Node 24.7 or later.
Apps set `"jsxImportSource": "@toyz/yerd"`.

Planned: `@toyz/yerd/kit` and `@toyz/yerd/async-context` subpaths, a `yerd`
bin, `vite` / `esbuild` / `typescript` as optional peer dependencies for the
Vite plugin, and the scaffold as a separate package, `@toyz/create-yerd`, so
`npm create @toyz/yerd` works.

## Non-goals

- Functional `app.get()` routing. Decorators or nothing.
- A client framework or a virtual DOM.
- Shipping a bundler. Vite mode uses the app's own Vite; raw lite uses only tsc
  (see BUILD.md). yerd depends on neither at runtime.
- Being fast. Being correct is a nice-to-have. Being funny is required.
- HTTP/2, TLS, websockets (maybe later via the `upgrade` event).

## Open questions

1. **Does yerd share code with loom?** Plan says no: copy the ideas, not the
   package, since loom is a dep and it's DOM-targeted. `YerdKey`,
   `defineDecorator`, morph and trace get rewritten.
2. **Node's native type stripping:** Node 26 runs `.ts` but not `.tsx`, and
   doesn't run decorators through tsc's transform, so tsc stays as the build step.

Resolved: no runtime deps, but devDependencies (types, vitest, happy-dom,
Playwright, benchmarks) are fine. Lifetimes are the user's
choice, C# style (see Lifetimes).
