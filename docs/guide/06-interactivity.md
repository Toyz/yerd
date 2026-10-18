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

Updates are morphed into the page rather than swapped: elements are matched by `id` or `key`, so focus, scroll position, an open `<details>` and whatever the user is typing all survive. Return several Regions (in a fragment) and they all update in one round trip.

## What an action returns

| Return | With JavaScript | Without JavaScript |
|---|---|---|
| nothing | 204; the runtime re-fetches the page and morphs every Region | redirect back to the page |
| JSX with `<Region>`s | those Regions are morphed in (if none match, the page's Regions are refreshed) | redirect back to the page |
| [redirect](api:yerd.redirect)`("/x")` | the runtime navigates there | the browser follows the redirect |
| anything else (`res()`, a number, an object) | sent as a normal response | sent as a normal response |

Returning nothing is the easy default: every Region on the page refreshes. Returning the Regions you changed saves a second request.

## bind(): actions with arguments

To pass data like an id, use [bind](api:yerd.bind). The arguments travel inside the signed token, so a visitor can't change them, and TypeScript checks them against the action's first parameter.

```tsx
import { Region, action, bind, get, route, type Action } from "@toyz/yerd";

const items = [{ id: 1, title: "Milk" }, { id: 2, title: "Eggs" }];

function Item({ item, remove }: { item: { id: number; title: string }; remove: Action<{ id: number }> }) {
  return (
    <li>
      {item.title}
      <form action={bind(remove, { id: item.id })}>
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

Pass actions down to components typed as [Action](api:yerd.Action)`<Args>`. The signature proves the request came from a form you rendered; it does not prove the user may touch that id, so still check ownership in the action.

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

Throw an [HttpError](api:yerd.HttpError) (or let `parse()` throw one) and, with JavaScript, its message is written into the form's `[data-yx-error]` element. Validation failures show each issue's message.

> [!WARNING]
> Without JavaScript, a thrown error renders the error page instead. For forms that must work either way, catch the error, store a message with `session.flash()`, and `return redirect()` back to the form. See [sessions and auth](09-sessions-and-auth.md).

## Submit buttons with their own action

`formaction={action}` on a submit button posts to that action instead of the form's. Use it for "Save" and "Delete" in one form.

```tsx
<form action={this.save}>
  <input name="title" />
  <button>Save</button>
  <button formaction={bind(this.remove, { id: note.id })}>Delete</button>
</form>
```

The button submits the token as its own `name="_yx"` value, so it can't have a `name` or `value` of its own.

## Form helpers

Small behaviours, switched on with attributes:

| Attribute | On | Does |
|---|---|---|
| `data-yx-confirm="Sure?"` | form | asks before submitting |
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

Boosted links use the runtime's own cache (entries live 15 seconds and are used once). Ordinary links get a `<link rel="prefetch">`. A JSON prefetch is served to `window.yerd.fetch(url)` from client code.

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
- Handlers inside a `Local` run in the browser against the state; after each one the bindings refresh. Pushing to an array or editing a nested object just works.
- `s` is typed from `state`, so `s.likes++` and `hidden={s.open}` are checked by the compiler.
- Each `Local` has its own copy, so the same component can appear many times.

> [!WARNING]
> Handlers are sent to the browser as their source, so they can use the state (by the render prop's parameter name) and their event argument, nothing else from the server: no imports, no outer variables. A binding is a direct field read: `{s.count * 2}` renders the starting value but won't update, so compute it in the handler into another field. Compiling handlers needs `'unsafe-eval'` if you run a strict Content-Security-Policy.

Local state is gone on reload. For state that should last, keep it on the server: a field in the session (per visitor) or your database, changed through an action.

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

Set `YERD_SECRET` in production, or forms break on every restart. Details, options and rotation are in [sessions and auth](09-sessions-and-auth.md).
