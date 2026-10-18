# yerd dynamics: the front end writes its own JS

Server-rendered yerd pages get interactivity without a bundler, without a
client framework, and without the user writing a separate front end. The JS
that runs in the browser is one of:

1. a small runtime we hand-write (`src/client/runtime.ts`, one self-contained
   function served as `/_yerd/runtime.js`), compiled like everything else
2. code the user already wrote inside their TSX, which tsc already compiled,
   which we pull back out at runtime
3. the user's own component modules, served to the browser exactly as tsc
   emitted them, resolved with a native import map

Still zero runtime deps. The browser is the platform too.

Three tiers, each optional, each building on the last, plus custom
attributes in between.

| Tier | Name       | User writes                          | Browser gets                          | Works without JS |
|------|------------|--------------------------------------|---------------------------------------|------------------|
| 1    | actions    | `@action` methods, `<form action={...}>` | runtime intercepts submit, swaps HTML | yes              |
| 1.5  | attributes | `attribute(name, { render, client })`, `prefetch` | the client half's source, inside the runtime script | the server half renders; behaviour needs JS |
| 2    | sprinkles  | `onClick={($) => ...}` in server TSX | the handler's own compiled source     | degrades         |
| 3    | islands    | `@island` class components with `@state` | the component's module, as emitted by tsc | SSR only    |

**Status (2026-10-17):** tiers 1 and 1.5 are built. Tiers 2 and 3, the
loom-style morph extras and the browser AsyncLocalStorage polyfill below are
still design.

---

## Tier 1: actions (forms that are secretly interactive)

```tsx
@route("/todos")
@layout(RootLayout)
export class Todos {
  @inject(TodoRepo) accessor repo!: TodoRepo;

  @get list() {
    return (
      <main>
        <Region id="todos">
          <TodoList todos={this.repo.all()} toggle={this.toggle} />
        </Region>
        <form action={this.add}>
          <input name="title" required />
          <button>add</button>
        </form>
      </main>
    );
  }

  @action
  add(_: {}, form: ActionForm) {
    this.repo.add(form.string("title"));
    return <Region id="todos"><TodoList todos={this.repo.all()} toggle={this.toggle} /></Region>;
  }

  @action
  toggle({ id }: { id: number }) {
    this.repo.toggle(id);
    return <Region id="todos"><TodoList todos={this.repo.all()} toggle={this.toggle} /></Region>;
  }
}

function TodoList({ todos, toggle }: { todos: Todo[]; toggle: Action<{ id: number }> }) {
  return (
    <ul>
      {todos.map((t) => (
        <li>
          <form action={bind(toggle, { id: t.id })}>   {/* typed: { id: number } */}
            <button>{t.done ? "undo" : "done"}</button> {t.title}
          </form>
        </li>
      ))}
    </ul>
  );
}
```

### How it works

**Rendering a form.** `action={this.add}` passes a function into JSX. The
renderer looks it up in the action registry (`@action` puts the method there at
define time, keyed by function identity) and emits:

```html
<form action="/todos" method="post" data-yx>
  <input type="hidden" name="_yx" value="<payload>.<hmac>">
  ...
</form>
```

The action posts to the **route's own path** (plus the page's query string
when it's the page being rendered), so `@param` and `@query` accessors resolve
exactly like they do for `@get`. `_yx` is base64url JSON
`{ c, a, p, e?, s? }` (route class, action name, bound args, expiry, session
nonce tag), then `.`, then an HMAC-SHA256 of it with the app secret
(`node:crypto`), so the client can't swap args or call a different action.
See [Action tokens](#action-tokens-and-csrf) below.

**`<button formaction={action}>`** does the same for one submit button: it
posts to the action's route and submits the token as its own `name="_yx"`
value. It works inside `<form action={otherAction}>` too: the submitter's `_yx`
comes after the form's hidden one, and the server takes the last. Only submit
buttons accept an action, and they can't have their own `name` or `value`.

**`bind(action, args)`** is typed `bind<A>(fn: (args: A, form: ActionForm) => unknown, args: A)`,
so the args object is checked against the action method's first parameter. TC39
decorators can't change a method's type, so `bind()` is a plain function instead
of `this.toggle.with(...)`.

**Without JS:** the browser does a normal POST. The router sees `_yx`, verifies
the token, makes a route instance, runs the class's guards and the action's own
guards, calls the action. If it returns JSX (or nothing), the server answers
`303` back to the page the form was on (the same-host `Referer`, else the
route's path), post/redirect/get. If it returns a redirect, a number or a
`res()`, that goes through unchanged.

**With JS:** the runtime intercepts `submit` on `form[data-yx]`, sends it with
`fetch` plus header `yx: 1` (URL-encoded, or multipart when the form has files
or says `enctype="multipart/form-data"`), and the server answers with the
action's JSX rendered **bare** (no layouts). The runtime parses it with
`DOMParser`, finds every `[data-yx-region]` in the response, and morphs the
matching region on the page. Return several `<Region>`s and several parts of
the page update (out-of-band updates, free). An action that returns nothing
gets a `204`, and the runtime refreshes the page's regions; a redirect comes
back as a `yx-location` header and the runtime navigates there (boosted when
same-origin, a real navigation otherwise). Uploaded files reach the action as
`form.file(name)` / `form.files(name)`.

**Runtime extras**, all attributes, all optional:
- `aria-busy` set on the form while in flight; its enabled submit buttons are
  disabled and marked `data-yx-disabled` (only those are re-enabled after)
- `data-yx-confirm="sure?"` on a form
- `data-yx-reset` to clear the form after success
- `data-yx-submit` on an input submits its form on change (checkboxes)
- `data-yx-error` inside a form: where the server's error message goes (a
  400 with DTO issues shows the issue messages)
- `data-yx-boost` on a link or any ancestor: fetch the full page (header
  `yx-boost: 1`), morph `<body>`, `history.pushState`; Back/Forward reloads
  entries the runtime made
- `data-yx-live="/events"`: an `EventSource`; every message refreshes the
  page's regions
- `data-yx-new` is set on elements a morph inserted, for entrance animations
- `data-yx-keep` on an element: morph leaves it and its children alone
- a form inside a `<details>` closes it on success
- server can send `yx-location: /somewhere` to make the client navigate

**Runtime behaviour worth knowing:**
- Forms with a `target` (other than `_self`) or `method="dialog"` are left to
  the browser. `method="get"` forms do a boosted load of the URL with the
  fields as the query.
- Same-page hash links aren't fetched; the browser just scrolls.
- Navigations race safely: a newer one aborts the older, and only the last
  one's response is used. A cross-origin `yx-location` or redirect falls back
  to a real navigation.
- Morphs keep what the user typed in a text input or textarea unless the
  server's value for it changed, and never overwrite the focused one.
  Checkboxes and radios take the server's state; file inputs are never
  touched.
- `<Dynamic>` skeletons are filled per element after every load and morph, so
  one brought back by Back navigation or a refresh is filled again.
- Live `EventSource`s are closed when their element leaves the page. A dropped
  connection that comes back triggers a refresh (messages may have been
  missed); one the browser gave up on is reopened with backoff (1s doubling to
  30s).
- The runtime runs once per page, guarded by `Symbol.for("yerd.runtime")` on
  `window` (an element with `id="yerd"` can't fake it).

**Morph** is covered in [Morph and patch](#morph-and-patch-ported-from-loom)
below. Region swaps, `data-yx-boost` page loads and (later) island re-renders
all go through the same `morph()`.

### Action tokens and CSRF

Two layers, both on by default:

- **Cross-site check, every unsafe method.** Before routing, any POST, PUT,
  PATCH or DELETE that looks cross-site is refused with 403: judged by
  `Sec-Fetch-Site`, else `Origin`, else `Referer`, compared with the `Host`.
  Requests with none of these (curl, server-to-server) pass. See
  [AUTH.md](AUTH.md#security-model) for the details and options.
- **Signed, expiring, session-bound tokens.** The `_yx` token is HMAC-signed,
  carries an expiry (`actionTtl`, default one day) and, when sessions are on,
  a hash of a per-session nonce, so a form rendered for one visitor can't be
  replayed from another session. Prerendered pages' tokens carry neither
  (they're built for nobody); they rely on the signature and the cross-site
  check. An expired or foreign token is a 403 asking the user to reload.

---

## Tier 1.5: custom attributes and prefetch

Behaviour attached to any element by an attribute instead of a custom tag,
after loom's `@attribute` controllers. One definition, two optional halves:

```tsx
// src/attributes.ts -- imported by the server (a layout, a component)
import { attribute } from "@toyz/yerd";

export const tooltip = attribute("tooltip", {
  // server half: what the JSX prop renders as
  render: (text: string) => ({ tooltip: text, "aria-label": text }),
  // client half: runs in the browser for each element that has the attribute
  client(el, value, yerd) {
    el.title = value;
    return { update(next) { el.title = next; }, disconnect() { el.title = ""; } };
  },
});

// JSX typing: declare the prop once
declare module "@toyz/yerd" {
  interface CustomAttributes { tooltip?: string }
}

<button tooltip="Delete this todo">x</button>
```

**Server half.** `render(value, { tag, props })` returns the attributes to
write (or `null` for none). Its output is rendered as plain attributes, so it
may write its own name. Without `render`, strings and booleans render as usual
and objects as JSON. Names are lowercase words joined by dashes; defining one
twice, or one with a built-in's name, throws.

**Client half.** Shipped as source: each client half's `fn.toString()` is
appended to `/_yerd/runtime.js` as a `yerd.attribute(name, ...)` call. So,
like the runtime, it must be self-contained: no imports, nothing from the
enclosing module; everything comes in through `(el, value, yerd)`. Function
expressions, arrows and method shorthand (`client(el) { ... }`) all work.
Source that uses compiler helpers (async lowered below ES2017, `keepNames`) is
refused. It returns nothing, a cleanup function, or
`{ update(value), disconnect() }`; errors are logged, not thrown.

**Lifecycle.** One `MutationObserver` on the document (children, subtree, and
the registered attribute names) drives every client half: **connect** when an
element with the attribute appears (first load, a morph, a boost, the
attribute being added), **update** when its value changes, **disconnect** when
the attribute is removed or the element leaves the document. Elements a keyed
morph moves (removed and re-added in one batch) stay connected.

**The `yerd` API** (the third argument, also `window.yerd`, typed `YerdClient`):

| `yerd.`                  | Does                                                  |
|--------------------------|-------------------------------------------------------|
| `morph(from, to)`        | morph `to` into `from` in place                       |
| `apply(html)`            | morph every Region in an HTML string into the page; returns how many matched |
| `refresh()`              | re-fetch the current page and morph its Regions       |
| `load(url, push)`        | boosted navigation to a same-origin URL               |
| `prefetch(url, as?)`     | warm the runtime cache with a page (`"page"`) or a JSON response (`"json"`) |
| `fetch(url, init?)`      | `fetch()`, answered from a fresh JSON prefetch of the same URL when there is one (GETs only) |
| `attribute(name, setup)` | register a client half at runtime                     |

**Dev.** The Vite plugin resets user attributes on every reload, with the
route, service and guard registries, so editing one isn't "defined twice".
Built-ins survive the reset.

### `prefetch`

A built-in attribute that warms the next page before the click:

```tsx
<a href="/todos" prefetch>Todos</a>                 {/* "intent", the default */}
<a href="/reports" prefetch="visible">Reports</a>
<a href="/" prefetch="load">Home</a>
<section prefetch={{ url: "/api/stats", as: "json", on: "visible" }}>...</section>
```

- **Modes.** `intent`: a short hover (65 ms, so sweeping the pointer across
  links doesn't fetch them all), focus or touch. `visible`: when it scrolls
  into view (`IntersectionObserver`). `load`: right away.
- **Rendering.** Writes `data-yx-prefetch` (the mode), plus
  `data-yx-prefetch-url` / `data-yx-prefetch-as` when given. It needs an
  `<a>` / `<area>` with an `href`, or `{ url }`; an unknown mode throws at
  render. `prefetch={false}` writes nothing.
- **Boosted links** (inside `data-yx-boost`): the runtime fetches the page
  into its own cache and the boosted navigation uses it. Entries live 15
  seconds, a page is used once (the next visit should see newer data), at most
  30 are kept, and the cache is cleared after every successful form submit and
  every live message.
- **Ordinary links** get a `<link rel="prefetch">` (once per URL), which the
  browser's own navigation picks up.
- **JSON:** `{ url, as: "json" }` on any element fetches with
  `accept: application/json` into the cache, and `yerd.net.fetch(url)` answers
  from it while it's fresh.
- Every runtime prefetch carries `yx-prefetch: 1`, is a same-origin GET (so
  handlers must already be free of side effects), and is skipped when
  `navigator.connection` reports Save-Data or a 2G connection.
- A `mousedown` / `touchstart` on a boosted link starts its fetch, roughly
  100 ms before the click lands; the click then uses it.

### Auto mode: no attributes at all

```tsx
<Scripts auto />   // in the root layout's <head>
```

The runtime stops waiting for `data-yx-*` and takes the page over:

- **Every link** to a same-origin page is boosted: fetched, `<body>` morphed,
  URL pushed, scroll saved in the history entry and restored on Back. Left
  to the browser: other origins, `target`, `download`, `rel="external"`,
  file-looking paths (`/report.pdf`, `/data.json`), and anything inside
  `data-yx-boost="false"`.
- **Every form** posting to the same origin goes through fetch. Action forms
  work as before. A plain form (an ordinary `@post` route) has its redirects
  followed, and the page it lands on is morphed in with its URL, error pages
  included. So a plain form-and-redirect app gets in-place updates without
  Regions or attributes. GET forms do a boosted navigation.
- **Pointer-path prefetch.** With a mouse, the runtime keeps the last few
  pointer samples, and on each animation frame (only while the pointer moves)
  works out its velocity. If the pointer is slowing down (aiming, not
  sweeping past), it walks the path the pointer would cover in the next
  250 ms with `elementFromPoint` and prefetches the first boostable link on
  it. Usually the page is in the cache before the cursor arrives. Same cache
  rules as `prefetch` above.

Nothing on the server changes: without JavaScript every link and form still
works the ordinary way.

---

## Tier 2: sprinkles (your handler, extracted from your server code)

Event handlers written directly in server TSX:

```tsx
<details>
  <summary onClick={($) => $.toggle($.el.parentElement!, "open")}>more</summary>
  <p>hidden stuff</p>
</details>

<input
  name="q"
  data={{ min: 3 }}
  onInput={($, e) => {
    const q = (e.target as HTMLInputElement).value;
    if (q.length >= $.data.min) $.submit("#search");
  }}
/>
```

### How it works

tsc already compiled that arrow function to JS, because it's sitting in a `.tsx`
file. At render time the function is just a value, so the renderer calls
`fn.toString()` and gets the compiled source back. Then:

1. hash the source, dedupe per page
2. emit `data-yx-on="click:h3f2a"` on the element
3. append one `<script type="module">` to the end of `<body>` with
   `yx.h.h3f2a = ($, e) => ...` for every handler used on the page
4. the runtime uses event delegation on `document`, so swapped-in regions keep working

**The `$` argument** is the only bridge into the handler, typed in
`JSX.IntrinsicElements` as `(e: Event, $: Yx) => void`:

| `$.`                    | Does                                               |
|-------------------------|----------------------------------------------------|
| `el`                    | the element the handler is on                      |
| `data`                  | JSON from the element's `data={...}` prop          |
| `toggle(el, cls)`       | class toggle                                       |
| `submit(sel)`           | submit a form (goes through tier 1 if it's an action form) |
| `call(action, args?)`   | invoke a bound action via fetch, morph the result  |
| `q(sel)` `qa(sel)`      | scoped querySelector                               |
| `emit(name, detail)`    | CustomEvent                                        |

**Rules, enforced as much as a shitpost can:**
- No closures. The handler is shipped as source, so outer variables don't exist
  in the browser. Pass data through `data={...}`. In dev, the runtime catches
  `ReferenceError` from a handler and logs the handler source plus the element,
  so the mistake is obvious.
- JSX inside a handler compiles to `_jsx(...)`. The sprinkle scope defines
  `_jsx`, `_jsxs` and `_Fragment` from the client runtime, so that works too.
- Handlers only become sprinkles on **intrinsic** elements during **server**
  render. On islands (tier 3) they're real functions with real closures.

---

## Tier 3: islands (the same file runs on both sides)

```tsx
// src/components/counter.tsx
import { island, state, prop, type Action } from "@toyz/yerd/client"; // re-exports the isomorphic @toyz/yerd/kit

@island
export class Counter {
  @prop accessor start = 0;
  @prop accessor onSave!: Action<{ n: number }>;
  @state accessor count = 0;

  init() { this.count = this.start; }

  render() {
    return (
      <div>
        <button onClick={() => this.count++}>{this.count}</button>
        <button onClick={() => this.onSave({ n: this.count })}>save</button>
      </div>
    );
  }
}
```

```tsx
// used from a route like any component
<Counter start={5} onSave={bind(this.save, {})} />
```

### How it works

**Server side.** The island renders to HTML like any class component, wrapped in:

```html
<yerd-island data-src="/_yerd/m/components/counter.js" data-name="Counter"
             data-props='{"start":5,"onSave":{"$a":"save..sig"}}'
             data-carry='{}'>
  <div><button>5</button>...</div>
</yerd-island>
```

`data-carry` holds server-resolved values for carried decorators like a
projected `@user` (see [DECORATORS.md](DECORATORS.md#one-kit-both-sides)). Empty
here since `Counter` uses none.

**Client side.** The runtime finds `yerd-island` elements (on load and after
every morph), `import()`s `data-src`, instantiates the class, assigns props,
renders to DOM with the client renderer, and morphs that over the server HTML.

**Hydration is just morph.** Same trick as loom's declarative shadow DOM
hydration: the first client render is morphed against the server-rendered
children instead of replacing them. When server and client output match, the
diff makes **zero DOM mutations**, and the morph's only real work is attaching
event listeners and recording closure bindings. No separate hydration algorithm,
no hydration mismatch errors, a mismatch just gets patched.

**Updates use loom's three tiers.** `@state` is a versioned reactive cell. Each
render runs under a trace that records which cells were read. On the next
`@state` write (batched by microtask):

1. **skip**: no traced cell changed version, do nothing
2. **fast patch**: every changed cell has closure bindings, so run just those
   patchers and touch only their DOM nodes. No `render()`, no morph.
3. **full**: `render()` again, morph the result in

Closure bindings are loom's `{() => this.count}` text children and zero-arity
props like `class={() => this.open ? "on" : ""}`. The JSX runtime runs them in a
sub-trace, and if they read any cells, links those cells to the text node or
attribute. Patchers re-trace when they run, so a conditional binding that
switches branches picks up its new dependencies (loom's `trace-retrace` fix).

On the server, the same closure child is just called once and printed. Same
source, so islands written with bindings get fine-grained updates in the
browser and plain HTML on the server.

Event handlers here are real functions with real closures, because this code is
actually running in the browser.

**How the island module reaches the browser** depends on the build mode
([BUILD.md](BUILD.md)). In Vite mode (the default), Vite bundles islands and
`data-src` comes from its manifest. In raw lite, the browser imports the file
tsc emitted, hashed but otherwise untouched, through a native import map.
Everything below about decorator twins and carried values is the same in both.

In raw lite the page includes a native import map:

```html
<script type="importmap">
{ "imports": {
    "@toyz/yerd/client":        "/_yerd/client/index.js",
    "@toyz/yerd/kit":           "/_yerd/kit/index.js",
    "@toyz/yerd/jsx-runtime":   "/_yerd/client/jsx-runtime.js",
    "@toyz/yerd/async-context": "/_yerd/async/browser.js",
    "@toyz/yerd":               "/_yerd/client/nope.js"
} }
</script>
```

`nope.js` throws `"server-only yerd imported from an island"`.

**Same decorators, two implementations.** `@toyz/yerd/client` uses package `exports`
conditions:

```json
"./client": { "node": "./dist/client/server.js", "default": "./dist/client/index.js" }
```

Node picks `server.js`: `@island` registers the class for SSR and `@state` is a
plain field. The browser goes through the import map to `index.js`: `@island`
registers for hydration and `@state` is reactive. One source file, two meanings.

**How the server finds an island's file.** A class decorator doesn't know what
module it's in. Two options:
- explicit: `@island(import.meta.url)`
- magic (default): `@island` reads V8 structured call sites
  (`Error.prepareStackTrace` + `getFileName()`) at decoration time to get the
  defining module's `file://` URL. Same energy as loom. Explicit form exists as
  the escape hatch.

**Actions as props.** A `bind()`ed action serializes to `{ "$a": "<signed>" }` in
`data-props`. The client turns it back into an async function that POSTs to the
route with `yx: 1` and returns the response (JSON if the action returned an
object, morphs regions if it returned `<Region>`s). That's RPC from an island to a
route method, typed through `Action<A>`, no client code touching server code.

**Props must be JSON.** `@prop` on islands is typed
`<This, V extends Json | Action<any>>`, so passing a `Date`, a class instance or
a function that isn't an action is a compile error.

### Security: never serve server code

The browser can only import files from the **client graph**, computed at boot:

1. start from every `@island` module
2. scan each emitted `.js` for static and dynamic import specifiers (small
   hand-written scanner over the tsc output, not a regex soup)
3. relative imports join the graph; bare specifiers must be in the import map
4. hitting `node:*` or bare `@toyz/yerd` means **boot fails**, printing the chain:
   `components/counter.js -> lib/db.js -> node:fs`

`/_yerd/m/*` serves only files in that set. Everything else in `dist/` returns
404, so server source, which may contain secrets or internal logic, can't be
fetched by guessing paths. Source maps for client graph files are served only in
dev.

**The client build is derived, never configured.** The user has one
`tsconfig.json` and writes islands anywhere. yerd finds the client graph itself
(from `@island` registrations plus the import scan above) and compiles it a
second time through the TypeScript compiler API, using the app's own
`typescript`, with the settings the browser needs:

- `target: "ES2016"`, so the AsyncLocalStorage polyfill can follow context
  across `await` (see [AsyncLocalStorage in the browser](#asynclocalstorage-in-the-browser-polyfill))
- output to `dist/client/`, which is what `/_yerd/m/*` serves

In raw lite `yerd build` and `yerd dev` do this; in Vite mode the plugin does
it. No second tsconfig, no project references, no naming convention.

**Types.** Island code should not see Node types, so `process.env.SECRET` in an
island is an error and not a runtime surprise. yerd runs a type-check pass over
just the client graph with `lib: ["ES2022", "DOM"]` and `types: []` (no
`@types/node`) as part of `yerd build`, `yerd check`, and the Vite plugin's
`typecheck` option. Errors point at the island file and line. Still no extra
config for the user.

---

## Morph and patch (ported from loom)

Loom's `morph.ts` and `trace.ts` are the reference. yerd rewrites them (no
shared code, see PLAN.md open question 1) but keeps the behaviour, including the edge cases
loom already fixed. Loom's test cases for both become yerd's spec.

### Morph

`morph(root, next)` patches the live children of `root` to match `next` in place.

**Built today** (in `src/client/runtime.ts`): a single keyed pass, children
matched by `data-key` or `id`; attributes patched (an `open` attribute the
user set on `<details>` / `<dialog>` is kept); `data-yx-keep` subtrees
skipped; form state synced as described under tier 1; `data-yx-new` on
inserted elements. The rest of this section (ownership expandos, the event
proxy, pooled maps, hooks, view transitions) is the loom port still to come.

- **Single pass, keyed.** One scan of the old children builds a key index and a
  keep set. Then a walk of the new children: a keyed match is moved into
  position and morphed, an unkeyed node is morphed against the next free old
  node if tag and node type match, otherwise inserted. Leftovers are removed.
- **Keys.** JSX `key={...}` renders as a `data-key` attribute on the server, so
  server-rendered fragments from actions reconcile by key too, not only island
  renders. Mirrored in an `__yxKey` expando to skip `getAttribute` in the hot loop.
- **`data-yx-keep`** skips a node entirely: third-party widgets, canvases, anything
  imperative.
- **Attribute ownership.** Morph only removes attributes the template declared,
  tracked in `__yxAttrs`. Browser-owned state survives unrelated re-renders: a
  `<details>` the user opened keeps `open`, a `<dialog>` from `showModal()` stays
  open. (Loom learned this one from stranded modals.)
- **JS property ownership.** `value`, `checked`, `selected` are patched only if
  the template set them (`__yxProps`), so morphing never wipes what the user
  typed. When the template stops setting a property, its value from before the
  template first set it is put back (`__yxPropPrior`). Form properties are never
  reset to `undefined`, since that would show the string "undefined".
- **Events through one proxy.** Each element gets at most one real
  `addEventListener` per event type, pointed at a shared proxy that looks up
  the current handler in an `__yxEvents` map. Re-renders swap the map entry,
  not the listener, so there's no listener churn.
- **`raw()` content** is set via `innerHTML` when changed and never recursed into.
- **Snapshot `childNodes`** before recursing, because it's a live NodeList and
  moving nodes out of it mid-iteration skips every other child.
- **Pooled key maps**, no per-morph allocation for the common case.
- **Morph hooks** for opt-in features that need to carry an expando from the new
  element to the live one.

**Fixing loom's hydration gap.** Server-rendered HTML has no `__yxAttrs` record,
so on its first morph loom treats the new tree as the authority and removes
anything not in it, including browser-set attributes. yerd closes that gap: at
boot, before any user input, the runtime walks each `[data-yx-region]` and each
island root and records `__yxAttrs = el.getAttributeNames()`. From then on,
ownership tracking works on server-rendered DOM too, so a user-opened
`<details>` inside a region survives an action swap.

**View transitions (planned).** A region or boost with `data-yx-transition` runs its morph
inside `document.startViewTransition()`, the same wrapper hook loom uses for
`@viewTransition`.

### Trace (islands only)

- `@state` cells carry a version number. Reading one during a trace adds it to
  the active dependency set.
- Each island keeps `{ deps, versions, bindings }` from its last render.
- Sub-traces (a stack) isolate each closure binding's dependencies and merge
  them back into the parent, so the island still counts as depending on them.
- The `bindings` reverse index is kept consistent on rebind: an emptied entry is
  deleted rather than left empty, otherwise "every dirty cell has a binding"
  would be true while nothing actually patched.
- Sets, maps and version snapshots are pooled. Steady-state fast patches allocate
  nothing.

Tier 1 actions and tier 2 sprinkles don't use the trace. Their updates come
from the server as HTML and always go through morph.

### Testing it

- **Morph and trace: vitest + happy-dom**, same setup as loom, so loom's ~87
  morph, trace and hydration cases port almost as-is and become the spec.
- **Real browser: Playwright** against a booted yerd serving tsc's `dist/`, for
  what happy-dom can't vouch for: native import maps, `startViewTransition`,
  focus and caret preservation, the async-context polyfill under the ES2016
  target, and island hydration producing zero DOM mutations (checked with a
  `MutationObserver` in the page).
- See PLAN.md "Testing" for why tsc-output-dependent tests live in Playwright
  rather than vitest.

---

## AsyncLocalStorage in the browser (polyfill)

Logging spans, the kit's `currentContext()` and island DI scopes all read
"the current context" after an `await`. Node has `AsyncLocalStorage`. Browsers
don't (TC39 `AsyncContext` isn't shipped yet), so yerd polyfills it, and every
part of yerd imports one isomorphic module:

```json
"./async-context": { "node": "./dist/async/node.js", "default": "./dist/async/browser.js" }
```

`node.js` re-exports `AsyncLocalStorage` from `node:async_hooks`. `browser.js` is
the polyfill, with the same API subset: `new AsyncLocalStorage()`, `run(store, fn)`,
`getStore()`, `exit(fn)`, `enterWith(store)`, `AsyncLocalStorage.bind(fn)`,
`AsyncLocalStorage.snapshot()`.

### How the polyfill works

**1. Synchronous part (trivial).** One module-level "current frame": an
immutable map from each `AsyncLocalStorage` instance to its store. `run()` swaps
in a new frame with one entry changed, calls `fn`, restores the old frame in
`finally`. `getStore()` is a map lookup. Same semantics as
`AsyncContext.Variable`: a snapshot covers every variable at once.

**2. Callback APIs (patching).** Capture the current frame when a callback is
**registered**, restore it around the callback when it **runs**:
`Promise.prototype.then` (and so `catch`/`finally`), `setTimeout`, `setInterval`,
`queueMicrotask`, `requestAnimationFrame`, `requestIdleCallback`,
`EventTarget.prototype.addEventListener`, `MessagePort.onmessage`,
`MutationObserver`/`ResizeObserver`/`IntersectionObserver` callbacks.
If the frame is empty at registration, the callback isn't wrapped at all, so
code outside any context pays nothing. About 80 lines.

**3. `await` (the tsc trick).** Native `await` doesn't call the patchable
`Promise.prototype.then`; the engine resumes the function internally, so no
patch can see it. That's why zone.js needs async/await downleveled, and why a
plain polyfill can't fix this part.

yerd controls the compiler, so: the client graph (islands, `@toyz/yerd/client`, the
runtime) compiles with `target: "ES2016"`, one version before native async.
tsc then emits every `async` function as a generator driven by its `__awaiter`
helper, and each `await` becomes a real `.then(...)` call made while the
context is still active. The patched `then` captures the frame and restores it
on resume. Context now survives `await` in all island code, without the
engine's help.

### Costs and limits (written down, not hidden)

- **Output size and speed.** ES2016 target means `async` becomes generators, and
  `accessor` / `#private` fields become WeakMap-based helpers. Bigger files,
  somewhat slower async. The M6 spike measures it on the todo example; if it's
  bad, only modules that actually use context get the ES2016 target.
- **Code tsc didn't compile** (anything not in the client graph, browser
  extensions, inline sprinkles that use `await`) uses native `await` and loses
  context after it. Sprinkles get their `$` explicitly, so they don't need it.
- **Patching `Promise.prototype.then` is global.** Wrapping only happens with an
  active context, and wrapped callbacks restore the previous frame even if they
  throw. Tests check that two interleaved async flows never see each other's
  stores.
- **When `AsyncContext` ships in browsers**, `browser.js` becomes a thin wrapper
  over `AsyncContext.Variable`, the patches are dropped, and the client target
  goes back to ES2022. Feature-detected at load, so this needs no user change.

### Tests (browser suite)

- `getStore()` inside `run()` across: `await`, `Promise.all`, `setTimeout`,
  `queueMicrotask`, `requestAnimationFrame`, event listeners, observers.
- Two concurrent `run()`s with different stores, interleaving awaits: no bleed.
- Store is gone after `run()` returns, including after a throw.
- Nested `run()` restores the outer store after the inner one ends.
- Callbacks registered outside any context are not wrapped (identity check).

---

## Client runtime layout

Today the client is one file: `src/client/runtime.ts` exports `yerdRuntime()`,
a single self-contained function whose source (`fn.toString()`, in an IIFE) is
served at `/_yerd/runtime.js` with `cache-control: no-cache`, followed by the
custom attributes' client halves. Because it ships as source it must be
compiled at ES2017 or later (`runtimeSource()` refuses a build with async
lowered to helpers). `<Scripts />` writes the `<script type="module">` tag.
`src/client/index.ts` and `server.ts` are the `@toyz/yerd/client` twins, still
M0 stubs.

The planned layout once islands and sprinkles land:

```
src/client/
  index.ts          browser entry: boot, delegation, island discovery
  server.ts         node-side twin of the client decorators (SSR only)
  jsx-runtime.ts    re-exports the isomorphic tree builder
  dom.ts            tree -> DOM nodes, listeners, closure bindings
  morph.ts          DOM morph (loom port)
  trace.ts          versioned cells, traces, bindings, pools (loom port)
  actions.ts        form interception, fetch, region swaps, yx-boost
  sprinkles.ts      handler table, $ helper, event delegation
  island.ts         @island @state @prop (browser), scheduler
  nope.ts           the module that throws
src/async/
  node.ts           re-export of node:async_hooks AsyncLocalStorage
  browser.ts        AsyncLocalStorage polyfill: frames, patches, bind/snapshot
```

`src/jsx/jsx-runtime.ts` stays isomorphic: it builds `{ type, props }` trees and
touches neither DOM nor Node. The HTML string renderer (server) and the DOM
renderer (client) both consume the same trees.

(Planned: island modules served from `/_yerd/client/*` with long cache
headers and a content hash in the query string.)

## Milestone (slots in as M6 in PLAN.md)

1. Isomorphic jsx-runtime split; DOM renderer; browser test harness; morph port
   with loom's morph cases as the spec.
2. Tier 1: `@action`, `bind`, `_yx` signing, CSRF, no-JS path, then runtime path. (Done, along with tier 1.5 custom attributes.)
3. Tier 2: handler extraction, `$` API, delegation.
4. Tier 3 spike first: same emitted file imported by Node and by the browser via
   import map, with `exports` conditions picking the decorator twin. If that
   works, the rest is wiring: trace port with loom's trace cases, hydration via
   morph, three-tier updates.
5. Client graph scanner + boot failure on server imports.
6. `examples/todo` upgraded to use all three tiers.
