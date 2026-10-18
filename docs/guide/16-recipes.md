# Recipes

This page is a set of complete solutions to common tasks, each built from several of yerd's pieces. Every recipe says what it uses and links to the guide that explains each part.

More recipes live next to the feature they're about:

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

The examples keep data in memory so they stay short. Swap the services for your database.

## Show a saved cart after sign-in

A guest fills a cart, signs in, and finds their cart merged with what they left in it last week, on another device. Uses a [session shape class](09-sessions-and-auth.md#a-class-for-methods-and-defaults), [createAuth hooks](09-sessions-and-auth.md#keeping-a-guests-cart-across-sign-in) and a [service](08-services.md).

The cart is a session shape: its methods work on the session, and only `lines` is stored.

```ts
// src/cart.ts
import { service } from "@toyz/yerd";

export interface Line {
  id: string;
  name: string;
  qty: number;
}

export class Cart {
  lines: Line[] = [];

  get count(): number {
    return this.lines.reduce((n, line) => n + line.qty, 0);
  }

  add(item: { id: string; name: string }): void {
    const line = this.lines.find((l) => l.id === item.id);
    if (line) line.qty++; // changed in place: still saved
    else this.lines.push({ ...item, qty: 1 });
  }

  remove(id: string): void {
    this.lines = this.lines.filter((l) => l.id !== id);
  }

  // Not clear(): that's the session's own method, and it would sign the user out too.
  empty(): void {
    this.lines = [];
  }
}

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

The hooks do the merging. `onLogin` runs after `login()` has rotated the session; `onLogout` runs before `logout()` destroys it. They get the plain session, and `session.as(Cart)` gives them the same cart view the route has.

```ts
// src/auth.ts
import { resolve } from "@toyz/yerd";
import { createAuth } from "@toyz/yerd/auth";
import { Cart, CartNotice, Carts, mergeCarts } from "./cart.js";
import { Users, type User } from "./users.js";

export const auth = createAuth<User>({
  load: (id) => resolve(Users).find(id),
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

The cart page reads the cart through the shape, says "welcome back" once, and saves a signed-in user's cart on every change: someone who never signs out never runs `onLogout`.

```tsx
// src/routes/cart.tsx
import { Region, action, get, inject, route, session, type Session } from "@toyz/yerd";
import { auth } from "../auth.js";
import { Cart, CartNotice, Carts } from "../cart.js";
import type { User } from "../users.js";

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

Gotchas:

- **A different user on the same browser.** If someone else was still signed in, `login()` starts a fresh session, so their cart doesn't join the new user's. Only a guest's cart is merged.
- **Logout empties the cart on screen.** The session is destroyed; the saved copy comes back at the next sign-in.
- **Cookie size.** With the default `CookieStore` the whole session, cart included, has to fit in about 4 KB. Big carts need [a store](09-sessions-and-auth.md#which-store).
- **Prices change.** Store ids and quantities, and look prices up when you show the cart, not when it was filled.

## Per-field form errors

Each message under its own field, with and without JavaScript. Uses [DTO validation](03-request-data.md#bodies-and-dto-classes), [field error boxes](06-interactivity.md#errors) and [flash](09-sessions-and-auth.md#the-session-api).

With the client runtime this takes no code: throw (or let `form.parse()` throw) and each message lands in the form's `[data-yx-error="<field>"]` box, the field gets `aria-invalid="true"`, and the first one is focused. Without JavaScript the browser would get the error page instead, so the action catches the failure, flashes the messages and what was typed, and redirects back to a page that renders them in the same boxes.

```tsx
// src/routes/signup.tsx
import { ActionForm, ValidationFailed, YerdError, action, between, currentContext, get, is, length, redirect, route, session, trim, type Session } from "@toyz/yerd";

class Signup {
  @is.string({ transform: trim, validate: length(2, 40) }) name!: string;
  @is.email() email!: string;
  @is.int({ validate: between(13, 120) }) age!: number;
}

interface FormState {
  errors?: Record<string, string>;
  draft?: Record<string, string | undefined>;
}

/** One message per field; "tags[1]" belongs to "tags", "(root)" to the form. */
function byField(error: YerdError): Record<string, string> {
  const issues = error instanceof ValidationFailed ? error.issues : [{ path: "", message: error.message }];
  const errors: Record<string, string> = {};
  for (const { path, message } of issues) {
    const field = path === "(root)" ? "" : path.replace(/(\[\d+\])+$/, "");
    errors[field] ??= message;
  }
  return errors;
}

function Field({ name, label, type = "text", state }: { name: string; label: string; type?: string; state: FormState }) {
  const error = state.errors?.[name];
  return (
    <p>
      <label for={name}>{label}</label>
      <input id={name} name={name} type={type} value={state.draft?.[name]} aria-invalid={error ? true : undefined} aria-describedby={`${name}-error`} />
      <span id={`${name}-error`} class="field-error" data-yx-error={name}>{error}</span>
    </p>
  );
}

@route("/signup")
export class SignupPage {
  @session accessor session!: Session;

  @get page() {
    const state = (this.session.flash("signup") ?? {}) as FormState;
    return (
      <form action={this.submit}>
        <Field name="name" label="Name" state={state} />
        <Field name="email" label="Email" type="email" state={state} />
        <Field name="age" label="Age" type="number" state={state} />
        <p class="form-error" data-yx-error role="alert">{state.errors?.[""]}</p>
        <button>Sign up</button>
      </form>
    );
  }

  @action submit(_: {}, form: ActionForm) {
    let signup: Signup;
    try {
      signup = form.parse(Signup);
    } catch (error) {
      // From the runtime (it sends a `yx` header): rethrow, and the issues land by field.
      const fromScript = currentContext().headers.yx !== undefined;
      if (!(error instanceof YerdError) || error.status >= 500 || fromScript) throw error;
      // A plain form post: keep the messages and the input for the page we go back to.
      const draft = { name: form.get("name"), email: form.get("email"), age: form.get("age") };
      this.session.flash("signup", { errors: byField(error), draft } satisfies FormState);
      return redirect("/signup");
    }
    console.log(`welcome, ${signup.name}`);
    return redirect("/welcome");
  }
}
```

- **One markup for both.** The boxes the server fills are the same `[data-yx-error="name"]` elements the runtime writes into, so the page looks the same either way. The runtime clears them all on the next submit.
- **Labels.** A message with no box of its own goes into the form's `[data-yx-error]` box, prefixed with the field's `<label>` ("Age: Must be from 13 to 120 (got 7)").
- **Lists.** An issue for `photos[2]` goes to the `photos` box unless the form has a `photos[2]` box.
- **Your own errors.** To put a message under a field from your own check (the email is taken), throw `new ValidationFailed("That email is taken", { issues: [{ path: "email", message: "That email is taken" }] })`.
- **Never redisplay secrets.** Leave passwords and card numbers out of the flashed draft.

## Upload photos with a form

A post with a title and up to ten photos, picked with the file input or dropped on a zone, sent when the form submits. Uses [is.files](03-request-data.md#uploads), [dropTo](06-interactivity.md#dropping-files) and the app's `bodyLimit`.

```tsx
// src/routes/new-post.tsx
import { ActionForm, action, get, inject, is, length, redirect, route, service, trim } from "@toyz/yerd";

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

  @action async create(_: {}, form: ActionForm) {
    const post = form.parse(NewPost);
    const ids = await Promise.all((post.photos ?? []).map((photo) => this.photos.save(photo)));
    console.log(`"${post.title}" with ${ids.length} photos`);
    return redirect("/posts");
  }
}
```

```ts
// src/main.ts: ten photos of 5 MB each must fit in one request
import { yerd } from "@toyz/yerd";

export default yerd({ bodyLimit: 55 * 1024 * 1024 });
```

```css
.dropzone[data-yx-files]::after { content: " (" attr(data-yx-files) " ready)"; }
.dropzone[data-yx-over] { outline: 2px dashed currentColor; }
```

- **Two limits.** `maxSize` limits each file (a bigger one is an issue for `photos[n]`). `bodyLimit` (1 MiB by default) caps the whole request, and a request over it is a 413 before your action runs. Raise it to cover all the files together, plus the other fields.
- **Types are what the browser says.** `types` checks each file's declared mime type, and `accept` only filters the picker and the drop zone. Check the bytes too if it matters (an image library will refuse a renamed `.exe`).
- **Staging.** Drops add to the input (drop five, then five more: ten), filtered by its `accept`. The zone gets `data-yx-files` with the count, for the CSS above. Without JavaScript the zone does nothing and the input still works.
- **Nothing picked.** An empty file input counts as no file, so `optional: true` works and `post.photos` is `undefined`.
- **Memory.** The body is read into memory before the action runs. For uploads in the hundreds of megabytes, send them straight to object storage from the browser (a presigned URL) and post only the result.

## Kanban drag and drop

A board with three columns: drag cards between them, drop a card on another to put it above, drop on the bin to delete, and every open board updates. Uses [drop triggers](06-interactivity.md#drag-and-drop), [Regions](06-interactivity.md#regions), [validation of browser values](15-security.md#values-the-browser-fills-in) and [live refresh](06-interactivity.md#live-refresh).

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

- **Where values come from.** `to: status` and `before: card.id` are written by the server and signed. `drag.data("id")` is read in the browser when the card lands, so it's input: `parse(Move, args)` checks it before the board sees it.
- **The innermost target wins.** Dropping on a card triggers the card's action (put it above), not the column's. Dropping a card on itself goes to the column around it.
- **`drop:.card`** keeps the bin from taking anything else that's draggable on the page.
- **Confirm works anywhere.** `data-yx-confirm` asks before any action fires, not only forms.
- **Every board updates.** Each change publishes to `boardChannel`; open boards get an SSE message and refresh their Regions. The board that made the change already has the new columns from the action's response.
- **Check permissions.** On a real board, check in `move` and `remove` that the user may change that card.

## Poll a long job until it's done

An export runs in the background; its page shows progress and swaps in a download link when it's ready. Uses the [`every` trigger](06-interactivity.md#triggers) and [`@every`](08-services.md#lifecycle-boot-timers-shutdown).

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

- **It stops by itself.** The runtime follows trigger changes: once a response replaces the Region with one that has no trigger, the timer ends.
- **Only while someone's looking.** `every` runs while the element is on the page and the tab is visible, and never faster than every 250 ms.
- **No JavaScript, no polling.** The page still shows the progress at load time; add `<meta http-equiv="refresh" content="5">` inside a `<noscript>` if that matters.
- **Many watchers?** Polling costs a request per viewer per tick. When many people watch the same thing, push instead: publish to a channel when the job moves and use [live refresh](06-interactivity.md#live-refresh).

## Load a slow panel after the page

A dashboard whose stats take seconds to compute: show the page at once and fill the panel in when it's ready. Uses the [`load` trigger](06-interactivity.md#triggers).

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

`load` fires once per render: the Region that comes back has no trigger, so it doesn't loop. Compare the alternatives:

| | The page arrives | Without JavaScript |
| --- | --- | --- |
| An [async component](05-pages-and-layouts.md#components) | at once up to the panel, the rest streams in when it's done; one request | works |
| `trigger="load"` | complete, at once; the panel is a second request | shows the placeholder (add a `noscript` way in) |
| [`<Dynamic>`](05-pages-and-layouts.md#dynamic-parts) | for prerendered pages: a static file, the panel fetched after | shows `noscript` |
