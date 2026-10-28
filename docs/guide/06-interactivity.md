# Interactivity

The shop's cart changes without a reload: actions, Regions and field errors, all of them still plain forms with JavaScript off.

## The client runtime

The shop's `RootLayout` already has [Scripts](api:yerd.Scripts) in its `<head>`: it loads the runtime (about 8 KB compressed). Everything here is progressive enhancement: without it, forms and links still work with full page loads.

```tsx
// src/layouts.tsx, in <head>
<Stylesheet href="src/styles.css" />
<Scripts />
```

## Actions: forms that call methods

The product page's "Add to cart" button calls a method. Mark it with [@action](api:yerd.action) and pass it to a form's `action`:

```tsx
// src/routes/products.tsx
@route("/products/:id")
export class ProductPage {
  // ...catalog, id, cart

  @get page() {
    // ...
        <form action={this.add}>
          <button disabled={product.stock === 0}>Add to cart</button>
        </form>
    // ...
  }

  @action add() {
    const product = this.catalog.find(this.id);
    // ...a Conflict when the cart already holds all the stock
    this.cart.add(product.id);
    return (
      <>
        <CartBadge count={this.cart.count} />
        <Stock stock={product.stock} />
      </>
    );
  }
}
```

```diagram action
POST /products/7  _yx=(the form's token)
  -> verify token   it names ProductPage.add, signed for this visitor
  -> guards         the route's, if any
  -> add()          puts the notebook in the cart
  -> returns        <CartBadge> and <Stock>, two Regions, as HTML
  -> runtime        morphs both into the page; without JavaScript, a 303 back to /products/7
```

The runtime's post (it sends a `yx` header) gets the Regions; a plain form post is sent back to the page:

```answer
POST /products/7
_yx=(the form's token)
>>>
200 OK
content-type: text/html; charset=utf-8

<a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">1</span></a><p class="stock" aria-live="polite" id="stock" data-yx-region>12 in stock</p>
---
POST /products/7
_yx=(the form's token)
>>>
303 See Other
location: /products/7
```

- The form renders as a POST to the page's own URL with a signed `_yx` field naming the action: `<form action="/products/7" method="post" data-yx>`.
- `@param`, `@query`, `@session` and `@inject` accessors work in actions as in `@get`: `this.id` is the product on the page.
- An action runs behind its class's guards plus its own.

> [!TAKE]
> An action answers with HTML, not JSON. The code that rendered the page renders the change, so there's one template and no client state to keep in step. You give up optimistic updates: a change shows when the server answers.

## Regions

A [Region](api:yerd.Region) is a part of the page an action's response can replace. The header's cart badge is one; it renders an `a` (the `as` element) with your `id` and attributes.

```tsx
// src/layouts.tsx
export function CartBadge({ count }: { count: number }) {
  return (
    <Region id="cart-badge" as="a" href="/cart" class="cart-badge">
      Cart <span class="badge">{count}</span>
    </Region>
  );
}
```

- Updates are morphed in by `id` or `key`, so focus, scroll, an open `<details>` and typed text survive.
- Return several Regions in a fragment to update them in one round trip, as `add()` does.
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

Each line on the cart page has a remove button and a quantity box, so the action needs the line's id. Write the call: `action={() => this.remove({ id })}`, type-checked like any call.

```tsx
// src/routes/cart.tsx
{lines.map(({ product, qty, subtotal }) => (
  <li key={product.id}>
    <a href={`/products/${product.id}`}>{product.name}</a>
    {/* The id is signed into the action; the quantity is a form field. */}
    <form action={({ form }) => this.setQty({ id: product.id }, form)}>
      <input id={`qty-${product.id}`} name="qty" type="number" min="0" max="99" value={qty} data-yx-submit />
      <button>Update</button>
      <span class="field-error" data-yx-error="qty"></span>
    </form>
    <Price cents={subtotal} />
    <form action={() => this.remove({ id: product.id })}>
      <button aria-label={`Remove ${product.name}`}>Remove</button>
    </form>
  </li>
))}

// ...
@action setQty({ id }: { id: number }, form: ActionForm) {
  const { qty } = form.parse(QtyForm);
  this.cart.setQty(id, qty);
  return this.regions(); // the cart's lines and the badge
}

@action remove({ id }: { id: number }) {
  this.cart.remove(id);
  return this.regions();
}
```

```answer
POST /cart
_yx=(the quantity form's token)&qty=3
>>>
200 OK
content-type: text/html; charset=utf-8

<div id="cart" data-yx-region><ul class="lines"><li data-key="7"><a href="/products/7">Field notebook</a><!-- ... --><span class="price">$72.00</span><!-- ... --></li></ul><p class="total">Total <span class="price">$72.00</span></p><a class="button" href="/checkout">Check out</a></div><a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">3</span></a>
---
POST /cart
_yx=(the remove button's token)
>>>
200 OK
content-type: text/html; charset=utf-8

<div id="cart" data-yx-region><p class="empty">Your cart is empty. <a href="/">Go shopping</a>.</p></div><a href="/cart" class="cart-badge" id="cart-badge" data-yx-region>Cart <span class="badge">0</span></a>
```

- The lambda runs at render; its arguments are signed into the token, so a visitor can't change them. Still check the user owns the id ([action tokens](15-security.md#action-tokens)).
- `({ form }) => ...` passes the submitted fields on as an [ActionForm](api:yerd.ActionForm).
- An action without arguments is passed as is (`action={this.add}`); one with arguments must be called. Hand actions to components typed as [Action](api:yerd.Action)`<Args>`; [bind](api:yerd.bind)`(this.remove, { id })` does the same outside JSX.
- `data-yx-submit` submits the form when the number changes; `key` lets the morph match list items.

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
- They're read when the action fires, so pass them straight into the arguments: `el.value.trim()` throws at render. Booleans and numbers arrive typed, the rest as strings.
- An element with a `name` also sends its value as a form field: `<input name="title" action={this.rename} trigger="change" />`.

> [!NOTE]
> Their contents are browser input: validate them ([values the browser fills in](15-security.md#values-the-browser-fills-in)). A plain form post can't fill them and gets a 400.

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
```

- A newer run cancels one still in flight, so results never arrive stale.
- "Once per render": again only when a response gives the element a new action.
- Keys are `KeyboardEvent.key` values; a filtered key's default is prevented, so `keydown:Enter` doesn't also submit.
- A response can change or remove the trigger, so a poll can stop itself: see [poll a long job](16-recipes.md#poll-a-long-job-until-its-done) and [load a slow panel](16-recipes.md#load-a-slow-panel-after-the-page).
- Nested actions: the innermost wins, and the event still bubbles to your own listeners.

### Typeahead

Search 200 ms after typing stops; without JavaScript it's a plain search form.

```tsx
@route("/people")
export class People {
  @query("q") accessor q = "";

  @get page() {
    return (
      <main>
        {/* No JavaScript: Enter loads /people?q=... and the page renders the results. */}
        <form method="get" role="search">
          <input type="search" name="q" value={this.q} autocomplete="off"
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
<section class="column" action={({ drag }) => move({ card: drag.data("id"), to: status })} trigger="drop">
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
```

During a drag, the dragged element has `data-yx-dragging` and the target `data-yx-over`, for CSS.

| `trigger` | Takes |
|---|---|
| `"drop"` | any of the page's `draggable` elements |
| `"drop:.task"` | only draggables matching the selector |
| `"drop:files"` | files from the desktop, filtered by the element's `accept` |

- A target never takes a drop of itself or its contents; when targets nest, the innermost that accepts the drag wins.
- It needs the runtime, so give important moves another way in (a select, buttons). Validate `drag.data("id")`.
- The [kanban recipe](16-recipes.md#kanban-drag-and-drop) has the full board.

### Dropping files

A `drop:files` target posts files to its action as they land, as multipart under `files`:

```tsx
// in page():
<div class="dropzone" action={this.upload} trigger="drop:files" accept="image/*,.pdf">Drop photos or PDFs</div>

// the action:
@action async upload(_: {}, form: ActionForm) {
  for (const file of form.files("files")) {
    // `accept` filters in the browser; the server still decides.
    if (!file.type.startsWith("image/") && file.type !== "application/pdf") throw new UnsupportedMediaType(`${file.name} isn't a photo or a PDF`);
    // ...store it
  }
  return this.list();
}
```

To send them with a form instead, point a zone at a file input with `dropTo`:

```tsx
<form action={this.post} enctype="multipart/form-data">
  <input id="photos" type="file" name="photos" multiple accept="image/*" />
  <div class="dropzone" dropTo="#photos">Drop photos here</div>
  <button>Post</button>
</form>
```

- Drops add to the input's files, filtered by its `accept`, one unless it's `multiple`. Folders are skipped; refused files are left out with a notice.
- The action reads them like any upload: `form.files("photos")`, or `is.files()` in a DTO. The zone gets `data-yx-files="<count>"` while the input holds files.
- Mind the body limit (1 MiB by default; `@bodyLimit("25mb")` on the action raises it there); see the [photo upload recipe](16-recipes.md#upload-photos-with-a-form).

### Infinite scroll

`<Region append>` in a response adds its children to the end (`prepend`: the start), updating any whose id or key is already there. A `visible` sentinel loads the next page and is replaced each time:

```tsx
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

// in the route: the page renders <Region id="posts" as="ul"> and <More page={2} load={this.more} />
@action more({ page }: { page: number }) {
  return (
    <>
      <Region id="posts" as="ul" append>{posts(page).map((p) => <li key={p.id}>{p.title}</li>)}</Region>
      <More page={page + 1} load={this.more} />
    </>
  );
}
```

The last page sends an empty `more` Region, which stops it.

## Reading the form

[ActionForm](api:yerd.ActionForm) reads the submitted fields. The cart's `setQty` uses `parse()` with a one-field DTO:

| Method | Returns |
|---|---|
| `get(name)` | the first value, or `undefined` |
| `string(name)` | the first value; a 400 if it's missing |
| `all(name)` | every value of a repeated field |
| `has(name)` | whether it was sent (checkboxes) |
| `parse(Dto)` | the form validated into a DTO; a 400 listing every issue otherwise |
| `file(name)` / `files(name)` | uploaded `File`s (an empty file input counts as none) |

- DTOs take uploads with `is.file()` ([request data](03-request-data.md#uploads)). Give file forms `enctype="multipart/form-data"` for when JavaScript is off.

### Errors

A thrown [YerdError](api:yerd.YerdError) (from `parse()` too) answers the action with its status, and the runtime shows its message. The quantity box and the sold-out button:

```answer
POST /cart
_yx=(the quantity form's token)&qty=-1
>>>
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Validation failed","code":"validation_failed","issues":[{"path":"qty","message":"Must be from 0 to 99 (got -1)"}]}
---
POST /products/8
_yx=(the form's token)
>>>
409 Conflict
content-type: application/json; charset=utf-8

{"error":"Sold out.","code":"conflict"}
```

- A field's message goes into its `[data-yx-error="qty"]` box, else the form's `[data-yx-error]`, labelled with the field's `<label>` or name. With neither, a small notice shows it.
- Invalid fields get `aria-invalid="true"`, and the first is focused. All of it clears on the next submit.
- An issue on a list item (`photos[0]`) goes to the list's box unless the item has one. Expired tokens are handled for you: see [stale pages](15-security.md#stale-pages).

Without JavaScript, a thrown error renders the error page. The checkout must work either way, so for a plain post it flashes the messages and the input into the session and redirects back:

```tsx
// src/routes/checkout.tsx
@action async place(_: {}, form: ActionForm) {
  let details: CheckoutForm;
  try {
    details = form.parse(CheckoutForm);
  } catch (error) {
    // From the runtime (it sends a `yx` header): rethrow, and each issue lands in its field's box.
    if (!(error instanceof ValidationFailed) || currentContext().headers.yx !== undefined) throw error;
    // A plain form post: keep the messages and the input for the page we send it back to.
    const errors: Record<string, string> = {};
    for (const { path, message } of error.issues) errors[path] ??= message;
    const draft = { name: form.get("name"), email: form.get("email"), address: form.get("address") };
    this.session.flash("checkout", { errors, draft } satisfies CheckoutState);
    return redirect("/checkout");
  }
  // ...place the order
}
```

The page reads the flash and fills each `Field`'s value and error box. A plain post, then the page it lands on:

```answer
POST /checkout
_yx=(the form's token)&name=A&email=nope&address=
>>>
303 See Other
location: /checkout
---
GET /checkout
200 OK
content-type: text/html; charset=utf-8

<!-- ... --><p class="field"><label for="email">Email</label><input id="email" name="email" type="email" value="nope" autocomplete="email" aria-invalid="true"><span class="field-error" data-yx-error="email">Expected an email address</span></p><!-- ... -->
```

To replace the built-in notice, handle `yx:notice` (in a script after `<Scripts />`):

```js
document.addEventListener("yx:notice", (event) => {
  event.preventDefault(); // no built-in notice
  showToast(event.detail.message);
});
```

## Submit buttons with their own action

`formaction={action}` on a submit button posts to that action instead of the form's. The button can't have its own `name` or `value`: it submits the token.

```tsx
<form action={this.save}>
  <input name="title" />
  <button>Save</button>
  <button formaction={() => this.remove({ id: note.id })}>Delete</button>
</form>
```

## Form helpers

Small behaviours switched on by attribute:

| Attribute | On | Does |
|---|---|---|
| `data-yx-confirm="Sure?"` | form, or any element with an `action` | asks before submitting or firing |
| `data-yx-reset` | form | clears the form after a successful submit |
| `data-yx-submit` | input | submits its form on change (the cart's quantity box) |
| `data-yx-error` | element in a form | where error messages go |
| `data-yx-keep` | any element | morphs leave it and its children alone (widgets, canvases) |

A form in flight gets `aria-busy="true"` with its buttons disabled, a form in a `<details>` closes it on success, and elements a morph inserts get `data-yx-new` (for entrance animations).

## Boosted links

`data-yx-boost` on a link or an ancestor makes clicks fetch the page and morph `<body>` instead of reloading.

```tsx
<nav data-yx-boost>
  <a href="/cart">Cart</a>
  <a href="/catalog.pdf">Catalog</a>    {/* files are left to the browser */}
  <a href="https://example.com">Out</a> {/* so are other origins */}
</nav>
```

- History, Back/Forward and scroll position work.
- Links with `target`, `download` or `rel="external"` are left alone; `data-yx-boost="false"` opts a subtree out.

## Live refresh

The product page's stock changes when someone else buys. Point `data-yx-live` at a Server-Sent Events route, and every message refreshes the page's Regions:

```tsx
// src/routes/products.tsx, in the product page
<div data-yx-live={`/products/${product.id}/stock`} hidden></div>
```

- [Streaming and live](07-streaming-and-live.md#server-sent-events) builds the feed behind it.
- Only plain `data:` messages refresh; named events are ignored. A reconnect also refreshes, in case messages were missed.

## Auto mode

`<Scripts auto />` makes the runtime handle every same-origin link and form without attributes.

- Links are boosted, with the same exceptions as `data-yx-boost`; `data-yx-boost="false"` still opts out.
- Forms go through `fetch`; a plain form to a `@post` route has its redirect followed and morphed in, so no Regions are needed.
- A link the mouse slows down toward is prefetched.

## Prefetching

The `prefetch` prop warms the next page before the click.

```tsx
<a href="/cart" prefetch>Cart</a>                       {/* on hover, focus or touch */}
<a href="/?category=pens" prefetch="visible">Pens</a>   {/* when scrolled into view */}
<a href="/" prefetch="load">Home</a>                    {/* right away */}
<section prefetch={{ url: "/api/products", as: "json", on: "visible" }}>...</section>
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
          <button onClick={() => (s.open = !s.open)} aria-expanded={s.open}>Details</button>
          <p hidden={not(s.open)}>Only shown when open.</p>
          <button class={{ liked: s.likes }} onClick={() => s.likes++}>Like ({s.likes})</button>
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
<Local state={{ i: 0, n: photos.length }}>
  {(s) => (
    <div class="gallery">
      {photos.map((src, n) => <img src={src} alt="" hidden={not(eq(s.i, n))} />)}
      <button aria-label="Next" onClick={() => (s.i = (s.i + 1) % s.n)}>›</button>
      {photos.map((src, n) => (
        <button class={["thumb", { active: eq(s.i, n) }]} data-n={n}
          onClick={(e: Event) => (s.i = Number((e.currentTarget as HTMLElement).dataset.n))}>{n + 1}</button>
      ))}
    </div>
  )}
</Local>
```

Handlers can't see `n`, so the count is in the state and each thumbnail carries `data-n`.

### Keeping it across reloads

`persist` saves the state to browser storage after every handler and restores it on load.

```tsx
<Local state={{ collapsed: false }} persist="prefs">
  {(s) => <button onClick={() => (s.collapsed = !s.collapsed)} aria-expanded={not(s.collapsed)}>Menu</button>}
</Local>
```

- `persist="prefs"` uses localStorage; `persist={{ key: "prefs", storage: "session" }}` uses sessionStorage (this tab only).
- Saved values merge over `state`, so new fields start at their defaults. `Local`s sharing a key stay in step, across tabs too.
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

const button = <button tooltip="Remove this line">x</button>;
```

- `client` runs when an element with the attribute appears (load, morph, boosted page) and may return nothing, a cleanup, or `{ update, disconnect }`.
- Its third argument is the runtime API, [YerdClient](api:yerd.YerdClient): `yerd.page` (`refresh()`, `load()`, `apply()`, `morph()`), `yerd.net` (`prefetch()`, `fetch()`) and `yerd.clock` (`now()`, `sync()`).
- Define attributes at module level in a file the server imports; names are lowercase and dashed.

> [!WARNING]
> The client half is shipped as source: no imports or module variables, only `(el, value, yerd)`. A half that needs imports can be a module: see [lazy attribute halves](17-client-code.md#lazy-attribute-halves).

For bigger client code, see [Client code](17-client-code.md).

## Security in brief

Actions need no CSRF tokens: `_yx` is signed, expires (`actionTtl`, a day) and is session-bound, and cross-site writes are refused ([security](15-security.md)). Set `YERD_SECRET` in production or forms break on restart.
