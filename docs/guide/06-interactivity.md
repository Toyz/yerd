# Interactivity

How pages update in place without client code: actions, Regions, boosted links, live refresh, prefetching, local state and custom attributes.

## The client runtime

Put [Scripts](api:yerd.Scripts) once in the root layout's `<head>` to load the runtime (about 8 KB compressed).

```tsx
import { Scripts, type LayoutProps } from "@toyz/yerd";

function RootLayout({ children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <title>My app</title>
        <Scripts />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

Everything here is progressive enhancement: with JavaScript off, forms and links still work with full page loads.

## Actions: forms that call methods

Mark a route method with [@action](api:yerd.action) and pass it to a form's `action`; it gets the bound arguments first and the submitted [ActionForm](api:yerd.ActionForm) second.

```tsx
import { ActionForm, Region, action, get, route } from "@toyz/yerd";

const todos: string[] = [];

function TodoList() {
  return (
    <Region id="todos" as="ul">
      {todos.map((title) => <li>{title}</li>)}
    </Region>
  );
}

@route("/todos")
export class Todos {
  @get page() {
    return (
      <main>
        <TodoList />
        <form action={this.add} data-yx-reset>
          <input name="title" required />
          <button>Add</button>
        </form>
      </main>
    );
  }

  @action add(_: {}, form: ActionForm) {
    todos.push(form.string("title"));
    return <TodoList />;
  }
}
```

The form renders as a POST to the route's own path, with a signed `_yx` field naming the action:

```html
<form action="/todos" method="post" data-yx>
  <input type="hidden" name="_yx" value="eyJjIjoiVG9kb3MiLC...">
  ...
</form>
```

- **With JavaScript**, the runtime posts it with `fetch`, and each `<Region>` in the action's JSX replaces the one with the same `id`.
- **Without JavaScript**, the server runs the action and redirects back (303).
- `@param` and `@query` accessors work in actions as in `@get`.

## Regions

A [Region](api:yerd.Region) marks a part of the page that responses can replace; it renders a `div` (or the `as` element) with your `id` and attributes.

```tsx
import { Region } from "@toyz/yerd";

function Counter({ count }: { count: number }) {
  return (
    <Region id="count" as="span" class="pill" aria-live="polite">
      {count} left
    </Region>
  );
}
```

- Updates are morphed in by `id` or `key`, so focus, scroll, an open `<details>` and typed text survive.
- Return several Regions in a fragment to update them in one round trip.
- `<Region append>` / `prepend` adds instead of replacing: see [infinite scroll](#infinite-scroll).

## What an action returns

| Return | With JavaScript | Without JavaScript |
|---|---|---|
| nothing | 204; every Region on the page is refreshed | redirect back |
| JSX with `<Region>`s | those Regions morph in (none matching: all refresh) | redirect back |
| [redirect](api:yerd.redirect)`("/x")` | the runtime navigates there | followed |
| anything else (`res()`, a number, an object) | sent as is | sent as is |

Returning nothing is simplest; returning the changed Regions saves a request.

## Actions with arguments

To bind data like an id, write the call: `action={() => this.remove({ id })}`, type-checked like any call.

```tsx
import { Region, action, get, route, type Action } from "@toyz/yerd";

const items = [{ id: 1, title: "Milk" }, { id: 2, title: "Eggs" }];

function Item({ item, remove }: { item: { id: number; title: string }; remove: Action<{ id: number }> }) {
  return (
    <li>
      {item.title}
      <form action={() => remove({ id: item.id })}>
        <button>Delete</button>
      </form>
    </li>
  );
}

@route("/list")
export class List {
  @get page() {
    return <Region id="items" as="ul">{items.map((item) => <Item item={item} remove={this.remove} />)}</Region>;
  }

  @action remove({ id }: { id: number }) {
    items.splice(items.findIndex((i) => i.id === id), 1);
  }
}
```

- The lambda runs at render; the call's arguments are signed into the token, so a visitor can't change them. Still check the user owns the id ([action tokens](15-security.md#action-tokens)).
- An action without arguments is passed as is (`action={this.add}`); one with arguments must be called.
- Pass actions to components typed as [Action](api:yerd.Action)`<Args>`.
- To pass the form on: `action={({ form }) => this.rename({ id }, form)}`.
- [bind](api:yerd.bind)`(this.remove, { id })` does the same outside JSX.

### What the lambda gets

| | Is | Read |
|---|---|---|
| `el` | the element the action is on (the form, for a form) | in the browser, when it fires |
| `ref(selector)` | another element on the page, by CSS selector | in the browser, when it fires |
| `drag` | for `trigger="drop"`: the element that was dropped | in the browser, when it lands |
| `ctx` | the request rendering the page: params, query, session | on the server, now |
| `form` | a stand-in to pass to actions that take a form | |

```tsx
<input action={({ el }) => this.search({ q: el.value })} trigger="input 250ms" />
<button action={({ ref }) => this.move({ id, to: ref("#column").value })}>Move</button>
<div action={({ ctx }) => this.more({ page: Number(ctx.query.get("page") ?? 1) + 1 })} trigger="visible" />
```

- `el`, `drag` and `ref()` offer `value`, `valueAsNumber`, `checked`, `selectedIndex`, `open`, `disabled`, `textContent`, `id`, `name`, `scrollTop`, `scrollLeft`, `dataset.*` and `data(name)` (a `data-*` attribute, as a `string`).
- They're read when the action fires, so pass them straight into the arguments: `el.value.trim()` throws at render.
- `checked`, `open` and `disabled` arrive as booleans, the numeric ones as numbers, the rest as strings.

> [!NOTE]
> Their contents are browser input: validate them ([values the browser fills in](15-security.md#values-the-browser-fills-in)). A plain form post can't fill them and gets a 400.

An element with a `name` also sends its value as a form field:

```tsx
import { ActionForm, Region, action, get, route } from "@toyz/yerd";

@route("/notes")
export class Notes {
  @get page() {
    return (
      <main>
        <input name="title" placeholder="Rename" action={this.rename} trigger="change" />
        <Region id="saved" />
      </main>
    );
  }

  @action rename(_: {}, form: ActionForm) {
    return <Region id="saved">Saved as {form.string("title")}</Region>;
  }
}
```

## Where actions work

`action` goes on any element, and `trigger` says when it fires.

| Where | Fires | Without JavaScript |
|---|---|---|
| `<form action={...}>` | on submit, with the fields as `ActionForm` | works |
| `<button formaction={...}>` | when that button submits its form | works |
| `<form action={...} trigger="...">` | on submit and on the trigger | on submit |
| any element, `action={...}` | on `trigger`, default `"click"` | doesn't fire |

Use a form for anything that must work without JavaScript. From your own script, `requestSubmit()` sends a rendered action form.

### Triggers

| `trigger` | Fires |
|---|---|
| `"click"` (default) | on click |
| any DOM event: `"change"`, `"keyup"`, `"dblclick"`, a custom one... | when the element or a descendant fires it |
| `"input 250ms"` | once the events stop for that long |
| `"keydown:Enter"` | only for that key |
| `"drop"` | when a `draggable` is dropped on it (see [drag and drop](#drag-and-drop)) |
| `"visible"` | on scrolling into view (200px early), once per render |
| `"load"` | as soon as the page has it, once per render |
| `"every 5s"` | on a timer (250 ms minimum), while the tab is visible |

```tsx
<input name="todo" action={this.add} trigger="keydown:Enter" />                     {/* Enter adds; other keys type */}
<Region id="pulse" action={this.pulse} trigger="every 10s" />                       {/* polls while visible */}
<Region id="stats" action={this.stats} trigger="load"><p>Loading...</p></Region>    {/* fills in after the page */}
<li class="row" action={() => this.open({ id })} trigger="dblclick">{title}</li>
```

- A newer run cancels one still in flight, so results never arrive stale.
- "Once per render": again only when a response gives the element a new action.
- Keys are `KeyboardEvent.key` values; a filtered key's default is prevented, so `keydown:Enter` doesn't also submit.
- A response can change or remove the trigger, so a poll can stop itself: see [poll a long job](16-recipes.md#poll-a-long-job-until-its-done) and [load a slow panel](16-recipes.md#load-a-slow-panel-after-the-page).
- Nested actions: the innermost wins, and the event still bubbles to your own listeners.

### Typeahead

Search 200 ms after typing stops; without JavaScript it's a plain search form.

```tsx
import { Region, action, get, query, route } from "@toyz/yerd";

const directory = [
  { id: 1, name: "Ada Lovelace" },
  { id: 2, name: "Grace Hopper" },
  { id: 3, name: "Alan Turing" },
];

function matching(q: string) {
  const needle = q.trim().toLowerCase();
  return needle ? directory.filter((p) => p.name.toLowerCase().includes(needle)).slice(0, 10) : [];
}

@route("/people")
export class People {
  @query("q") accessor q = "";

  @get page() {
    return (
      <main>
        {/* No JavaScript: Enter loads /people?q=... and the page renders the results. */}
        <form method="get" role="search">
          <input type="search" name="q" value={this.q} placeholder="Search" autocomplete="off"
            action={({ el }) => this.search({ q: el.value })} trigger="input 200ms" />
        </form>
        {this.results(this.q)}
      </main>
    );
  }

  results(q: string) {
    return <Region id="results" as="ul" aria-live="polite">{matching(q).map((p) => <li key={p.id}>{p.name}</li>)}</Region>;
  }

  @action search({ q }: { q: string }) {
    return this.results(q);
  }
}
```

Treat `el.value` as untrusted text, like a query parameter.

### Drag and drop

Make things `draggable="true"` and give the target an action with `trigger="drop"`; the lambda's `drag` is what was dropped.

```tsx
import { Region, type Action } from "@toyz/yerd";

type Status = "todo" | "doing" | "done";
interface Card {
  id: string;
  title: string;
}

function Column({ status, cards, move }: { status: Status; cards: Card[]; move: Action<{ card: string; to: Status; before?: string }> }) {
  return (
    <section class="column" action={({ drag }) => move({ card: drag.data("id"), to: status })} trigger="drop">
      <h2>{status}</h2>
      <Region id={`column-${status}`} as="ul">
        {cards.map((card) => (
          // Dropping on a card puts the dropped one before it; the innermost target wins.
          <li key={card.id} data-id={card.id} draggable="true"
            action={({ drag }) => move({ card: drag.data("id"), to: status, before: card.id })} trigger="drop">
            {card.title}
          </li>
        ))}
      </Region>
    </section>
  );
}
```

During a drag, the dragged element has `data-yx-dragging` and the target `data-yx-over`:

```css
[data-yx-dragging] { opacity: 0.4; }
[data-yx-over] { outline: 2px dashed currentColor; }
```

| `trigger` | Takes |
|---|---|
| `"drop"` | any of the page's `draggable` elements |
| `"drop:.task"` | only draggables matching the selector |
| `"drop:files"` | files from the desktop, filtered by the element's `accept` |

- A target never takes a drop of itself or its contents: a card dropped on itself goes to the column.
- When targets nest, the innermost that accepts the drag wins.
- It needs the runtime, so give important moves another way in (a select, buttons). Validate `drag.data("id")`.
- The [kanban recipe](16-recipes.md#kanban-drag-and-drop) has the full board.

### Dropping files

A `drop:files` target posts files to its action as they land, as multipart under `files`:

```tsx
import { ActionForm, Region, UnsupportedMediaType, action, get, route } from "@toyz/yerd";

const uploads: { name: string; bytes: number }[] = [];

@route("/inbox")
export class Inbox {
  @get page() {
    return (
      <main>
        <div class="dropzone" action={this.upload} trigger="drop:files" accept="image/*,.pdf">
          Drop photos or PDFs
        </div>
        {this.list()}
      </main>
    );
  }

  list() {
    return <Region id="uploads" as="ul">{uploads.map((u) => <li>{u.name} ({u.bytes} bytes)</li>)}</Region>;
  }

  @action async upload(_: {}, form: ActionForm) {
    for (const file of form.files("files")) {
      // `accept` filters in the browser; the server still decides.
      if (!file.type.startsWith("image/") && file.type !== "application/pdf") throw new UnsupportedMediaType(`${file.name} isn't a photo or a PDF`);
      uploads.push({ name: file.name, bytes: (await file.arrayBuffer()).byteLength });
    }
    return this.list();
  }
}
```

To send them with a form instead, point a zone at a file input with `dropTo`:

```tsx
<form action={this.post} enctype="multipart/form-data">
  <input name="title" />
  <input id="photos" type="file" name="photos" multiple accept="image/*" />
  <div class="dropzone" dropTo="#photos">Drop photos here</div>
  <button>Post</button>
</form>
```

- Drops add to the input's files, filtered by its `accept` and kept to one unless it's `multiple`. Folders are skipped; refused files are left out with a notice.
- The action reads them like any upload: `form.files("photos")`, or `is.files()` in a DTO.
- The zone gets `data-yx-files="<count>"` while the input holds files.
- Mind `bodyLimit` (1 MiB by default); see the [photo upload recipe](16-recipes.md#upload-photos-with-a-form).

### Infinite scroll

`<Region append>` in a response adds its children to the end (`prepend`: the start), updating any whose id or key is already there. A `visible` sentinel loads the next page and is replaced each time:

```tsx
import { Region, action, between, get, query, route, toInt, type Action } from "@toyz/yerd";

const LAST_PAGE = 5;
const posts = (page: number) => Array.from({ length: 10 }, (_, i) => ({ id: page * 10 + i, title: `Post ${page * 10 + i}` }));

function More({ page, load }: { page: number; load: Action<{ page: number }> }) {
  return (
    <Region id="more">
      {page <= LAST_PAGE ? (
        // Loads the next page as it scrolls into view. Without JavaScript, the link does it.
        <div action={() => load({ page })} trigger="visible">
          <a href={`/feed?page=${page}`}>Older posts</a>
        </div>
      ) : null}
    </Region>
  );
}

@route("/feed")
export class Feed {
  @query("page", { transform: toInt, validate: between(1, LAST_PAGE) }) accessor pageNo = 1;

  @get page() {
    return (
      <main>
        <Region id="posts" as="ul">{posts(this.pageNo).map((p) => <li key={p.id}>{p.title}</li>)}</Region>
        <More page={this.pageNo + 1} load={this.more} />
      </main>
    );
  }

  @action more({ page }: { page: number }) {
    return (
      <>
        <Region id="posts" as="ul" append>{posts(page).map((p) => <li key={p.id}>{p.title}</li>)}</Region>
        <More page={page + 1} load={this.more} />
      </>
    );
  }
}
```

The last page sends an empty `more` Region, which stops it.

## Reading the form

[ActionForm](api:yerd.ActionForm) reads the submitted fields:

| Method | Returns |
|---|---|
| `get(name)` | the first value, or `undefined` |
| `string(name)` | the first value; a 400 if it's missing |
| `all(name)` | every value of a repeated field |
| `has(name)` | whether it was sent (checkboxes) |
| `parse(Dto)` | the form validated into a DTO; a 400 listing every issue otherwise |
| `file(name)` / `files(name)` | uploaded `File`s (an empty file input counts as none) |

`parse()` is usually what you want; DTOs take uploads with `is.file()` (see [request data](03-request-data.md)).

```tsx
import { ActionForm, action, get, is, length, route, trim } from "@toyz/yerd";

class Profile {
  @is.string({ transform: trim, validate: length(1, 60) }) name!: string;
  @is.file({ types: ["image/*"], maxSize: 2_000_000, optional: true }) avatar?: File;
}

@route("/profile")
export class ProfilePage {
  @get page() {
    return (
      <form action={this.save} enctype="multipart/form-data">
        <input name="name" required />
        <input type="file" name="avatar" accept="image/*" />
        <p data-yx-error role="alert"></p>
        <button>Save</button>
      </form>
    );
  }

  @action async save(_: {}, form: ActionForm) {
    const { name, avatar } = form.parse(Profile);
    if (avatar) console.log(name, avatar.name, (await avatar.arrayBuffer()).byteLength);
  }
}
```

Give file forms `enctype="multipart/form-data"` for when JavaScript is off.

### Errors

With JavaScript, a thrown [YerdError](api:yerd.YerdError) (from `parse()` too) shows its message in the form's `[data-yx-error]`.

```tsx
<form action={this.save}>
  <label for="title">Title</label>
  <input id="title" name="title" />
  <span class="field-error" data-yx-error="title"></span>

  <label>Price <input name="price" /></label>

  <p data-yx-error role="alert"></p> {/* "Price: Must be from 1 to 100 (got 0)" */}
  <button>Save</button>
</form>
```

- Invalid fields get `aria-invalid="true"`, and the first is focused.
- A field's message goes into its `[data-yx-error="field"]`, else the form's box, labelled with the field's `<label>` or name.
- An issue on a list item (`photos[0]`) goes to the list's box unless the item has one.
- All of it clears on the next submit. Expired tokens are handled for you: see [stale pages](15-security.md#stale-pages).

With no `[data-yx-error]`, or the server unreachable, a small notice shows the message. To replace it, handle `yx:notice`:

```tsx
// in the root layout's <head>, after <Scripts />
<script type="module">{`
  document.addEventListener("yx:notice", (event) => {
    event.preventDefault(); // no built-in notice
    const toast = document.querySelector("#toast");
    toast.textContent = event.detail.message;
    toast.hidden = false;
    setTimeout(() => (toast.hidden = true), 4000);
  });
`}</script>
```

Give the page a `<div id="toast" role="status" hidden></div>` to fill.

> [!WARNING]
> Without JavaScript, a thrown error renders the error page. To work either way, `session.flash()` a message and `return redirect()`: see the [per-field form errors recipe](16-recipes.md#per-field-form-errors).

## Submit buttons with their own action

`formaction={action}` on a submit button posts to that action instead of the form's.

```tsx
<form action={this.save}>
  <input name="title" />
  <button>Save</button>
  <button formaction={() => this.remove({ id: note.id })}>Delete</button>
</form>
```

The button can't have its own `name` or `value`: it submits the token.

## Form helpers

Small behaviours switched on by attribute:

| Attribute | On | Does |
|---|---|---|
| `data-yx-confirm="Sure?"` | form, or any element with an `action` | asks before submitting or firing |
| `data-yx-reset` | form | clears the form after a successful submit |
| `data-yx-submit` | input | submits its form on change (checkboxes, selects) |
| `data-yx-error` | element in a form | where error messages go |
| `data-yx-keep` | any element | morphs leave it and its children alone (widgets, canvases) |

```tsx
<form action={this.clearDone} data-yx-confirm="Delete all finished todos?">
  <label>
    <input type="checkbox" name="all" data-yx-submit /> Include archived
  </label>
  <button>Clear</button>
</form>
```

A form in flight gets `aria-busy="true"` with its buttons disabled, a form in a `<details>` closes it on success, and elements a morph inserts get `data-yx-new` (for entrance animations).

## Boosted links

`data-yx-boost` on a link or an ancestor makes clicks fetch the page and morph `<body>` instead of reloading.

```tsx
<nav data-yx-boost>
  <a href="/todos">Todos</a>
  <a href="/about">About</a>
  <a href="/report.pdf">Report</a>      {/* files are left to the browser */}
  <a href="https://example.com">Out</a> {/* so are other origins */}
</nav>
```

- History, Back/Forward and scroll position work.
- Links with `target`, `download` or `rel="external"` are left alone; `data-yx-boost="false"` opts a subtree out.

## Live refresh

Point `data-yx-live` at a Server-Sent Events route and every message refreshes the page's Regions.

```tsx
import { Channels, get, inject, route, signal, sse } from "@toyz/yerd";

@route("/todos/events")
export class TodoEvents {
  @inject(Channels) accessor channels!: Channels;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe("todos", this.stop);
  }
}

// in a layout or page:
<div data-yx-live="/todos/events" hidden></div>
```

- Publish to `"todos"` after a change to refresh every connected page; see [streaming and live](07-streaming-and-live.md).
- Only plain `data:` messages refresh; named events are ignored.
- A reconnect also refreshes, in case messages were missed.

## Auto mode

`<Scripts auto />` makes the runtime handle every same-origin link and form without attributes.

```tsx
<head>
  <Scripts auto />
</head>
```

- Links are boosted, with the same exceptions as `data-yx-boost`.
- Forms go through `fetch`; a plain form to a `@post` route has its redirect followed and morphed in, so no Regions are needed.
- A link the mouse slows down toward is prefetched.
- `data-yx-boost="false"` still opts out.

## Prefetching

The `prefetch` prop warms the next page before the click.

```tsx
<a href="/todos" prefetch>Todos</a>                    {/* on hover, focus or touch */}
<a href="/reports" prefetch="visible">Reports</a>      {/* when scrolled into view */}
<a href="/" prefetch="load">Home</a>                   {/* right away */}
<section prefetch={{ url: "/api/stats", as: "json", on: "visible" }}>...</section>
```

- Boosted links use the runtime's cache (15 seconds, used once); others get a `<link rel="prefetch">`.
- A JSON prefetch answers `window.yerd.net.fetch(url)`.
- Every action empties the cache, so nothing warmed before a change is shown after it.

> [!WARNING]
> Prefetches are real GETs sent before any click, so GET handlers must not change anything. They carry `yx-prefetch: 1`.

## Local state: no server at all

[`Local`](api:yerd.Local) gives part of the page browser-side state for things that never need the server.

```tsx
import { Local, not } from "@toyz/yerd";

export function Details() {
  return (
    <Local state={{ open: false, likes: 0 }}>
      {(s) => (
        <div>
          <button onClick={() => (s.open = !s.open)} aria-expanded={s.open}>
            Details
          </button>
          <p hidden={not(s.open)}>Only shown when open.</p>
          <button class={{ liked: s.likes }} onClick={() => s.likes++}>
            Like ({s.likes})
          </button>
        </div>
      )}
    </Local>
  );
}
```

- A field read (`s.likes`, `s.user.name`) renders on the server and stays in step in the browser, in text, attributes and class flags. [`not`](api:yerd.not) inverts a boolean.
- `on*` handlers run in the browser against the state, then bindings refresh. Outside a `Local` they render nothing.
- `s` is typed from `state`; each `Local` has its own copy.

> [!WARNING]
> Handlers are sent as source: they see only the state (by the render prop's parameter name) and their event, no imports or outer variables. A binding must be a direct field read: `{s.count * 2}` won't update. Strict CSPs need `'unsafe-eval'` ([client-side code](15-security.md#client-side-code)).

### Comparing: eq()

[eq](api:yerd.eq)`(s.slide, 2)` is a boolean binding, true while the field equals the value; it works in `not()` and class flags too.

```tsx
import { Local, eq, not } from "@toyz/yerd";

function Gallery({ photos }: { photos: string[] }) {
  return (
    <Local state={{ i: 0, n: photos.length }}>
      {(s) => (
        <div class="gallery">
          {photos.map((src, n) => <img src={src} alt="" loading="lazy" hidden={not(eq(s.i, n))} />)}
          <button aria-label="Previous" onClick={() => (s.i = (s.i + s.n - 1) % s.n)}>‹</button>
          <button aria-label="Next" onClick={() => (s.i = (s.i + 1) % s.n)}>›</button>
          {photos.map((src, n) => (
            <button class={["thumb", { active: eq(s.i, n) }]} data-n={n}
              onClick={(e: Event) => (s.i = Number((e.currentTarget as HTMLElement).dataset.n))}>
              <img src={src} alt={`Photo ${n + 1}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </Local>
  );
}
```

Handlers can't see `n`, so the count is in the state and each thumbnail carries `data-n`.

### Keeping it across reloads

`persist` saves the state to browser storage after every handler and restores it on load.

```tsx
<Local state={{ theme: "light", collapsed: false }} persist="prefs">
  {(s) => <button onClick={() => (s.collapsed = !s.collapsed)} aria-expanded={not(s.collapsed)}>Menu</button>}
</Local>
```

- `persist="prefs"` uses localStorage; `persist={{ key: "prefs", storage: "session" }}` uses sessionStorage (this tab only).
- Saved values merge over `state`, so new fields start at their defaults.
- `Local`s sharing a key stay in step, across tabs too.
- The server renders the defaults; saved values appear once the runtime starts. State the server must render belongs in the session or database.

## Custom attributes

[attribute](api:yerd.attribute) defines your own attribute: an optional `render` (what it renders as) and `client` (runs in the browser per element).

```tsx
import { attribute } from "@toyz/yerd";

export const tooltip = attribute("tooltip", {
  render: (text: string) => ({ tooltip: text, "aria-label": text }),
  client(el, value) {
    el.title = value;
    return {
      update(next) { el.title = next; },
      disconnect() { el.title = ""; },
    };
  },
});

declare module "@toyz/yerd" {
  interface CustomAttributes {
    tooltip?: string;
  }
}

const button = <button tooltip="Delete this todo">x</button>;
```

- `client` runs when an element with the attribute appears (load, morph, boosted page) and may return nothing, a cleanup, or `{ update, disconnect }`.
- Its third argument is the runtime API, [YerdClient](api:yerd.YerdClient): `yerd.page` (`refresh()`, `load()`, `apply()`, `morph()`), `yerd.net` (`prefetch()`, `fetch()`) and `yerd.clock` (`now()`, `sync()`).
- Define attributes at module level in a file the server imports; names are lowercase and dashed.
- A client half that needs imports can be a module: see [lazy attribute halves](17-client-code.md#lazy-attribute-halves).

> [!WARNING]
> The client half is shipped as source: no imports or module variables, only `(el, value, yerd)`.

For bigger client code, see [Client code](17-client-code.md).

## Security in brief

Actions need no CSRF tokens: `_yx` is signed, expires (`actionTtl`, a day) and is session-bound, and cross-site writes are refused ([security](15-security.md)). Set `YERD_SECRET` in production or forms break on restart.
