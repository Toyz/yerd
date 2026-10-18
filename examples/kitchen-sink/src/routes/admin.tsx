import { ActionForm, Channels, Cues, HttpError, Region, action, css, get, group, inject, keyframes, query, route, signal, sse, type Action } from "@toyz/yerd";
import { Ago, Price } from "../attributes.js";
import { CATEGORIES, CATEGORY_IDS, Catalog, DroppedPhotos, EditProductForm, NewProductForm, imageUrl, type Product } from "../catalog.js";
import { Stock } from "../components.js";
import { Orders, orderChannel, type Uuid } from "../cart.js";
import { AdminLayout } from "../layouts.js";
import { EventLog, eventLogChannel } from "../events.js";
import { FindOrder, Returns } from "../returns.js";
import { STAFF_ROOM } from "../reactions.js";
import { SalesFeed, salesChannel } from "../sales.js";
import { Presence } from "../shop.js";
import { auth } from "../users.js";
import { StatusBadge } from "./orders.js";

/**
 * The back office: its own layout, staff only. The guard covers every page
 * and every action in the group; signed-out visitors are sent to /login,
 * customers get a 403.
 */
@group("/admin", { layout: AdminLayout, guards: [auth.role("staff")] })
export class Admin {}

/**
 * The dashboard's live feed: `sse()` called as a function (rather than the
 * `@sse` decorator), with its options. Each sale is a plain `data:` line,
 * which is what data-yx-live refreshes on (real orders are sales too).
 */
@route("/events", { group: Admin })
export class AdminEvents {
  @inject(Channels) accessor channels!: Channels;
  @signal accessor stop!: AbortSignal;

  @get feed() {
    return sse(this.channels.subscribe(salesChannel, this.stop), { heartbeat: 10_000, retry: 2_000 });
  }
}

/**
 * The staff cue room's stream. Cues work like channels: the built-in
 * /_yerd/cues only serves public rooms, so a private one comes from a route
 * like this, behind the group's staff guard. The dashboard's bell listens
 * here with `cueFrom`.
 */
@route("/cues", { group: Admin })
export class AdminCues {
  @inject(Cues) accessor cues!: Cues;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.cues.listen([STAFF_ROOM], this.stop);
  }
}

const ring = keyframes`
  0%, 100% { transform: rotate(0); }
  20% { transform: rotate(-4deg) scale(1.04); }
  40% { transform: rotate(4deg) scale(1.04); }
  60% { transform: rotate(-2deg); }
`;
const bell = css`
  display: inline-block;
  &[data-yx-cued] { animation: ${ring} 600ms ease-in-out 2; color: var(--accent); font-weight: 600; }
`;

const started = Date.now();

/** Server vitals, polled: the Region carries its own action and `trigger="every 5s"`, so each answer keeps it going. */
function Pulse({ tick, online }: { tick: Action; online: number }) {
  const memory = process.memoryUsage().rss / 1024 / 1024;
  const minutes = Math.floor((Date.now() - started) / 60_000);
  return (
    <Region id="pulse" class="panel stat" action={tick} trigger="every 5s">
      <h2>Pulse</h2>
      <p class="stat-value">{online}</p>
      <p class="muted small">
        shoppers online · up {minutes} min · {memory.toFixed(0)} MB · checked {new Date().toLocaleTimeString("en-GB")}
      </p>
    </Region>
  );
}

@route("/", { group: Admin, meta: { title: "Dashboard", area: "dashboard" } })
export class Dashboard {
  @inject(SalesFeed) accessor sales!: SalesFeed;
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(Presence) accessor presence!: Presence;

  @get page() {
    const stats = this.sales.stats();
    return (
      <>
        <h1 class="page-title">Dashboard</h1>
        {/* A private cue room: rings on every open dashboard at once when an order comes in. */}
        <p class={["muted", bell]} horn cue="ka-ching" cueFrom="/admin/cues" aria-live="polite">
          New orders ring a bell here, on every staff screen at once.
        </p>
        {/* Every sale refreshes this page's Regions. */}
        <div data-yx-live="/admin/events" hidden></div>
        <div class="stats">
          <Region id="stats" class="stats-group">
            <div class="panel stat">
              <h2>Revenue</h2>
              <p class="stat-value"><Price cents={stats.revenue} /></p>
              <p class="muted small">{stats.count} sales, {stats.orders} real orders</p>
            </div>
            <div class="panel stat">
              <h2>Best seller</h2>
              <p class="stat-value small-value">{stats.top?.name ?? "Nothing yet"}</p>
              <p class="muted small">{stats.top ? `${stats.top.units} sold` : "Give it a few seconds."}</p>
            </div>
          </Region>
          <Pulse tick={this.pulse} online={this.presence.online} />
        </div>
        <div class="columns">
          <section class="panel">
            <h2>Latest sales</h2>
            <Region id="feed" as="ol" class="feed">
              {this.sales.recent(12).map((s) => (
                <li key={s.id} class={["sale", s.source]}>
                  <span>{s.qty} x {s.name}</span>
                  <span class="muted">{s.city}</span>
                  <Price cents={s.totalCents} />
                  <Ago iso={s.at} />
                </li>
              ))}
            </Region>
          </section>
          <section class="panel">
            <h2>Running low</h2>
            {/* Loaded right after the page arrives (`trigger="load"`): the page doesn't wait for it. */}
            <Region id="low-stock" action={this.lowStock} trigger="load">
              <p class="skeleton skeleton-line" aria-label="Loading" />
            </Region>
          </section>
        </div>
      </>
    );
  }

  @action pulse() {
    return <Pulse tick={this.pulse} online={this.presence.online} />;
  }

  @action lowStock() {
    const low = this.catalog.lowStock(4);
    return (
      <Region id="low-stock">
        {low.length === 0 ? <p class="muted">Shelves are full.</p> : null}
        <ul class="low">
          {low.map((p) => (
            <li>
              <a href={`/products/${p.slug}`}>{p.name}</a> <Stock stock={p.stock} />
            </li>
          ))}
        </ul>
      </Region>
    );
  }
}

/** One editable row. Every form here is an action; the drop zone too. */
function ProductRow({ product, page }: { product: Product; page: AdminProducts }) {
  return (
    <li key={product.id} class="admin-row">
      {/* Drop image files here: they're posted to the action as soon as they land (form.files("files")). */}
      <div class="photo-drop" action={({ form }) => page.uploadPhoto({ id: product.id }, form)} trigger="drop:files" accept="image/*" title="Drop a photo here">
        <img src={imageUrl(product, 96)} alt="" width={64} height={48} loading="lazy" decoding="async" />
        <span class="small muted">{product.photos > 0 ? `${product.photos} photo${product.photos === 1 ? "" : "s"}` : "drop photo"}</span>
      </div>
      {/* `({ form })`: the action reads the form. The second button posts to another action (formaction). */}
      <form class="admin-edit" action={({ form }) => page.rename({ id: product.id }, form)}>
        <label class="visually-hidden" for={`name-${product.id}`}>Name</label>
        <input class="input" id={`name-${product.id}`} name="name" value={product.name} required />
        <label class="visually-hidden" for={`price-${product.id}`}>Price in dollars</label>
        <input class="input price-input" id={`price-${product.id}`} name="price" type="number" step="0.01" min="0.5" value={(product.priceCents / 100).toFixed(2)} required />
        <button class="btn btn-small">Save</button>
        <button class="btn btn-ghost btn-small" formaction={() => page.duplicate({ id: product.id })}>Duplicate</button>
        <span class="form-error" data-yx-error></span>
      </form>
      <span class="admin-cat">{CATEGORIES[product.category].name}</span>
      <Stock stock={product.stock} />
      <form action={() => page.remove({ id: product.id })} data-yx-confirm={`Delete ${product.name}? There is no undo.`}>
        <button class="btn btn-ghost btn-danger btn-small" aria-label={`Delete ${product.name}`}>Delete</button>
      </form>
    </li>
  );
}

@route("/products", { group: Admin, meta: { title: "Products", area: "products" } })
export class AdminProducts {
  @inject(Catalog) accessor catalog!: Catalog;

  @get page() {
    return (
      <>
        <h1 class="page-title">Products</h1>
        <section class="panel">
          <h2>New product</h2>
          {/* enctype matters without JavaScript; with it, the runtime sends file forms as multipart anyway.
              Each [data-yx-error="<field>"] box gets that field's validation message. */}
          <form class="new-product" action={this.create} enctype="multipart/form-data" data-yx-reset>
            <div class="row">
              <div class="field grow"><label for="new-name">Name</label><input class="input" id="new-name" name="name" required maxlength={60} /><span class="field-error" data-yx-error="name"></span></div>
              <div class="field">
                <label for="new-category">Aisle</label>
                <select class="input" id="new-category" name="category">
                  {CATEGORY_IDS.map((id) => <option value={id}>{CATEGORIES[id].name}</option>)}
                </select>
              </div>
              <div class="field"><label for="new-price">Price ($)</label><input class="input price-input" id="new-price" name="price" type="number" step="0.01" required /><span class="field-error" data-yx-error="price"></span></div>
            </div>
            <div class="field"><label for="new-description">Description</label><input class="input" id="new-description" name="description" maxlength={600} /></div>
            <div class="field">
              <label for="photos">Photos (up to 4)</label>
              <input class="input" id="photos" type="file" name="photos" multiple accept="image/*" />
              <span class="field-error" data-yx-error="photos"></span>
            </div>
            {/* A staging zone for the input above: drops add files to it, and they go up when the form submits. */}
            <div class="dropzone" dropTo="#photos">Or drop photos here; they upload with the form</div>
            <p class="form-error" data-yx-error role="alert"></p>
            <button class="btn">Add product</button>
          </form>
        </section>
        {this.list()}
      </>
    );
  }

  list() {
    return (
      <Region id="admin-products" as="ul" class="panel admin-list">
        {this.catalog.all().map((product) => <ProductRow product={product} page={this} />)}
      </Region>
    );
  }

  @action async create(_: {}, form: ActionForm) {
    const input = form.parse(NewProductForm);
    const product = this.catalog.create({ name: input.name, category: input.category, priceCents: Math.round(input.price * 100), description: input.description ?? "", stock: 10 });
    if (input.photos?.length) await this.catalog.addPhotos(product.id, input.photos);
    return this.list();
  }

  @action rename({ id }: { id: string }, form: ActionForm) {
    const { name, price } = form.parse(EditProductForm);
    this.catalog.update(id, { name, priceCents: Math.round(price * 100) });
    return this.list();
  }

  @action duplicate({ id }: { id: string }) {
    this.catalog.duplicate(id);
    return this.list();
  }

  @action remove({ id }: { id: string }) {
    if (!this.catalog.remove(id)) throw new HttpError(404, "Already gone.");
    return this.list();
  }

  @action async uploadPhoto({ id }: { id: string }, form: ActionForm) {
    const { files } = form.parse(DroppedPhotos);
    // A drop replaces the photos; the "new product" form is where several go up at once.
    await this.catalog.addPhotos(id, files, true);
    return this.list();
  }
}

/** Every order change pings here; the staff orders page refreshes (data-yx-live). */
@route("/orders/events", { group: Admin })
export class AdminOrderEvents {
  @inject(Channels) accessor channels!: Channels;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe(orderChannel, this.stop);
  }
}

/**
 * Orders for staff: move them along by hand (the warehouse job also does it
 * on a timer), find one by its id, and read return requests. Each change is
 * published, so the customer's order page updates live too.
 */
@route("/orders", { group: Admin, meta: { title: "Orders", area: "admin-orders" } })
export class AdminOrders {
  @inject(Orders) accessor orders!: Orders;
  @inject(Returns) accessor returns!: Returns;
  @query("find") accessor find: string | undefined;

  @get page() {
    return (
      <>
        <h1 class="page-title">Orders</h1>
        <div data-yx-live="/admin/orders/events" hidden></div>
        <form class="new-card" action={this.lookup}>
          <label class="visually-hidden" for="find-id">Order id</label>
          <input class="input" id="find-id" name="id" placeholder="Paste a full order id (a UUID)" autocomplete="off" required />
          <button class="btn">Find</button>
          <span class="form-error" data-yx-error></span>
        </form>
        {this.list()}
        <section class="panel">
          <h2>Guest return requests</h2>
          {this.returns.all().length === 0 ? <p class="muted">None yet. The gnomes are behaving.</p> : null}
          <ul class="low">
            {this.returns.all().map((t) => (
              <li>
                <strong>{t.wants}</strong> for order <code>{t.order.slice(0, 8)}</code> from {t.email}, received {t.received}: {t.reason}
                {t.evidence ? <> (<a href={t.evidence} rel="external nofollow">photo</a>)</> : null}
              </li>
            ))}
          </ul>
        </section>
      </>
    );
  }

  list(highlight?: string) {
    const all = this.orders.all();
    return (
      <Region id="admin-orders" class="panel">
        {all.length === 0 ? <p class="muted">No orders yet. Place one from the shop.</p> : null}
        <table class="table plain">
          <tbody>
            {all.map((order) => (
              <>
                <tr key={order.id} class={{ highlight: order.id === (highlight ?? this.find) }}>
                  <td><strong>{order.number}</strong><br /><code class="small">{order.id}</code></td>
                  <td>{order.name}</td>
                  <td><Price cents={order.totalCents + order.shippingCents} /></td>
                  <td><StatusBadge order={order} /></td>
                  <td>
                    {order.status === "pending" || order.status === "packed" ? (
                      <form action={() => this.advance({ id: order.id })}>
                        <button class="btn btn-small">Mark {order.status === "pending" ? "packed" : "shipped"}</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
                {order.return ? (
                  <tr key={`${order.id}-return`} class="return-row">
                    <td colspan={5}>
                      <span class={["status", order.return.status]}>Return {order.return.status}</span> <strong>{order.return.reason}</strong>: {order.return.note}
                      <span class="return-thumbs">
                        {Array.from({ length: order.return.photos }, (_, n) => (
                          <a href={`/img/returns/${order.id}?n=${n}`} target="_blank">
                            <img src={`/img/returns/${order.id}?n=${n}`} alt={`Return photo ${n + 1}`} width={64} height={48} loading="lazy" decoding="async" />
                          </a>
                        ))}
                      </span>
                      {order.return.status === "requested" ? (
                        <span class="row">
                          <form action={() => this.decide({ id: order.id, status: "approved" })}>
                            <button class="btn btn-small">Approve return</button>
                          </form>
                          <form action={() => this.decide({ id: order.id, status: "refused" })} data-yx-confirm="Refuse this return?">
                            <button class="btn btn-ghost btn-danger btn-small">Refuse</button>
                          </form>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ) : null}
              </>
            ))}
          </tbody>
        </table>
      </Region>
    );
  }

  @action async advance({ id }: { id: Uuid }) {
    await this.orders.advance(id);
    return this.list();
  }

  /** Approve or refuse a return; published, so the customer's order page updates live. */
  @action async decide({ id, status }: { id: Uuid; status: "approved" | "refused" }) {
    await this.orders.decideReturn(id, status);
    return this.list();
  }

  /** `is.uuid()` checks and lowercases the pasted id; an unknown one is a message, not a crash. */
  @action lookup(_: {}, form: ActionForm) {
    const { id } = form.parse(FindOrder);
    if (!this.orders.get(id as Uuid)) throw new HttpError(404, "No order with that id.");
    return this.list(id);
  }
}

/** Every change to the event log pings here; the event log page refreshes (data-yx-live). */
@route("/event-log/events", { group: Admin })
export class EventLogEvents {
  @inject(Channels) accessor channels!: Channels;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    return this.channels.subscribe(eventLogChannel, this.stop);
  }
}

/**
 * The event bus, watched: the last 50 events and calls, and which handlers
 * ran for each (a Warehouse retry shows as "retrying" until it gets there).
 * Place an order in another tab and watch it arrive.
 */
@route("/event-log", { group: Admin, meta: { title: "Event log", area: "event-log" } })
export class AdminEventLog {
  @inject(EventLog) accessor log!: EventLog;

  @get page() {
    return (
      <>
        <h1 class="page-title">Event log</h1>
        <p class="meta-line">
          Checkout emits <code>order.placed</code>; Receipts, Warehouse, SalesFeed, Carts and OrderFeed each react on their own (<code>@on</code>).
          The cart's shipping estimate is a call (<code>shipping.quote</code>) that Shipping answers. A declined card emits nothing.
        </p>
        <div data-yx-live="/admin/event-log/events" hidden></div>
        <Region id="event-log" as="ol" class="panel event-log">
          {this.log.recent().length === 0 ? <li class="muted">Nothing yet. Place an order, or open the cart.</li> : null}
          {this.log.recent().map((entry) => (
            <li key={entry.id} class={["event-row", entry.kind]} data-name={entry.name}>
              <div class="event-head">
                <span class="tag">{entry.kind}</span> <code class="event-name">{entry.name || "(arriving)"}</code> <span>{entry.summary}</span> <Ago iso={entry.at} />
              </div>
              <ul class="handlers">
                {entry.handlers.map((run) => (
                  <li class={["handler", run.status]} data-handler={run.handler}>
                    <code>{run.handler}</code> {run.status}
                    {run.note ? <span class="muted"> · {run.note}</span> : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </Region>
      </>
    );
  }
}
