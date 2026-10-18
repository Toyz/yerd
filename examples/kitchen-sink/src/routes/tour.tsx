import { css, get, inject, keyframes, oneOf, query, route } from "@toyz/yerd";
import { CATEGORIES, CATEGORY_IDS, Catalog, imageUrl, type CategoryId } from "../catalog.js";
import { Shop } from "./shop.js";

/**
 * The lookbook: every product, big, in a lazy gallery of <picture> elements
 * (the browser picks a source by screen width and loads each one only as it
 * nears the viewport). The aisle filter is a plain GET form whose select
 * submits itself on change (`data-yx-submit`).
 */
@route("/lookbook", { group: Shop, meta: { title: "Lookbook", area: "lookbook" } })
export class Lookbook {
  @inject(Catalog) accessor catalog!: Catalog;
  @query("aisle", { transform: oneOf("", ...CATEGORY_IDS) }) accessor aisle: CategoryId | "" = "";

  @get page() {
    const products = this.catalog.all().filter((p) => this.aisle === "" || p.category === this.aisle);
    return (
      <>
        <h1 class="page-title">Lookbook</h1>
        <form class="search" method="get" action="/lookbook">
          <label for="aisle">Aisle</label>
          <select class="input" id="aisle" name="aisle" data-yx-submit>
            <option value="">Every aisle</option>
            {CATEGORY_IDS.map((id) => <option value={id} selected={this.aisle === id}>{CATEGORIES[id].name}</option>)}
          </select>
          <noscript><button class="btn">Show</button></noscript>
        </form>
        <ul class="lookbook">
          {products.map((p) => (
            <li>
              <a href={`/products/${p.slug}`}>
                <picture>
                  <source media="(min-width: 900px)" srcset={`${imageUrl(p, 640)} 1x, ${imageUrl(p, 1280)} 2x`} />
                  <source media="(min-width: 500px)" srcset={imageUrl(p, 480)} />
                  <img src={imageUrl(p, 320)} alt={p.name} width={640} height={480} loading="lazy" decoding="async" />
                </picture>
                <span>{p.name}</span>
              </a>
            </li>
          ))}
        </ul>
      </>
    );
  }
}

/** A deliberate crash: the error page shows its stack in development only. */
@route("/oops", { sitemap: false })
export class Oops {
  @get page(): never {
    throw new Error("A gnome tripped over the server. (This is a demo crash.)");
  }
}

interface Feature {
  name: string;
  /** Where to see it in the app. */
  href: string;
  /** What to do there, or what to look for. */
  how: string;
}

/** Every feature, with a place to see it. Staff pages need a staff login (ada / gnome-overlord). */
const FEATURES: Array<[string, Feature[]]> = [
  ["App setup and routing", [
    { name: "Root layout and custom error page", href: "/no-such-aisle", how: "A 404 rendered by app.errorPage(ErrorPage) inside RootLayout." },
    { name: "Error page with the thrown error", href: "/oops", how: "A crash: the stack shows in development only (ErrorPageProps.error)." },
    { name: "Sessions in a MemoryStore with custom ids", href: "/cart", how: "The cart lives in the session (ids look like sess_<uuid>)." },
    { name: "Middleware", href: "/", how: "Every response has a Server-Timing header (dev tools, Network, Timing)." },
    { name: "App-wide guard", href: "/", how: "Start with BAZAAR_READ_ONLY=1: browsing works, every write is a 503." },
    { name: "Groups with layouts and guards", href: "/admin", how: "The /admin group has its own layout and needs a staff login." },
    { name: "Two layouts in one @layout, prerendered, with <Dynamic>", href: "/about", how: "A static file in production; the shopper count and account button fill in after load." },
    { name: "@noLayout", href: "/img/products/disco-gnome?w=640", how: "An SVG drawn in TSX, served without layouts." },
    { name: "bare()", href: "/products/disco-gnome/embed", how: "An embeddable card: HTML with no layouts." },
    { name: "Page meta and setMeta()", href: "/products/disco-gnome", how: "Title, description, canonical URL and og:image per product." },
    { name: "Params", href: "/products/philosophical-gnome", how: ":slug here, :id on order pages." },
    { name: "@query", href: "/?q=rock&category=rocks", how: "The shop reads its filters from the URL too." },
    { name: "@header", href: "/", how: "The Dark/Light button posts to /theme, which reads the Referer to go back." },
    { name: "@cookie", href: "/", how: "View a product, then come back: \"Recently viewed\" is read from a cookie." },
    { name: "@accepts and negotiate()", href: "/products", how: "HTML here; send Accept: text/csv or application/json for the others." },
    { name: "@get(isBot) and Vary", href: "/products/disco-gnome", how: "curl -A Googlebot gets a script-free page with JSON-LD." },
    { name: "Prerendered text file", href: "/shelf.txt", how: "The shelf as it was at build time, written by vite build." },
    { name: "Sitemap and robots.txt", href: "/sitemap.xml", how: "app.sitemap(): the public pages, every product through @sitemap, no /api or /admin; robots.txt points at it." },
  ]],
  ["Responses", [
    { name: "res() with a layout", href: "/orders", how: "Order pages add ReceiptCard at return time." },
    { name: "redirect()", href: "/cart", how: "Checkout redirects to the new order, with a flash notice." },
    { name: "NotFound", href: "/products/no-such-thing", how: "A 404 with a friendly message." },
    { name: "@status(HttpStatus.Created), @setHeader, ctx.setHeader", href: "/api/products", how: "POST /api/products answers 201 with Location and Cache-Control." },
    { name: "@catches", href: "/api/products/p999", how: "A domain error turned into a JSON 404 (and declined cards into a flash on /cart)." },
    { name: "json() in a script tag", href: "/products/disco-gnome", how: "View source: the application/ld+json block." },
    { name: "raw()", href: "/", how: "The logo is hand-written SVG." },
  ]],
  ["Validation", [
    { name: "is.* DTOs with transforms and validators", href: "/admin/products", how: "New product: trim, length, between, oneOf." },
    { name: "Field-level error boxes", href: "/signup", how: "Try a one-letter name: the message lands under the field (also on returns and /admin/products)." },
    { name: "is.email, is.date, is.url and a type-changing pipeline", href: "/returns", how: "Guest returns: the order id goes [trim, toUuid] into a branded Uuid." },
    { name: "is.uuid", href: "/admin/orders", how: "Find an order by pasting its full id." },
    { name: "is.files and @file", href: "/products/disco-gnome", how: "Reviews take a photo (@file); new products and order returns take several (is.files, images only, at most 5)." },
    { name: "Partial PATCH DTO", href: "/api/products/p01", how: "PATCH /api/products/:id changes only the fields sent." },
    { name: "parse()", href: "/admin/board", how: "Dropped card ids are validated with parse(MoveCard, ...)." },
  ]],
  ["Services, DI and logging", [
    { name: "@every", href: "/", how: "The ticker: a made-up crowd buys something every 4 seconds." },
    { name: "@hosted", href: "/admin", how: "RestockWorker tops up sold-out items (see Running low)." },
    { name: "@every on orders", href: "/orders", how: "The warehouse moves orders along every half minute." },
    { name: "@onBoot / @onShutdown", href: "/products", how: "The shelves are stocked at boot; the server logs when it closes." },
    { name: "@scoped, @singleton, token(), @maybe", href: "/cart", how: "The cart badge comes from the scoped Viewer; config is a token; the Mailer is optional." },
    { name: "Every service lifetime, side by side", href: "/lifetimes", how: "A singleton factory, a scoped factory disposed at the end of each request, two @transient dice, and @service({ provides }) behind a token. Reload and watch." },
    { name: "@logger and @instrument with skip paths", href: "/cart", how: "Check out and watch the server log: the card number is never logged." },
  ]],
  ["Auth and sessions", [
    { name: "Login, signup, logout, safeNext", href: "/login?next=/orders", how: "Log in and land where you were going." },
    { name: "auth.required", href: "/orders", how: "My orders needs a login." },
    { name: "auth.role", href: "/admin", how: "Customers get a 403 here; staff get in." },
    { name: "Session shape with methods and defaults", href: "/cart", how: "@session(Cart): lines, count, total, add, setQty, remove." },
    { name: "onLogin / onLogout: a cart that follows the user", href: "/login?next=/cart", how: "Add things as a guest, log in as di / saved-my-cart: the saved cart and yours merge (My orders shows it too)." },
    { name: "Session value as a property", href: "/", how: "prefs.theme on a Session<Prefs>, flipped by the Dark/Light button; the sign-in hooks use session.as(Cart)." },
    { name: "Flash messages", href: "/login", how: "A wrong password comes back as a flash." },
    { name: "createGuard", href: "/api/products", how: "Writes need x-api-key or a staff session." },
    { name: "Named @guard on a service", href: "/chat", how: "Muted users can't post (the notMuted guard lives on the Chat service)." },
    { name: "Method-level guards", href: "/chat", how: "Posting needs a login; muting needs staff. Checkout is @post @auth.required." },
  ]],
  ["Events and calls", [
    { name: "Events: emit() and @on handlers", href: "/admin/event-log", how: "Place an order: checkout emits order.placed, and Receipts, Warehouse, SalesFeed, Carts and OrderFeed each react, live in the log." },
    { name: "Retries with backoff", href: "/admin/event-log", how: "The Warehouse's forklift jams now and then: watch it retry (@on with retries and backoff)." },
    { name: "Order status as events", href: "/admin/orders", how: "Mark an order packed: order.status drives the customer's live order page." },
    { name: "Calls: events.call() and @handles", href: "/cart", how: "The shipping estimate is a call the Shipping service answers; pick Antarctica for its 422, shown on the select." },
    { name: "A failing request emits nothing", href: "/cart", how: "Check out with 4000 0000 0000 0002: the card is declined after the event was emitted, so the event is dropped." },
  ]],
  ["Live", [
    { name: "SSE with named events", href: "/", how: "The ticker under the nav." },
    { name: "data-yx-live", href: "/chat", how: "Open two tabs (also /orders, /admin, /admin/board)." },
    { name: "Order status and returns, live", href: "/orders", how: "Staff mark orders packed or shipped, and approve or refuse returns, on /admin/orders; your order page updates." },
    { name: "NDJSON streaming", href: "/api/products.ndjson", how: "The whole catalog, one product per line." },
  ]],
  ["Interactivity", [
    { name: "Action lambdas", href: "/", how: "Add to cart: () => this.addToCart({ id })." },
    { name: "({ form }) lambdas and formaction", href: "/admin/products", how: "Save edits a row; Duplicate is a second submit button with its own action." },
    { name: "Typeahead (input 200ms) and ref()", href: "/", how: "Type in the search box; the aisle select reads it with ref(\"#q\")." },
    { name: "change trigger with el.valueAsNumber", href: "/cart", how: "Change a quantity." },
    { name: "keydown:Enter", href: "/chat", how: "Enter sends." },
    { name: "every 5s and load triggers", href: "/admin", how: "Pulse polls; Running low loads after the page." },
    { name: "ctx in a lambda, visible trigger, <Region append>", href: "/", how: "Scroll down: infinite scroll." },
    { name: "<Region prepend>", href: "/chat", how: "Your message appears on top at once." },
    { name: "Drag and drop", href: "/admin/board", how: "Drag cards between columns, onto cards, or into the bin (drop:.card)." },
    { name: "File drops and dropTo staging", href: "/admin/products", how: "Drop an image on a row's photo, or several on the new-product zone (and on a shipped order's return form)." },
    { name: "Returns with photos", href: "/orders", how: "On a shipped order: request a return with photos; several are shown in an eq() slider." },
    { name: "data-yx-confirm, data-yx-reset, data-yx-error, data-yx-submit", href: "/orders", how: "Cancel asks first; chat clears after sending; the Lookbook's aisle select submits itself." },
    { name: "<Local> with persist", href: "/", how: "The hearts remember your favourites." },
    { name: "<Local> slider with eq()", href: "/products/disco-gnome", how: "Previous, next, thumbnails, arrow keys." },
    { name: "<Local> with not() and sessionStorage", href: "/", how: "The Recently viewed panel folds." },
    { name: "Custom attributes", href: "/", how: "money (prices in your locale), ago (times that tick), ticker (client only)." },
    { name: "An island, loaded when visible", href: "/admin", how: "Scroll down the dashboard: the sales sparkline is a canvas drawn by its own client module, fetched as it comes into view." },
    { name: "A lazy custom element", href: "/products/disco-gnome", how: "The Share button is <share-link>: its module loads once the browser is idle, and the plain link shows until then." },
    { name: "An attribute whose client half is a module", href: "/products/disco-gnome", how: "Point at Add to cart: confetti's module loads then, so the click gets a burst." },
    { name: "prefetch and <Scripts auto />", href: "/", how: "Hover a product: it's fetched before you click." },
    { name: "Server-synced animation: sync and Cues", href: "/rave", how: "Two windows: the gnomes bob on one beat, and the airhorn and the drop play on every screen at once (late joiners start partway)." },
    { name: "A private cue room with cueFrom", href: "/admin", how: "Keep the dashboard open and place an order elsewhere: the bell rings on every staff screen, streamed from /admin/cues behind the staff guard." },
  ]],
  ["Pages and assets", [
    { name: "Lazy images with srcset, eager hero", href: "/", how: "The hero is fetchpriority=high; product images load as you scroll." },
    { name: "A <picture> gallery", href: "/lookbook", how: "Sources by screen width, loaded lazily." },
    { name: "Stylesheet and assetUrl", href: "/", how: "Hashed by vite build: the stylesheet and the hero." },
    { name: "Scoped css`` and keyframes", href: "/features", how: "The \"live\" pill at the top of this page: inlined once in dev, one hashed stylesheet after vite build (<Styles /> links it)." },
    { name: "Files from public/", href: "/humans.txt", how: "Served as they are, in dev and production." },
  ]],
];

// Scoped CSS: a class name for these rules, sent only to pages that use it.
const glow = keyframes`
  from { box-shadow: 0 0 0 0 var(--bazaar-glow); }
  to { box-shadow: 0 0 0 6px transparent; }
`;
const livePill = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgb(214, 69, 43);
  color: white;
  font-size: 0.8rem;
  font-weight: 600;
  animation: ${glow} 1.6s ease-out infinite;
  &::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
`;

@route("/features", { group: Shop, meta: { title: "Feature tour", area: "features" } })
export class Features {
  @get page() {
    return (
      <>
        <h1 class="page-title">Feature tour <span class={livePill}>live</span></h1>
        <p class="meta-line">
          Every yerd feature this app uses, and where to see it. Back-office pages need a staff login: <code>ada</code> / <code>gnome-overlord</code>.
        </p>
        {FEATURES.map(([area, features]) => (
          <section class="panel features-list">
            <h2>{area}</h2>
            <dl>
              {features.map((f) => (
                <>
                  <dt><a href={f.href}>{f.name}</a></dt>
                  <dd>{f.how}</dd>
                </>
              ))}
            </dl>
          </section>
        ))}
      </>
    );
  }
}
