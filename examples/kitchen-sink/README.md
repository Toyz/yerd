# kitchen-sink: Yerd Bazaar

A small shop for absurd yard goods, with a live chat, a staff kanban board, a
back office and a REST API. It exists to use essentially every public yerd
feature in one coherent app. Everything is in memory: restart and the shelves
are restocked.

From the repo root:

```sh
npm run kitchen      # Vite dev server on http://localhost:3300 (PORT to change it)
npx vite build --config examples/kitchen-sink/vite.config.ts
node examples/kitchen-sink/dist/server/server.js
npx playwright test --project=kitchen-dev --project=kitchen-prod
```

Start at `/features`: every feature, with a link to where it shows.

Demo accounts (also listed on `/login`):

| User | Password | Roles |
|------|----------|-------|
| `ada` | `gnome-overlord` | admin, staff |
| `bo` | `flamingo-wrangler` | staff |
| `cy` | `rock-collector` | customer |
| `di` | `saved-my-cart` | customer, with a saved cart |

## Pages

| Path | What | Layouts (outermost first) |
|------|------|---------------------------|
| `/` | the shop: typeahead, aisle select, infinite scroll, favourites | `RootLayout` > `ShopShell` |
| `/products` | the whole catalog as HTML, CSV or JSON | `RootLayout` > `ShopShell` |
| `/products/:slug` | one product with a `<Local>` image slider, reviews with photos; crawlers get their own variant | `RootLayout` > `ShopShell` |
| `/lookbook` | a lazy `<picture>` gallery; the aisle select submits itself (`data-yx-submit`) | `RootLayout` > `ShopShell` |
| `/cart` | quantities, checkout behind a login | `RootLayout` > `ShopShell` |
| `/orders`, `/orders/:id` | my orders; live status (pending, packed, shipped), cancel while pending, returns with photos | `RootLayout` > `ShopShell` (> `ReceiptCard` via `res()`) |
| `/returns` | guest returns: `is.email`, `is.date`, `is.url`, a `[trim, toUuid]` pipeline, per-field error boxes | `RootLayout` > `ShopShell` |
| `/features` | the feature tour | `RootLayout` > `ShopShell` |
| `/lifetimes` | every service lifetime and registration style, live | `RootLayout` > `ShopShell` |
| `/oops` | a deliberate crash: the error page shows the stack in development only | `RootLayout` > `ErrorPage` |
| `/chat` | live chat; staff can mute | `RootLayout` > `ShopShell` |
| `/rave` | gnome rave: dancing in step on every screen (`sync`), an airhorn and a beat drop played everywhere at once (`Cues`) | `RootLayout` > `ShopShell` |
| `/about` | prerendered, with `<Dynamic>` parts | `RootLayout` > `MarketingLayout` (`@layout(RootLayout, MarketingLayout)`) |
| `/login`, `/signup` | auth | `RootLayout` > `AuthLayout` (group) |
| `/admin` | dashboard: live sales, polled pulse, lazy panel | `RootLayout` > `AdminLayout` (group, staff only) |
| `/admin/products` | inline editing, photo drop zones, new product with staged photos | same |
| `/admin/orders` | move orders along, approve or refuse returns, find an order (`is.uuid`) | same |
| `/admin/event-log` | the last 50 events and calls, and which handlers ran, live | same |
| `/admin/board` | the staff kanban board | same |
| `/img/products/:slug` | product art drawn as SVG in TSX (or an uploaded photo) | `@noLayout` |
| `/products/:slug/embed` | an embeddable card | none (`bare()`) |

## Where each feature lives

**App setup** (`src/app.ts`): `yerd({ bodyLimit })`, `.layout(RootLayout)`,
`.errorPage(ErrorPage)`, `.sessions({ store: new MemoryStore(), generateId })`,
`.use(timing)` (a Server-Timing middleware, `src/shop.ts`), `.use(auth)`,
`.guard(readOnlyMode)` (`BAZAAR_READ_ONLY=1` turns every write into a 503),
`.services((s) => s.value(ShopConfig, ...))` and `.logging({ filter })`.

**Routing**: `@group("/", { layout })` for the shop and auth pages,
`@group("/admin", { layout, guards: [auth.role("staff")] })` for the back office,
`@layout(RootLayout, MarketingLayout)` on `/about`, `@noLayout` on the image
route, `setMeta()` for titles, descriptions, canonical URLs and `og:image`.
`/products` answers HTML or CSV from one `negotiate()` and JSON from a second
handler with `@accepts("json")`:

```sh
curl -H 'accept: text/csv' localhost:3300/products
curl -H 'accept: application/json' localhost:3300/products
curl -A Googlebot localhost:3300/products/disco-gnome   # the @get(isBot) variant, Vary: User-Agent
```

**Request data**: `@param`, `@query` with `trim` / `toInt` / `between` /
`oneOf`, `@header("referer")` (the theme toggle goes back where it came from,
through `safeNext`), `@cookie("recent")` ("Recently viewed", set with
`ctx.setCookie` on the product page), `@field` and `@file` for review photos,
`@body(Dto)` on the API and checkout, `parse()` for values the browser fills
into action arguments (`src/routes/board.tsx`). DTOs (`src/catalog.ts`,
`src/cart.ts`, `src/users.ts`) use `is.string/int/number/oneOf/array/files`
with `trim`, `lower`, `length`, `between`, `matches` and a custom transform.
`ProductChanges` is all-optional, so `PATCH` only changes what was sent.

**Responses**: `res()` (status, headers, layouts), `redirect()`, `bare()`,
`YerdError` subclasses (`ProductNotFound extends NotFound` answers the API's
JSON 404 by itself, `OutOfStock extends Conflict` refuses more than the shelf
holds), `@status(201)`, `@setHeader`, `@catches(PaymentDeclined)` on the
cart, `json()` for JSON-LD in a
`<script>`, `raw()` for the inline logo.

**Services** (`src/*.ts`): `@service` singletons (`Catalog`, `Orders`,
`SalesFeed`, `Board`), `@singleton` (`Chat`, `Presence`), a `@scoped` `Viewer`
(the user, cart and theme for this request, used by layouts through
`resolve()`), `@inject`, `@maybe(Mailer)` (nothing registers one), `token()`
for `ShopConfig` and `Mailer`, `@onBoot` (stock the shelves, hash the demo
passwords), `@onShutdown`, `@every("4s")` (an imaginary crowd buys things and
publishes each sale) and a `@hosted` `RestockWorker`. `/lifetimes` puts the
rest side by side (`src/lifetimes.ts`): a singleton factory for a token
(`s.singleton(BootInfo, bootInfo)`), a scoped factory for a class with a
constructor argument (`s.scoped(Visit, ...)`) whose `[Symbol.dispose]` runs
as each request ends, a `@transient` `Dice` injected twice (two dice), and
`@service({ provides: Fortune })` behind a token.

**Orders and returns** (`src/cart.ts`, `src/routes/orders.tsx`): order ids
are UUIDs, checked and branded by a `[trim, toUuid]` pipeline on `@param`
(a malformed or someone else's id is a 404). Status changes (the
`@every("5s")` warehouse job, staff on `/admin/orders`, a cancel) are
`OrderStatusChanged` events; `OrderFeed` turns them into pings on
`orderChannel`, and the order pages listen through a per-user SSE route and
`data-yx-live`. A shipped order takes one return: a reason
(`is.oneOf`), a note and up to five photos (`is.files`, images only), from the
file input or dropped on its `dropTo` staging zone, shown in the same `eq()`
slider as product photos and served by `/img/returns/:id` to the owner and
staff only.

**Events and calls** (`src/events.ts`, `src/reactions.ts`, `src/shipping.ts`):
checkout creates the order and emits `OrderPlaced` (`@named("order.placed")`)
instead of calling anything. `Receipts`, `Warehouse` (whose forklift jams
now and then: `@on(OrderPlaced, { retries: 3, backoff: "200ms" })`),
`SalesFeed` (the live ticker and dashboard), `Carts` (clears the saved cart)
and `OrderFeed` (the live order pages) each react on their own, in the
background, after the request has succeeded. Status changes (packed, shipped,
cancelled, a return asked for or decided) are `OrderStatusChanged` events.
The card is charged after the event is emitted: the decline test card
(4000 0000 0000 0002) throws there, the request fails, and yerd drops the
event, so no receipt goes out and no stock is taken. The cart's shipping
estimate is a call, `await events.call(new QuoteShipping(...))`, answered by
`Shipping`'s `@handles`; its 422 for Antarctica comes back as a `YerdError`
and is shown under the country select. `/admin/event-log` lists the last 50
events and calls with the handlers that ran for each, live. Services that
only react to events are never injected, so `src/app.ts` imports
`reactions.ts` itself (a `@service` registers when its module loads).

**A cart that follows the user** (`src/carts.ts`, `src/users.ts`): `createAuth`'s
`onLogin` hook merges the guest's cart into the user's saved one (quantities
add up, capped by stock) right after `login()` rotates the session, and
`onLogout` saves it before `logout()` destroys it; both are awaited
(`await auth.login(user)`). Every cart change by a signed-in user is saved too
(`Viewer.cartChanged()`), so it survives never signing out. After a merge the
header badge already shows the merged count, the cart page says "Welcome back,
we kept N items from last time" once, and My orders shows the saved cart.

**Logging**: `@logger` on services; `@instrument` on `UserRepo.create` (skips
`password`) and `Orders.place` (skips `payment.card` and `payment.cvc`, paths
the compiler checks).

**Auth and sessions**: `createAuth` with roles, `hashPassword` /
`verifyPassword`, `auth.login` / `logout`, `auth.required`, `auth.role("staff")`,
`@auth.user` / `@auth.maybeUser`, `auth.current()`, `safeNext`. The cart is a
session shape: `@session(Cart) accessor cart!: Session<Cart>` with a default
`lines = []`, `count` / `total` getters and `add` / `setQty` / `remove` /
`empty` methods. Typed views (`Session<AuthSession>`, `Session<Prefs>` for the theme), the
sign-in hooks reaching the cart with `session.as(Cart)`, and flash messages after redirects.
Guards: `createGuard` (`readOnlyMode`, `apiWriter`), a named `@guard("notMuted")`
on the `Chat` service used with `@guards("notMuted")`, and method-level guards:
`@post @auth.required checkout()`, `@action @auth.role("staff") mute()`.

**Live**: `channel<T>()` for sales, chat and the board; `@sse` (chat, board,
the ticker with named `event()`s) and `sse()` as a function (the dashboard);
`data-yx-live` refreshes the chat, board and dashboard; `@ndjson` streams
`/api/products.ndjson`. The rave runs on the server's clock: `sync` keeps
the gnomes on one beat in every tab, and `Cues` plays the airhorn (with a
`cooldown`) and a countdown-then-drop (two cues, one timeline) on every page
at the same moment; the `horn` attribute turns `yx:cue` events into Web Audio.
The rave's room is public (`yerd({ cues: { public: ["main", "rave"] } })`);
the back office's order bell is a private `"staff"` room, streamed from
`/admin/cues` behind the staff guard and heard with `cueFrom` (`OrderBell` in
`src/reactions.ts` plays it on every `OrderPlaced`).

**Interactivity** (no client code anywhere):

| Feature | Where |
|---------|-------|
| `action={() => this.addToCart({ id })}` | product cards, product page |
| `({ form }) => this.rename({ id }, form)` | admin product rows, kanban cards |
| `formaction={() => this.duplicate({ id })}` | second button in an admin row |
| typeahead: `({ el, ref }) => ...` with `trigger="input 200ms"` | shop search box (`ref("#category")`) |
| `el` + `ref("#q")` with `trigger="change"` | shop aisle select |
| `({ el }) => this.setQty({ id, qty: el.valueAsNumber })` `trigger="change"` | cart quantities |
| `trigger="keydown:Enter"` on a form | chat |
| `trigger="every 5s"` | dashboard pulse |
| `trigger="load"` | dashboard "Running low" |
| `({ ctx }) => ...` reading the page's query | the shop's first infinite-scroll sentinel |
| `trigger="visible"` + `<Region append>` | shop infinite scroll |
| `<Region prepend>` | new chat messages |
| `trigger="drop"`, `({ drag }) => ...`, `drop:.card` | kanban columns, cards, the bin |
| `trigger="drop:files"` with `accept="image/*"` | photo zones on `/admin/products` |
| `dropTo="#photos"` + `form.files("photos")` | the new-product form |
| `data-yx-confirm`, `data-yx-reset`, `data-yx-error` | delete, bin, mute; chat, board, new product; most forms |
| `<Local persist>` with a class flag | favourite hearts (`src/components.tsx`) |
| `<Local>` slider with `eq()` and an `onKeyDown` handler | product photos, return photos (`PhotoSlider`) |
| `[data-yx-error="<field>"]` boxes | signup, new product, guest returns, order returns |
| `data-yx-submit` | the Lookbook's aisle select |
| `<Local>` with `not()` and sessionStorage | the "Recently viewed" panel |
| `attribute()` with server and client halves | `money` (prices in the visitor's locale), `ago`, client-only `ticker` |
| `prefetch`, `<Scripts auto />` | nav links, product links; every link and form is enhanced |

**Client code** (`src/widgets/*.client.ts`, built by the plugin without being listed):

| Feature | Where |
|---------|-------|
| `island<SparklineProps>(src, { when: "visible" })` | the dashboard's "Sales over time" canvas |
| `lazyElement("share-link", src, { when: "idle" })` | the Share button on a product page |
| `attribute("confetti", { client: src, when: "interaction" })` | the product page's Add to cart button |

**Pages and assets**: `<Stylesheet href="src/styles.css" />`,
`assetUrl("src/hero.svg")` (both hashed by the build), an eager
`fetchpriority="high"` hero, lazy `decoding="async"` product images with
`width`/`height` and `srcset`, `@prerender` on `/about` and `/robots.txt`, and
`<Dynamic>` for the shopper count and account button on `/about`.

## REST API

| Request | Answer |
|---------|--------|
| `GET /api/products?q=&category=&limit=&page=` | a page of products |
| `POST /api/products` | 201 + `Location`, `Cache-Control: no-store` |
| `GET /api/products/:id` | the product, or `404 {"error","id"}` |
| `PUT /api/products/:id` | replace (full body) |
| `PATCH /api/products/:id` | only the fields you send |
| `DELETE /api/products/:id` | 204 |
| `GET /api/products.ndjson` | the catalog, one product per line |
| `GET /api/sales` | recent sales and totals |

Writes need `x-api-key: let-me-in` (set `BAZAAR_API_KEY` to change it) or a
staff session:

```sh
curl -H 'x-api-key: let-me-in' -H 'content-type: application/json' \
  -d '{"name":"Gnome Lawyer","category":"gnomes","priceCents":4200}' localhost:3300/api/products
```

## Files

| File | What |
|------|------|
| `src/app.ts` | the app: sessions, middleware, guard, config, logging |
| `src/shop.ts` | `ShopConfig` and `Mailer` tokens, `Presence`, `readOnlyMode`, `timing` |
| `src/catalog.ts` | `Catalog` (60 seeded products, photos, reviews), DTOs, `ProductNotFound` |
| `src/cart.ts` | the `Cart` session shape, `CheckoutForm`, `Orders` (status, returns, warehouse job, charge), `toUuid` |
| `src/events.ts` | `OrderPlaced`, `OrderStatusChanged`, the `QuoteShipping` call, and the `EventLog` |
| `src/reactions.ts` | `Receipts`, `Warehouse` (with retries) and `OrderFeed`: services that react to orders |
| `src/shipping.ts` | `Shipping`, which answers `QuoteShipping` |
| `src/carts.ts` | `Carts`: saved carts per user, and the merge |
| `src/returns.ts` | return DTOs (`ReturnRequest`, `OrderReturnForm`, `FindOrder`) and guest return tickets |
| `src/sales.ts` | `SalesFeed` (`@every`), `RestockWorker` (`@hosted`), `salesChannel` |
| `src/users.ts` | `UserRepo`, demo accounts, `createAuth(...)` |
| `src/viewer.ts` | the scoped `Viewer` |
| `src/lifetimes.ts` | `BootInfo`, `Visit`, `Disposals`, `Dice`, `Fortune`: one of each service lifetime |
| `src/chat.ts`, `src/board.ts` | chat (with the `notMuted` guard) and the kanban board |
| `src/attributes.tsx` | `money`, `ago`, `ticker` and `horn` custom attributes |
| `src/layouts.tsx` | root, shop, marketing, admin, auth and receipt layouts; error page |
| `src/components.tsx` | product cards, grid, sentinel, hearts, toast |
| `src/routes/*.tsx` | shop, products, cart, orders, chat, rave, lifetimes, admin, board, auth, pages, media, tour (lookbook, features), API |
| `src/styles.css` | the stylesheet |
| `src/hero.svg` | the hero image |
| `public/humans.txt` | a file served as is from `public/` |

The built `server.js` runs with `NODE_ENV=production` unless told otherwise
(JSON logs, the missing-secret warning). The error page also refuses to show
stacks in any Vite build, whatever `NODE_ENV` says.
