# Interactivity

This page covers how yerd pages update in place, with no client code and no API to write: actions, Regions, boosted links, live refresh, prefetching and custom attributes.

## The client runtime

Put [Scripts](api:yerd.Scripts) once in your root layout's `<head>`. It loads yerd's runtime from `/_yerd/runtime.js` (about 8 KB compressed), which the server serves for you.

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

Everything on this page is progressive enhancement of plain HTML: forms are real forms and links are real links. With JavaScript off or blocked, the app still works, it just does full page loads.

## Actions: forms that call methods

Mark a route method with [@action](api:yerd.action) and pass it to a form's `action`. The method gets the bound arguments first and the submitted [ActionForm](api:yerd.ActionForm) second.

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

The form renders as an ordinary POST to the route's own path, carrying a signed hidden `_yx` field that names the action:

```html
<form action="/todos" method="post" data-yx>
  <input type="hidden" name="_yx" value="eyJjIjoiVG9kb3MiLC...">
  ...
</form>
```

- **With JavaScript**, the runtime sends the form with `fetch`, the action's JSX comes back without layouts, and each `<Region>` in it replaces the one with the same `id` on the page.
- **Without JavaScript**, the browser posts, the action runs, and the server redirects back to the page the form was on (303). The browser reloads it with the new data.

Because the action posts to its route's path, `@param` and `@query` accessors work in actions exactly like they do in `@get`.

## Regions

A [Region](api:yerd.Region) marks a part of the page that responses can replace. It renders a `div` (or the `as` element) with your `id` and attributes.

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

`<Region append>` in a response adds its children to the Region on the page instead of replacing them, and `prepend` puts them first: see [infinite scroll](#infinite-scroll).

Updates are morphed into the page rather than swapped: elements are matched by `id` or `key`, so focus, scroll position, an open `<details>` and whatever the user is typing all survive. Return several Regions (in a fragment) and they all update in one round trip.

## What an action returns

| Return | With JavaScript | Without JavaScript |
|---|---|---|
| nothing | 204; the runtime re-fetches the page and morphs every Region | redirect back to the page |
| JSX with `<Region>`s | those Regions are morphed in (if none match, the page's Regions are refreshed) | redirect back to the page |
| [redirect](api:yerd.redirect)`("/x")` | the runtime navigates there | the browser follows the redirect |
| anything else (`res()`, a number, an object) | sent as a normal response | sent as a normal response |

Returning nothing is the easy default: every Region on the page refreshes. Returning the Regions you changed saves a second request.

## Actions with arguments

To pass data like an id, write the call: `action={() => this.remove({ id })}`. It's an ordinary method call, so TypeScript checks the arguments like any other.

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

The lambda runs while the page renders, but the action doesn't. yerd records which action it called and with what, and signs that into the form's token, so a visitor can't change the id. The signature proves the request came from a page you rendered. It doesn't prove the user may touch that id, so still check ownership in the action.

- An action that takes no arguments can be passed as is: `action={this.add}`. One that takes arguments must be called; `action={this.remove}` doesn't compile.
- Pass actions down to components typed as [Action](api:yerd.Action)`<Args>` and call them the same way.
- An action that reads the form takes it from the lambda: `action={({ form }) => this.rename({ id }, form)}`.
- [bind](api:yerd.bind)`(this.remove, { id })` is the same thing as a value, if you'd rather build it outside JSX.

### What the lambda gets

The lambda's one parameter has five things; take the ones you need.

| | Is | Read |
|---|---|---|
| `el` | the element the action is on (the form, for a form) | when the action fires, in the browser |
| `ref(selector)` | another element on the page, by CSS selector | when the action fires, in the browser |
| `drag` | for `trigger="drop"`: the element that was dropped | when it lands, in the browser |
| `ctx` | the request rendering the page: params, query, session | now, on the server |
| `form` | a stand-in to pass to actions that take a form | |

```tsx
<input action={({ el }) => this.search({ q: el.value })} trigger="input 250ms" />
<button action={({ ref }) => this.move({ id, to: ref("#column").value })}>Move</button>
<div action={({ ctx }) => this.more({ page: Number(ctx.query.get("page") ?? 1) + 1 })} trigger="visible" />
```

`el`, `drag` and `ref()` offer `value`, `valueAsNumber`, `checked`, `selectedIndex`, `open`, `disabled`, `textContent`, `id`, `name`, `scrollTop`, `scrollLeft`, `dataset.*` and `data(name)` (a `data-*` attribute, typed `string` even with `noUncheckedIndexedAccess` on). Their values don't exist yet when the page renders: the browser reads them when the action fires and sends them along. So pass them straight into the arguments. `el.value.trim()` or `` `${el.value}!` `` throws while rendering, with a message saying so. Do that work in the action instead.

> [!NOTE]
> Where `el` / `ref()` / `drag` values go is signed: they can only fill the spots you put them in. What they contain comes from the browser, like any form field, so validate them (`parse(Dto, args)` in the action does it in one line; see [security](15-security.md#values-the-browser-fills-in)). They arrive typed: `checked`, `open` and `disabled` as booleans, the numeric ones as numbers, the rest as strings. They need the client runtime; a plain form post can't fill them and gets a 400.

An element with a `name` also sends its own value as a form field, the way it would inside a form. So an input's action can read it from the `ActionForm` instead of the lambda:

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
| `<form action={...}>` | on submit; the fields arrive as `ActionForm` | works: a normal POST |
| `<button formaction={...}>` | when that button submits its form ("Save" and "Delete" side by side) | works |
| `<form action={...} trigger="...">` | on submit, and also on the trigger (search as you type) | works on submit |
| any element, `action={...}` | on `trigger`, default `"click"` | doesn't fire |

Forms are still the default for anything that must work everywhere: a form posts with JavaScript off, so it works before (and without) the runtime. Everything else is the runtime posting the action for you, with the same token and the same responses: Regions morph in, a redirect navigates, nothing refreshes the page's Regions.

### Triggers

| `trigger` | Fires |
|---|---|
| `"click"` (default) | on click |
| any DOM event: `"change"`, `"keyup"`, `"focusout"`, `"dblclick"`, a custom one... | when the element (or something inside it) fires it |
| `"input 250ms"` | after the events stop for that long (debounced) |
| `"keydown:Enter"` | only for that key |
| `"drop"` | when a `draggable` element is dropped on it; the lambda's `drag` is that element |
| `"visible"` | when the element scrolls into view (200px early), once per render |
| `"load"` | as soon as the page has it, once per render |
| `"every 5s"` | on a timer, while it's on the page and the tab is visible |

A newer run cancels an older one still in flight, so a typeahead never shows stale results. "Once per render" means a `visible` or `load` element fires again only when a response gives it a new action, which is how infinite scroll keeps going.

```tsx
<input name="todo" action={this.add} trigger="keydown:Enter" />                     {/* Enter adds; other keys type */}
<Region id="pulse" action={this.pulse} trigger="every 10s" />                       {/* polls while visible */}
<Region id="stats" action={this.stats} trigger="load"><p>Loading...</p></Region>    {/* fills in after the page */}
<li class="row" action={() => this.open({ id })} trigger="dblclick">{title}</li>
```

- Key names are `KeyboardEvent.key` values: `Enter`, `Escape`, `ArrowDown`, `a`. A filtered key's default action is prevented, so `keydown:Enter` in a form doesn't also submit it.
- `every` never runs faster than every 250 ms, and pauses while the tab is hidden.
- When a response changes an element's trigger (`every 2s` to none, a new debounce), the runtime follows the change. That's how a poll stops once the job is done: see [poll a long job](16-recipes.md#poll-a-long-job-until-its-done) and [load a slow panel](16-recipes.md#load-a-slow-panel-after-the-page).
- When actions nest (a button inside a clickable card), the innermost one wins: a click on the button doesn't also fire the card's action. The event still bubbles on to your own listeners.
- `data-yx-confirm="Sure?"` asks before any action fires, on any element, not only forms.

### Typeahead

Search as the user types, 200 ms after they stop. Without JavaScript it's an ordinary search form.

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

The newest keystroke cancels a search still in flight, so results never arrive out of order. `el.value` is whatever the visitor typed: the action treats it as untrusted text, like a query parameter.

### Drag and drop

Make things `draggable="true"` and give the place they land an action with `trigger="drop"`. The lambda's `drag` is whatever was dropped, so a kanban board is a column per status:

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

While a drag is on, the dragged element has `data-yx-dragging` and the target under it `data-yx-over`, so CSS can show what's happening:

```css
[data-yx-dragging] { opacity: 0.4; }
[data-yx-over] { outline: 2px dashed currentColor; }
```

What a target takes:

| `trigger` | Takes |
|---|---|
| `"drop"` | any of the page's `draggable` elements |
| `"drop:.task"` | only draggables matching the selector (keep cards out of the trash, notes out of the board) |
| `"drop:files"` | files dragged in from the desktop, filtered by the element's `accept` |

The runtime handles the fiddly parts:
- A target never takes a drop of itself or of something inside it. Drop a card on itself and the column around it gets the drop instead.
- When targets nest, the innermost one that accepts the drag wins.
- Text, links and images dragged in from elsewhere are left to the browser.
- If the page has a file zone, a file dropped next to it doesn't make the browser navigate away to the file.
- Folders are skipped, and files `accept` refuses are left out with a notice.
- The marks are cleaned up if the drag is cancelled, leaves the window, or the dragged element is morphed away mid-drag.

Drag and drop needs the client runtime, so give important moves another way in too (a select, or buttons). `drag.data("id")` is read in the browser when the card lands, so validate it in the action. The [kanban recipe](16-recipes.md#kanban-drag-and-drop) puts it all together: the board service, ordering, a bin, button fallbacks, validation and live updates.

### Dropping files

A `drop:files` target posts the files straight to its action as soon as they land. They arrive as multipart, under `files`:

```tsx
import { ActionForm, HttpError, Region, action, get, route } from "@toyz/yerd";

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
      if (!file.type.startsWith("image/") && file.type !== "application/pdf") throw new HttpError(415, `${file.name} isn't a photo or a PDF`);
      uploads.push({ name: file.name, bytes: (await file.arrayBuffer()).byteLength });
    }
    return this.list();
  }
}
```

To collect files first and upload them with the rest of a form, point a zone at a file input with `dropTo`. Dropped files are added to the input (drop five, then five more: ten), filtered by its `accept`, kept to one unless it's `multiple`, and sent when the form submits:

```tsx
<form action={this.post} enctype="multipart/form-data">
  <input name="title" />
  <input id="photos" type="file" name="photos" multiple accept="image/*" />
  <div class="dropzone" dropTo="#photos">Drop photos here</div>
  <button>Post</button>
</form>
```

The action reads them like any upload: `form.files("photos")`, or `is.files()` in a DTO. The zone gets `data-yx-files="<count>"` while the input holds files, so CSS can show it (`.dropzone[data-yx-files]::after { content: attr(data-yx-files) " ready" }`). The input still works on its own, with or without JavaScript. Mind the app's `bodyLimit` (1 MiB by default) when taking many or big files. The [photo upload recipe](16-recipes.md#upload-photos-with-a-form) has the whole form, with validation and limits.

### Infinite scroll

A `<Region append>` in a response adds its children to the end of the Region on the page instead of replacing them (`prepend` adds them first, for newest-on-top feeds). Children with an id or key that's already there are updated in place. Put a sentinel at the bottom that loads the next page when it scrolls into view, and send back a new sentinel each time:

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

The sentinel holds a plain link to the next page, so without JavaScript "Older posts" still pages through the feed. With it, each response appends ten posts and replaces the sentinel with the next one; the last page sends an empty `more` Region, and loading stops.

For things the triggers don't cover, `data-yx-submit` on a checkbox or select submits its form on change, `requestSubmit()` on a rendered action form sends it from your own script, and [Local](#local-state-no-server-at-all) state handles what never needs the server.

## Reading the form

[ActionForm](api:yerd.ActionForm) gives you typed access to the fields:

| Method | Returns |
|---|---|
| `get(name)` | the first value, or `undefined` |
| `string(name)` | the first value; a 400 if it's missing |
| `all(name)` | every value of a repeated field |
| `has(name)` | whether the field was sent (handy for checkboxes) |
| `parse(Dto)` | the form validated into a DTO class; a 400 listing every issue otherwise |
| `file(name)` / `files(name)` | uploaded `File`s (an empty file input counts as none) |

`parse()` is usually what you want. Uploads join the fields, so DTOs can use `is.file()` (see [request data](03-request-data.md)).

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

Give file forms `enctype="multipart/form-data"`: the runtime switches to multipart on its own, but the browser needs it when JavaScript is off.

### Errors

Throw an [HttpError](api:yerd.HttpError) (or let `parse()` throw one) and, with JavaScript, its message is written into the form's `[data-yx-error]` element.

Validation failures go by field. Each invalid field gets `aria-invalid="true"` (style it with `[aria-invalid="true"]`), the first one is focused, and its message goes:

- into `[data-yx-error="title"]` if the form has a box for that field, or
- into the form's own `[data-yx-error]`, labelled with the field: "Title: Can't be empty" (the field's `<label>`, or its name).

An issue about one item of a list (`photos[0]`, `tags[1]`) goes to the list's field (`photos`) unless the form has a box for the item itself.

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

Everything is cleared on the next submit.

Where there's no `[data-yx-error]` (a form without one, an action on a button or input), the runtime shows the message in a small notice at the bottom of the page. It also does when the server can't be reached. To show notices your own way, listen for `yx:notice` and call `preventDefault()`; the message is `event.detail.message`:

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

Give the page a `<div id="toast" role="status" hidden></div>` for it to fill.

If the server restarted with a different secret, was redeployed, or the page sat open past the token's lifetime, the page's actions are stale. The runtime notices, re-fetches the page with fresh tokens and tells the user to try again (the action didn't run, so that's safe). In development the secret is kept in `node_modules/.cache/yerd/secret`, so restarting the dev server doesn't break the open page at all.

> [!WARNING]
> Without JavaScript, a thrown error renders the error page instead. For forms that must work either way, catch the error, store a message with `session.flash()`, and `return redirect()` back to the form. The [per-field form errors recipe](16-recipes.md#per-field-form-errors) does it with each message under its field.

## Submit buttons with their own action

`formaction={action}` on a submit button posts to that action instead of the form's. Use it for "Save" and "Delete" in one form.

```tsx
<form action={this.save}>
  <input name="title" />
  <button>Save</button>
  <button formaction={() => this.remove({ id: note.id })}>Delete</button>
</form>
```

The button submits the token as its own `name="_yx"` value, so it can't have a `name` or `value` of its own.

## Form helpers

Small behaviours, switched on with attributes:

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

While a form is in flight it gets `aria-busy="true"` and its enabled buttons are disabled. Elements a morph inserts get `data-yx-new` (for entrance animations), and a form inside a `<details>` closes it on success.

## Boosted links

Add `data-yx-boost` to a link, or to any element around links, and clicks fetch the next page and morph `<body>` instead of reloading.

```tsx
<nav data-yx-boost>
  <a href="/todos">Todos</a>
  <a href="/about">About</a>
  <a href="/report.pdf">Report</a>      {/* files are left to the browser */}
  <a href="https://example.com">Out</a> {/* so are other origins */}
</nav>
```

The URL is pushed to history, Back and Forward work, and scroll position is restored. Links with a `target`, `download` or `rel="external"` are left alone, and `data-yx-boost="false"` opts a subtree out.

## Live refresh

Point `data-yx-live` at a Server-Sent Events route, and every message refreshes the page's Regions. Combine it with a per-user channel and every open tab stays in sync.

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

Publish to `"todos"` after any change and every connected page refreshes. See [streaming and live](07-streaming-and-live.md) for channels, per-user feeds and SSE details.

> [!NOTE]
> Only plain `data:` messages trigger a refresh. Events sent with an `event:` name (`event({ event: "x", ... })`) are ignored by `data-yx-live`. A dropped connection that comes back also triggers a refresh, since messages may have been missed.

## Auto mode

Don't want to sprinkle attributes? `<Scripts auto />` makes the runtime handle every same-origin link and form on its own.

```tsx
<head>
  <Scripts auto />
</head>
```

- Every same-origin link is boosted (files, other origins, `target`, `download` and `rel="external"` excepted).
- Every same-origin form goes through `fetch`. Plain forms posting to a normal `@post` route have their redirects followed, and the page they land on is morphed in. So a classic form-and-redirect app gets in-place updates without Regions.
- With a mouse, the runtime watches the pointer: when it slows down heading for a link, that page is prefetched before the click.

`data-yx-boost="false"` still opts anything out. Nothing changes on the server.

## Prefetching

The `prefetch` prop warms the next page before the click.

```tsx
<a href="/todos" prefetch>Todos</a>                    {/* on hover, focus or touch */}
<a href="/reports" prefetch="visible">Reports</a>      {/* when scrolled into view */}
<a href="/" prefetch="load">Home</a>                   {/* right away */}
<section prefetch={{ url: "/api/stats", as: "json", on: "visible" }}>...</section>
```

Boosted links use the runtime's own cache (entries live 15 seconds and are used once). Ordinary links get a `<link rel="prefetch">`. A JSON prefetch is served to `window.yerd.fetch(url)` from client code. Every action empties the cache, so a page warmed before signing in (or before any change) is never shown after it. A page the browser restores from its back/forward memory is fetched again too.

> [!WARNING]
> Prefetches are real GET requests, sent before anyone clicks. GET handlers must not change anything. Prefetch requests carry a `yx-prefetch: 1` header if you need to tell them apart.

## Local state: no server at all

Some interactivity never needs the server: a toggle, a tab strip, a counter for a form you haven't submitted. [`Local`](api:yerd.Local) gives a piece of the page its own state that lives in the browser. No request, no build step.

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

- Reading a field (`s.likes`, `s.user.name`) renders its value on the server and keeps that spot in step in the browser: text, attributes (`hidden`, `aria-*`, `value`, `checked`) and class flags (`class={{ liked: s.likes }}`). [`not`](api:yerd.not) inverts a boolean.
- `on*` handlers (`onClick`, `onInput`...) inside a `Local` run in the browser against the state; after each one the bindings refresh. Pushing to an array or editing a nested object just works. Outside a `Local`, handler functions render nothing: use an action.
- `s` is typed from `state`, so `s.likes++` and `hidden={s.open}` are checked by the compiler.
- Each `Local` has its own copy, so the same component can appear many times.

> [!WARNING]
> Handlers are sent to the browser as their source, so they can use the state (by the render prop's parameter name) and their event argument, nothing else from the server: no imports, no outer variables. A binding is a direct field read: `{s.count * 2}` renders the starting value but won't update, so compute it in the handler into another field. Compiling handlers needs `'unsafe-eval'` if you run a strict Content-Security-Policy.

### Comparing: eq()

A binding is a direct field read, so `s.slide === 2` can't stay in step. [eq](api:yerd.eq) can: `eq(s.slide, 2)` is true while the field equals the value, and works anywhere a boolean binding does, inside `not()` and class flags too. That's enough for tabs, steppers and an image slider:

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

Handlers can't see outer variables like `n` (they're sent as text), so the count goes in the state and each thumbnail carries its index in `data-n`.

### Keeping it across reloads

Local state is gone on reload unless you give it a key. `persist` saves it in the browser's storage after every handler and loads it back when the page starts:

```tsx
<Local state={{ theme: "light", collapsed: false }} persist="prefs">
  {(s) => <button onClick={() => (s.collapsed = !s.collapsed)} aria-expanded={not(s.collapsed)}>Menu</button>}
</Local>
```

- `persist="prefs"` uses localStorage; `persist={{ key: "prefs", storage: "session" }}` uses sessionStorage (this tab only, cleared when it closes).
- Saved values are merged over `state`, so a field you add later starts at its default.
- Every `Local` with the same key stays in step: in this page, and in other open tabs.
- The server still renders the defaults (it can't see the browser's storage), so saved values appear once the runtime starts. For state the server needs to render, keep it on the server: a field in the session (per visitor) or your database, changed through an action.

## Custom attributes

[attribute](api:yerd.attribute) defines your own attribute with an optional server half (`render`: what the prop renders as) and client half (`client`: runs in the browser for each element that has it).

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

- The client half connects when an element with the attribute appears (first load, a morph, a boosted page), gets `update` when the value changes, and `disconnect` when it goes away.
- It can return nothing, a cleanup function, or `{ update, disconnect }`. Its third argument is the runtime API ([YerdClient](api:yerd.YerdClient)): `refresh()`, `load(url, push)`, `apply(html)`, `prefetch(url)` and more.
- Define attributes at module level in a file the server imports. Names are lowercase words joined by dashes.

> [!WARNING]
> The client half is shipped to the browser as source text (`fn.toString()`). It must be self-contained: no imports, and no variables from the surrounding module. Everything it needs comes in through `(el, value, yerd)`.

## Security in brief

You don't add CSRF tokens; actions carry their own.

- **Signed tokens.** The `_yx` token is HMAC-signed with your app secret, so nobody can call another action or change bound arguments.
- **Expiring and session-bound.** Tokens expire (`actionTtl`, a day by default) and, with sessions on, only work in the session they were rendered for. Expired forms get a 403 asking the user to reload.
- **Cross-site checks.** Every POST, PUT, PATCH and DELETE from another site is refused with 403.

Set `YERD_SECRET` in production, or forms break on every restart. Details, options, rotation and a checklist are in the [security guide](15-security.md).
