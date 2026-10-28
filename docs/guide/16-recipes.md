# Recipes

Whole solutions to common problems, most of them on the shop. Each links to the guides for the pieces it uses. More live next to their feature:

| Task | Where |
| --- | --- |
| Search as you type | [Typeahead](06-interactivity.md#typeahead) |
| Load more as you scroll | [Infinite scroll](06-interactivity.md#infinite-scroll) |
| Drop files to upload them at once | [Dropping files](06-interactivity.md#dropping-files) |
| An image slider or tabs with no server | [Comparing: eq()](06-interactivity.md#comparing-eq) |
| Send the receipt after checkout, in the background | [Background work after checkout](14-events.md#recipe-background-work-after-checkout) |
| Ask another service for a price | [A typed shipping quote](14-events.md#recipe-a-typed-shipping-quote) |
| Session ids your store expects | [Custom session ids](09-sessions-and-auth.md#custom-session-ids) |
| Sessions in Redis or a database | [Your own store](09-sessions-and-auth.md#your-own-store) |
| Every open tab updates on a change | [Per-user live feeds](07-streaming-and-live.md#per-user-live-feeds) |
| A crawler-friendly variant of a page | [Variants per request](02-routing.md#variants-per-request-getwhen) |
| PATCH that only changes what was sent | [Partial updates](03-request-data.md#partial-updates-patch) |
| Timing every request | [Middleware](02-routing.md#middleware) |

The examples keep data in memory; swap the services for your database.

## Paginate the catalog

The front page shows three products at a time, with previous and next links that keep the search. Uses [@query](03-request-data.md#transforms-and-validators) with a validator.

```tsx
// src/routes/products.tsx
import { NotFound, between, toInt /* , ... */ } from "@toyz/yerd";

const PER_PAGE = 3;

/** Previous / next links that keep the search and category. */
function Pager({ page, pages, params }: { page: number; pages: number; params: Record<string, string | undefined> }) {
  const href = (n: number) => {
    const search = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1]));
    if (n > 1) search.set("page", String(n));
    return `/?${search}`;
  };
  return (
    <nav class="pager" aria-label="Pages">
      {page > 1 ? <a href={href(page - 1)} rel="prev">Previous</a> : null}
      <span>Page {page} of {pages}</span>
      {page < pages ? <a href={href(page + 1)} rel="next">Next</a> : null}
    </nav>
  );
}

@route("/", { meta: { title: "Shop" } })
export class ProductList {
  // ...catalog, q, category
  @query("page", { transform: toInt, validate: between(1, 1000) }) accessor pageNo = 1;

  @get page() {
    const found = this.catalog.search({ q: this.q, category: this.category });
    const pages = Math.max(1, Math.ceil(found.length / PER_PAGE));
    if (this.pageNo > pages) throw new NotFound(`There is no page ${this.pageNo}`);
    const products = found.slice((this.pageNo - 1) * PER_PAGE, this.pageNo * PER_PAGE);
    return (
      <>
        {/* ...search form and categories */}
        <ul class="grid">{products.map((p) => <ProductCard product={p} />)}</ul>
        <Pager page={this.pageNo} pages={pages} params={{ q: this.q, category: this.category }} />
      </>
    );
  }
}
```

```answer
GET /?page=3
200 OK
content-type: text/html; charset=utf-8

<!-- ... --><ul class="grid"><li class="card"><a href="/products/7">Field notebook</a><span class="price">$24.00</span></li><li class="card"><a href="/products/8">Dot grid journal</a><span class="price">$32.00</span><span class="sold-out">Sold out</span></li></ul><nav class="pager" aria-label="Pages"><a href="/?page=2" rel="prev">Previous</a><span>Page 3 of 3</span></nav><!-- ... -->
---
GET /?page=9
404 Not Found
content-type: application/json; charset=utf-8

{"error":"There is no page 9","code":"not_found"}
---
GET /?page=0
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Must be from 1 to 1000 (got 0)","code":"validation_failed","issues":[{"path":"page","message":"Must be from 1 to 1000 (got 0)"}]}
```

- **The accessor isn't `page`:** the handler has that name. Page 1 has no `?page=`, so the front page keeps one URL.
- **A page past the end is a 404**, so a stale link doesn't show an empty grid.
- **A database** pages with `LIMIT` and `OFFSET`, plus a count; past a few thousand rows, page by the last id seen instead.

## Rate-limit sign-in

At most five sign-in attempts a minute from one address, declared on the action with a decorator of your own. Uses [methodValue](03-request-data.md#method-and-class-decorators) and a [guard](02-routing.md#guards) that reads it through `ctx.route`.

```ts
// src/limits.ts
import { TooManyRequests, createGuard, methodValue } from "@toyz/yerd";

/** `@perMinute(5)`: at most that many calls a minute from one address. */
export const perMinute = methodValue<number>("perMinute", {
  validate: (n) => (Number.isInteger(n) && n > 0 ? undefined : "a whole number above 0"),
});

const hits = new Map<string, { minute: number; count: number }>();

/** One guard for the app: it enforces @perMinute on whichever method serves the request. */
export const rateLimited = createGuard("rateLimited", (ctx) => {
  const max = perMinute.get(ctx.route.target!, ctx.route.method!);
  if (max === undefined) return;
  const key = `${ctx.request.socket.remoteAddress} ${ctx.route.className}.${String(ctx.route.method)}`;
  const minute = Math.floor(Date.now() / 60_000);
  const seen = hits.get(key);
  if (seen?.minute !== minute) hits.set(key, { minute, count: 1 });
  else if (++seen.count > max) return new TooManyRequests("Too many tries. Wait a minute.", { retryAfter: 60 });
});
```

```tsx
// src/app.ts: .guard(rateLimited) after .use(auth)

// src/routes/auth.tsx
@action @perMinute(5) async submit(_: {}, form: ActionForm) {
  // ...unchanged
}
```

The sixth wrong password inside a minute:

```answer
POST /login
_yx=(the form's token)&name=ada&password=wrong
>>>
429 Too Many Requests
content-type: application/json; charset=utf-8
retry-after: 60

{"error":"Too many tries. Wait a minute.","code":"too_many_requests"}
```

- **One guard, many limits.** `ctx.route.method` is the action being posted (or the handler), so any method can carry `@perMinute(n)`.
- **The runtime shows the message** in the form's `data-yx-error` box; a plain post gets the error page.
- **Behind a proxy** the socket address is the proxy's: key on the first `X-Forwarded-For` hop your proxy sets.
- **One process only.** The map lives in memory; several instances need a shared counter (Redis `INCR` with an expiry).

## Cache the product API

The JSON API answers the same for everyone: let browsers and CDNs keep it a minute, and answer a revalidation with a 304. Uses [@setHeader](04-responses.md#status-and-setheader), [res()](04-responses.md#res-for-full-control) and [@header](03-request-data.md#accessors).

```ts
// src/routes/api.ts
import { createHash } from "node:crypto";
import { header, res, setHeader /* , ... */ } from "@toyz/yerd";

@route("/api/products", { session: false })
export class ProductsApi {
  // ...catalog, q, category
  @header("if-none-match") accessor ifNoneMatch: string | undefined;

  @get @setHeader("cache-control", "public, max-age=60") list() {
    const products = this.catalog.search({ q: this.q, category: this.category });
    const etag = `"${createHash("sha256").update(JSON.stringify(products)).digest("base64url").slice(0, 16)}"`;
    if (this.ifNoneMatch === etag) return res(null, { status: 304, headers: { etag } });
    return res(products, { headers: { etag } });
  }
}
```

The first request, then the same one sending its ETag as `If-None-Match`:

```answer
GET /api/products?category=desk
200 OK
content-type: application/json; charset=utf-8
cache-control: public, max-age=60
etag: "af2783UEEIRdZYrX"

[{"id":4,"name":"Desk lamp","category":"desk","price":6500,"stock":3,"description":"Warm light, one arm, no app."},{"id":5,"name":"Brass ruler","category":"desk","price":1800,"stock":9,"description":"Thirty centimetres, gets better with age."}]
---
GET /api/products?category=desk
304 Not Modified
cache-control: public, max-age=60
etag: "af2783UEEIRdZYrX"
```

- **`session: false`** matters: no cookie goes out, so a shared cache can't store one visitor's session.
- **Never on pages with forms or a cart badge.** They carry the visitor's tokens; yerd marks them `private, no-cache` ([caching headers](04-responses.md#caching-headers)).
- **Hashing the body** still runs the query; an ETag from a version or `updatedAt` skips the work.

## Per-field form errors

Each message under its own field, with and without JavaScript: the shop's checkout. Uses [DTO validation](03-request-data.md#bodies-and-dto-classes), [field error boxes](06-interactivity.md#errors) and [flash](09-sessions-and-auth.md#the-session-api).

With the runtime, a thrown validation error lands in each field's `[data-yx-error="<field>"]` box by itself. A plain post would get the error page, so the action flashes the messages and input and goes back to the form, which renders them in the same boxes:

```tsx
// src/components.tsx
export function Field(props: { name: string; label: string; type?: string; value?: string | undefined; error?: string | undefined }) {
  const { name, label, type = "text", value, error } = props;
  return (
    <p class="field">
      <label for={name}>{label}</label>
      <input id={name} name={name} type={type} value={value} aria-invalid={error ? true : undefined} />
      <span class="field-error" data-yx-error={name}>{error}</span>
    </p>
  );
}
```

```tsx
// src/routes/checkout.tsx
interface CheckoutState {
  errors?: Record<string, string>;
  draft?: Record<string, string | undefined>;
}

  @get page() {
    // ...
    const { errors = {}, draft = { name: this.me.name } } = (this.session.flash("checkout") ?? {}) as CheckoutState;
    return (
      <form action={this.place}>
        <Field name="name" label="Name" value={draft.name} error={errors.name} />
        <Field name="email" label="Email" type="email" value={draft.email} error={errors.email} />
        <Field name="address" label="Address" value={draft.address} error={errors.address} />
        <p class="form-error" data-yx-error role="alert"></p>
        <button>Place order</button>
      </form>
    );
  }

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

The runtime's post, then a plain post and the page it goes back to:

```answer
POST /checkout
_yx=(the form's token)&name=A&email=nope&address=
>>>
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Validation failed","code":"validation_failed","issues":[{"path":"name","message":"Must be 2 to 80 characters (got 1)"},{"path":"email","message":"Expected an email address"},{"path":"address","message":"Can't be empty"}]}
---
POST /checkout
_yx=(the form's token)&name=A&email=nope&address=
>>>
303 See Other
location: /checkout
---
GET /checkout
200 OK
content-type: text/html; charset=utf-8

<!-- ... --><p class="field"><label for="name">Name</label><input id="name" name="name" type="text" value="A" autocomplete="name" aria-invalid="true"><span class="field-error" data-yx-error="name">Must be 2 to 80 characters (got 1)</span></p><p class="field"><label for="email">Email</label><input id="email" name="email" type="email" value="nope" autocomplete="email" aria-invalid="true"><span class="field-error" data-yx-error="email">Expected an email address</span></p><!-- ... -->
```

- **One markup for both.** The server fills the same boxes the runtime writes into (and clears on the next submit).
- **Your own errors.** For a check of your own (the email is taken), throw a `YerdError` with `details: { issues: [{ path: "email", message: "That email is taken" }] }`.
- **List fields.** An issue for `tags[1]` belongs to the `tags` box; strip the index when you build `errors`. How unmatched messages are placed is in [field error boxes](06-interactivity.md#errors).
- **Never redisplay secrets.** Leave passwords and card numbers out of the flashed draft.

## Show a saved cart after sign-in

A guest fills a cart, signs in, and finds it merged with the one they left last week on another device. Uses a [session shape class](09-sessions-and-auth.md#a-class-for-methods-and-defaults), [createAuth hooks](09-sessions-and-auth.md#keeping-a-guests-cart-across-sign-in) and a [service](08-services.md).

The cart is a session shape like the shop's, with `lines` of `{ id, name, qty }`. Saved carts are a service, and a notice is its own small shape:

```ts
// src/cart.ts
/** A one-time notice after sign-in, kept apart from the cart. */
export class CartNotice {
  welcomeBack?: number;
}

/** Saved carts, one per user: a table in a real app. */
@service
export class Carts {
  #saved = new Map<string, Line[]>();

  load(userId: string): Line[] {
    return structuredClone(this.#saved.get(userId) ?? []);
  }

  save(userId: string, lines: Line[]): void {
    this.#saved.set(userId, structuredClone(lines));
  }
}

/** The saved cart plus the guest's: the same item's quantities add up. */
export function mergeCarts(saved: Line[], guest: Line[]): Line[] {
  const merged = new Map<string, Line>();
  for (const line of [...saved, ...guest]) {
    const into = merged.get(line.id);
    if (into) into.qty += line.qty;
    else merged.set(line.id, { ...line });
  }
  return [...merged.values()];
}
```

The auth hooks merge on sign-in and save on sign-out, through `session.as(Cart)`:

```ts
// src/users.ts
export const auth = createAuth<User>({
  load: (id) => resolve(Users).get(id),
  onLogin(user, session) {
    const carts = resolve(Carts);
    const cart = session.as(Cart);
    const saved = carts.load(user.id);
    cart.lines = mergeCarts(saved, cart.lines);
    if (saved.length > 0) session.as(CartNotice).welcomeBack = saved.length;
    carts.save(user.id, cart.lines);
  },
  onLogout(user, session) {
    if (user) resolve(Carts).save(user.id, session.as(Cart).lines);
  },
});
```

The cart page says "welcome back" once, and saves a signed-in user's cart on every change, since someone who never signs out never runs `onLogout`:

```tsx
// src/routes/cart.tsx
@route("/cart")
export class CartPage {
  @session(Cart) accessor cart!: Session<Cart>;
  @session(CartNotice) accessor notice!: Session<CartNotice>;
  @auth.maybeUser accessor me: User | undefined;
  @inject(Carts) accessor carts!: Carts;

  @get page() {
    const back = this.notice.welcomeBack;
    if (back) this.notice.welcomeBack = undefined; // shown once
    return (
      <main>
        <h1>Your cart</h1>
        {back ? <p role="status">Welcome back: we kept {back} item{back === 1 ? "" : "s"} from last time.</p> : null}
        {this.lines()}
      </main>
    );
  }

  lines() {
    return (
      <Region id="cart" as="ul">
        {this.cart.lines.map((line) => (
          <li key={line.id}>
            {line.name} x {line.qty}
            <form action={() => this.remove({ id: line.id })}>
              <button aria-label={`Remove ${line.name}`}>Remove</button>
            </form>
          </li>
        ))}
      </Region>
    );
  }

  @action remove({ id }: { id: string }) {
    this.cart.remove(id);
    if (this.me) this.carts.save(this.me.id, this.cart.lines);
    return this.lines();
  }
}
```

Gel pens added as a guest on one device, then again on another, signing in each time:

```answer
GET /cart
200 OK
content-type: text/html; charset=utf-8

<main><h1>Your cart</h1><p role="status">Welcome back: we kept 1 item from last time.</p><ul id="cart" data-yx-region><li data-key="p2">Gel pens x 2<!-- ... --></li></ul></main>
```

- **Only a guest's cart is merged.** If someone else was still signed in, `login()` starts a fresh session.
- **Logout empties the cart on screen.** The saved copy comes back at the next sign-in.
- **Cookie size.** With the default `CookieStore` the whole session must fit in about 4 KB; big carts need [a store](09-sessions-and-auth.md#which-store).
- **Prices change.** Store ids and quantities, as the shop does; look prices up when showing the cart.

## Upload photos with a form

A post with a title and up to ten photos, picked or dropped, sent on submit. Uses [is.files](03-request-data.md#uploads), [dropTo](06-interactivity.md#dropping-files) and [@bodyLimit](api:yerd.bodyLimit).

```tsx
// src/routes/new-post.tsx
import { ActionForm, action, bodyLimit, get, inject, is, length, redirect, route, service, trim } from "@toyz/yerd";

@service
export class Photos {
  #files = new Map<string, Uint8Array>();

  async save(file: File): Promise<string> {
    const id = crypto.randomUUID();
    this.#files.set(id, new Uint8Array(await file.arrayBuffer()));
    return id;
  }
}

class NewPost {
  @is.string({ transform: trim, validate: length(1, 80) }) title!: string;
  @is.files({ types: ["image/png", "image/jpeg", "image/webp"], maxSize: 5_000_000, max: 10, optional: true }) photos?: File[];
}

@route("/posts/new")
export class NewPostPage {
  @inject(Photos) accessor photos!: Photos;

  @get page() {
    return (
      <form action={this.create} enctype="multipart/form-data">
        <label for="title">Title</label>
        <input id="title" name="title" required />
        <span class="field-error" data-yx-error="title"></span>

        <label for="photos">Photos</label>
        <input id="photos" type="file" name="photos" multiple accept="image/png,image/jpeg,image/webp" />
        <div class="dropzone" dropTo="#photos">Or drop photos here</div>
        <span class="field-error" data-yx-error="photos"></span>

        <p data-yx-error role="alert"></p>
        <button>Post</button>
      </form>
    );
  }

  // Ten photos of 5 MB each must fit in one request; every other route keeps the 1 MiB default.
  @action @bodyLimit("55mb") async create(_: {}, form: ActionForm) {
    const post = form.parse(NewPost);
    const ids = await Promise.all((post.photos ?? []).map((photo) => this.photos.save(photo)));
    console.log(`"${post.title}" with ${ids.length} photos`);
    return redirect("/posts");
  }
}
```

```css
.dropzone[data-yx-files]::after { content: " (" attr(data-yx-files) " ready)"; }
.dropzone[data-yx-over] { outline: 2px dashed currentColor; }
```

A PNG, then a text file, posted as `multipart/form-data` by the runtime:

```answer
POST /posts/new
_yx=(the form's token)&title=Desk tour&photos=(desk.png)
>>>
200 OK
yx-location: /posts
---
POST /posts/new
_yx=(the form's token)&title=Desk tour&photos=(notes.txt)
>>>
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Validation failed","code":"validation_failed","issues":[{"path":"photos[0]","message":"notes.txt has type text/plain, which isn't accepted (image/png, image/jpeg, image/webp)"}]}
```

- **Two limits.** `maxSize` is per file (an issue for `photos[n]`); `@bodyLimit` caps the whole request (413 before the action runs). Set it on the upload action alone, to fit all files plus fields.
- **Types are what the browser says.** `types` checks the declared mime type and `accept` only filters the picker and drops. Check the bytes if it matters.
- **Staging.** Drops add to the input, filtered by `accept`; the zone gets `data-yx-files` with the count. Without JavaScript the input still works.
- **Memory.** The body is read into memory first. For huge uploads, send them from the browser straight to object storage (a presigned URL) and post the result.

## Kanban drag and drop

Drag cards between three columns, drop on a card to go above it, drop on the bin to delete; every open board updates. Uses [drop triggers](06-interactivity.md#drag-and-drop), [Regions](06-interactivity.md#regions), [validation of browser values](15-security.md#values-the-browser-fills-in) and [live refresh](06-interactivity.md#live-refresh).

```ts
// src/board.ts
import { Channels, channel, inject, is, length, matches, service, trim } from "@toyz/yerd";

export type Status = "todo" | "doing" | "done";
export const COLUMNS: Array<[Status, string]> = [["todo", "To do"], ["doing", "Doing"], ["done", "Done"]];

export interface Card {
  id: string;
  title: string;
  status: Status;
}

export const boardChannel = channel<{ at: number }>("board");

/** A move as it arrives: `card` and `before` are read by the browser when the card lands. */
export class Move {
  @is.string({ validate: matches(/^c\d+$/, "Not a card id") }) card!: string;
  @is.oneOf(["todo", "doing", "done"]) to!: Status;
  @is.string({ optional: true, validate: matches(/^c\d+$/, "Not a card id") }) before?: string;
}

/** A card id from the browser (the bin's `drag.data("id")`). */
export class CardRef {
  @is.string({ validate: matches(/^c\d+$/, "Not a card id") }) card!: string;
}

export class CardTitle {
  @is.string({ transform: trim, validate: length(1, 80) }) title!: string;
}

@service
export class Board {
  @inject(Channels) accessor channels!: Channels;
  #next = 1;
  #cards: Card[] = [];

  column(status: Status): Card[] {
    return this.#cards.filter((c) => c.status === status);
  }

  add(title: string): void {
    this.#cards.push({ id: `c${this.#next++}`, title, status: "todo" });
    this.#changed();
  }

  move({ card: id, to, before }: Move): void {
    const card = this.#cards.find((c) => c.id === id);
    if (!card || id === before) return;
    this.#cards = this.#cards.filter((c) => c !== card);
    card.status = to;
    const at = before ? this.#cards.findIndex((c) => c.id === before) : -1;
    if (at >= 0) this.#cards.splice(at, 0, card);
    else this.#cards.push(card);
    this.#changed();
  }

  remove(id: string): void {
    this.#cards = this.#cards.filter((c) => c.id !== id);
    this.#changed();
  }

  #changed(): void {
    void this.channels.publish(boardChannel, { at: Date.now() });
  }
}
```

```tsx
// src/routes/board.tsx
import { ActionForm, Channels, Region, action, get, inject, parse, route, signal, sse } from "@toyz/yerd";
import { Board, COLUMNS, CardRef, CardTitle, Move, boardChannel, type Card, type Status } from "../board.js";

@route("/board/events")
export class BoardEvents {
  @inject(Channels) accessor channels!: Channels;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe(boardChannel, this.stop);
  }
}

@route("/board")
export class BoardPage {
  @inject(Board) accessor board!: Board;

  @get page() {
    return (
      <main>
        <div data-yx-live="/board/events" hidden></div>
        <form action={this.add} data-yx-reset>
          <input name="title" placeholder="New card" required maxlength={80} />
          <button>Add</button>
          <span data-yx-error></span>
        </form>
        {this.columns()}
        <div class="bin" action={({ drag }) => this.remove({ id: drag.data("id") })} trigger="drop:.card" data-yx-confirm="Throw this card away?">
          Drop a card here to delete it
        </div>
      </main>
    );
  }

  columns() {
    return (
      <Region id="board" class="board">
        {COLUMNS.map(([status, label]) => (
          <section class="column" action={({ drag }) => this.move({ card: drag.data("id"), to: status })} trigger="drop">
            <h2>{label}</h2>
            <ul>{this.board.column(status).map((card) => this.card(card, status))}</ul>
          </section>
        ))}
      </Region>
    );
  }

  card(card: Card, status: Status) {
    return (
      // A drop target too: a card dropped here goes above this one (the innermost target wins).
      <li key={card.id} class="card" data-id={card.id} draggable="true"
        action={({ drag }) => this.move({ card: drag.data("id"), to: status, before: card.id })} trigger="drop">
        {card.title}
        {/* Drag and drop needs JavaScript: plain forms move cards without it, and from a keyboard. */}
        {COLUMNS.filter(([s]) => s !== status).map(([s, label]) => (
          <form action={() => this.move({ card: card.id, to: s })}>
            <button aria-label={`Move ${card.title} to ${label}`}>{label}</button>
          </form>
        ))}
      </li>
    );
  }

  @action add(_: {}, form: ActionForm) {
    this.board.add(form.parse(CardTitle).title);
    return this.columns();
  }

  @action move(args: { card: string; to: Status; before?: string }) {
    this.board.move(parse(Move, args)); // the ids came from the browser: validate them
    return this.columns();
  }

  @action remove({ id }: { id: string }) {
    this.board.remove(parse(CardRef, { card: id }).card);
    return this.columns();
  }
}
```

```css
.card[data-yx-dragging] { opacity: 0.4; }
.column[data-yx-over], .card[data-yx-over], .bin[data-yx-over] { outline: 2px dashed currentColor; }
```

"Ship it" dropped on the Done column, then a card id someone typed in by hand:

```answer
POST /board
_yx=(the Done column's token)&_yxh0=c2
>>>
200 OK
content-type: text/html; charset=utf-8

<div class="board" id="board" data-yx-region><section class="column" data-yx-action="/board" data-yx-token="..." data-yx-trigger="drop" data-yx-holes="[[&quot;drag&quot;,&quot;dataset&quot;,&quot;id&quot;]]"><h2>To do</h2><ul><li class="card" data-id="c1" draggable="true" data-key="c1"><!-- ... -->Write the docs<!-- ... --></li></ul></section><!-- ... --><h2>Done</h2><ul><li class="card" data-id="c2" draggable="true" data-key="c2"><!-- ... -->Ship it<!-- ... --></li></ul></section></div>
---
POST /board
_yx=(the Done column's token)&_yxh0=nope
>>>
400 Bad Request
content-type: application/json; charset=utf-8

{"error":"Validation failed","code":"validation_failed","issues":[{"path":"card","message":"Not a card id"}]}
```

- **Where values come from.** `to` and `before` are server-written and signed; `drag.data("id")` is read in the browser and travels as `_yxh0`, so `parse(Move, args)` validates it.
- **The innermost target wins.** Dropping on a card runs the card's action, not the column's; dropping a card on itself goes to its column.
- **`drop:.card`** keeps the bin from taking anything else draggable. **`data-yx-confirm`** works on any action, not only forms.
- **Every board updates** through `boardChannel` and live refresh. **Check permissions** in `move` and `remove` on a real board.

## Poll a long job until it's done

A background export's page shows progress, then a download link. Uses the [`every` trigger](06-interactivity.md#triggers) and [`@every`](08-services.md#lifecycle-boot-timers-shutdown).

```tsx
// src/routes/export.tsx
import { NotFound, Region, action, every, get, inject, param, route, service } from "@toyz/yerd";

interface Job {
  id: string;
  progress: number;
}

@service
export class Exports {
  #jobs = new Map<string, Job>([["e1", { id: "e1", progress: 0 }]]);

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  // Stands in for the real work.
  @every("1s") work() {
    for (const job of this.#jobs.values()) job.progress = Math.min(100, job.progress + 10);
  }
}

@route("/exports/:id")
export class ExportPage {
  @param("id") accessor id!: string;
  @inject(Exports) accessor exports!: Exports;

  @get page() {
    return (
      <main>
        <h1>Your export</h1>
        {this.status()}
      </main>
    );
  }

  status() {
    const job = this.exports.get(this.id);
    if (!job) throw new NotFound("No such export");
    if (job.progress >= 100) {
      // No trigger on this one, so the polling stops.
      return <Region id="status"><a href={`/exports/${job.id}.csv`} download>Download</a></Region>;
    }
    return (
      <Region id="status" action={this.check} trigger="every 2s" aria-live="polite">
        <progress value={job.progress} max={100}></progress> {job.progress}%
      </Region>
    );
  }

  @action check() {
    return this.status();
  }
}
```

The runtime's poll returns the Region with its trigger, so it asks again:

```answer
POST /exports/e1
_yx=(the Region's token)
>>>
200 OK
content-type: text/html; charset=utf-8

<div aria-live="polite" id="status" data-yx-region data-yx-action="/exports/e1" data-yx-token="..." data-yx-trigger="every 2s"><progress value="0" max="100"></progress> 0%</div>
```

- **It stops by itself** once a response replaces the Region with one that has no trigger.
- **Only while someone's looking:** `every` runs while the element is on the page and the tab is visible, at most every 250 ms.
- **No JavaScript, no polling.** Add `<meta http-equiv="refresh" content="5">` in a `<noscript>` if that matters.
- **Many watchers?** Push instead: publish to a channel when the job moves and use [live refresh](06-interactivity.md#live-refresh).

## Load a slow panel after the page

Show a dashboard at once and fill in its slow stats panel when ready. Uses the [`load` trigger](06-interactivity.md#triggers).

```tsx
// src/routes/dashboard.tsx
import { Region, action, get, route } from "@toyz/yerd";

async function slowStats(): Promise<{ orders: number; revenue: number }> {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return { orders: 42, revenue: 1234 };
}

@route("/dashboard")
export class Dashboard {
  @get page() {
    return (
      <main>
        <h1>Dashboard</h1>
        <Region id="stats" action={this.stats} trigger="load">
          <p aria-busy="true">Crunching numbers...</p>
          <noscript><a href="/dashboard/stats">See the numbers</a></noscript>
        </Region>
      </main>
    );
  }

  @action async stats() {
    const { orders, revenue } = await slowStats();
    return (
      <Region id="stats">
        <p>{orders} orders, ${revenue} today</p>
      </Region>
    );
  }
}
```

```answer
GET /dashboard
200 OK
content-type: text/html; charset=utf-8

<main><h1>Dashboard</h1><div id="stats" data-yx-region data-yx-action="/dashboard" data-yx-token="..." data-yx-trigger="load"><p aria-busy="true">Crunching numbers...</p><noscript><a href="/dashboard/stats">See the numbers</a></noscript></div></main>
---
POST /dashboard
_yx=(the Region's token)
>>>
200 OK
content-type: text/html; charset=utf-8

<div id="stats" data-yx-region><p>42 orders, $1234 today</p></div>
```

`load` fires once per render; the returned Region has no trigger, so it doesn't loop. The alternatives:

| | The page arrives | Without JavaScript |
| --- | --- | --- |
| An [async component](05-pages-and-layouts.md#components) | at once up to the panel, the rest streams in when it's done; one request | works |
| `trigger="load"` | complete, at once; the panel is a second request | shows the placeholder (add a `noscript` way in) |
| [`<Dynamic>`](05-pages-and-layouts.md#dynamic-parts) | for prerendered pages: a static file, the panel fetched after | shows `noscript` |
