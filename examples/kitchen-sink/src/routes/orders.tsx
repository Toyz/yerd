import { ActionForm, Channels, HttpError, Region, action, get, inject, param, query, res, route, session, setHeader, signal, sse, toInt, between, trim, type Action, type Session } from "@toyz/yerd";
import { Ago, Price } from "../attributes.js";
import { ORDER_STEPS, Orders, orderChannel, toUuid, type Order, type Uuid } from "../cart.js";
import { PhotoSlider } from "../components.js";
import { ReceiptCard } from "../layouts.js";
import { OrderReturnForm, ReturnRequest, Returns } from "../returns.js";
import { firstIssue, fromScript } from "../shop.js";
import { auth, type User } from "../users.js";
import { Viewer } from "../viewer.js";
import { Shop } from "./shop.js";

/**
 * The signed-in user's order changes, and nobody else's: one channel for all
 * orders, filtered here. Each plain message refreshes the order pages' Regions.
 */
@route("/orders/events", { guards: [auth.required] })
export class OrderEvents {
  @inject(Channels) accessor channels!: Channels;
  @auth.user accessor me!: User;
  @signal accessor stop!: AbortSignal;

  @get @sse async *feed() {
    for await (const change of this.channels.subscribe(orderChannel, this.stop)) {
      if (change.userId === this.me.id) yield change;
    }
  }
}

const LABELS = { pending: "Pending", packed: "Packed", shipped: "Shipped", cancelled: "Cancelled" } as const;

export function StatusBadge({ order }: { order: Order }) {
  return <span class={["status", order.status]}>{LABELS[order.status]}</span>;
}

/** Where the order is, as steps. A Region: live refreshes and the cancel action replace it. */
function OrderProgress({ order, cancel }: { order: Order; cancel: Action }) {
  const at = ORDER_STEPS.indexOf(order.status);
  return (
    <Region id="order-status" class="order-status">
      {order.status === "cancelled" ? (
        <p class="notice cancelled">Cancelled. Everything went back on the shelf.</p>
      ) : (
        <ol class="steps" aria-label="Order progress">
          {ORDER_STEPS.map((step, i) => (
            <li class={{ done: i <= at, current: i === at }}>{LABELS[step]}</li>
          ))}
        </ol>
      )}
      <p class="muted small">
        <StatusBadge order={order} /> since <Ago iso={order.updatedAt} />. The warehouse gnomes move orders along every half minute or so.
      </p>
      {order.status === "pending" ? (
        <form action={cancel} data-yx-confirm="Cancel this order? The items go back on the shelf.">
          <button class="btn btn-ghost btn-danger">Cancel order</button>
        </form>
      ) : null}
    </Region>
  );
}

const RETURN_LABELS = { requested: "Return requested", approved: "Return approved", refused: "Return refused" } as const;

/**
 * The return part of an order page. A Region: requesting a return replaces
 * it, and a staff decision (published on the orders channel) refreshes it live.
 */
export function ReturnPanel({ order, request }: { order: Order; request: Action }) {
  const ret = order.return;
  if (ret) {
    const slides = Array.from({ length: ret.photos }, (_, n) => ({
      src: `/img/returns/${order.id}?n=${n}`,
      full: `/img/returns/${order.id}?n=${n}`,
      thumb: `/img/returns/${order.id}?n=${n}`,
      alt: `Return photo ${n + 1}`,
    }));
    return (
      <Region id="order-return" class="order-return">
        <h2>
          <span class={["status", ret.status]}>{RETURN_LABELS[ret.status]}</span>
        </h2>
        <p>
          <strong>{ret.reason}</strong>: {ret.note}
        </p>
        {slides.length > 0 ? <PhotoSlider slides={slides} label="Photos of the returned item" width={360} /> : null}
      </Region>
    );
  }
  if (order.status !== "shipped") {
    return (
      <Region id="order-return" class="order-return">
        <p class="muted small">Returns open once the order has shipped.</p>
      </Region>
    );
  }
  const box = (name: string) => <span class="field-error" data-yx-error={name}></span>;
  return (
    <Region id="order-return" class="order-return">
      <h2>Request a return</h2>
      {/* novalidate: the server checks the files' types and sizes, and says so next to the field. */}
      <form action={request} enctype="multipart/form-data" data-yx-reset novalidate>
        <div class="field">
          <label for="return-reason">Reason</label>
          <select class="input" id="return-reason" name="reason">
            <option value="damaged">Damaged</option>
            <option value="wrong item">Wrong item</option>
            <option value="changed my mind">Changed my mind</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="field">
          <label for="return-note">Note</label>
          <textarea class="input" id="return-note" name="note" rows={3} placeholder="What happened? (10 characters or more)"></textarea>
          {box("note")}
        </div>
        <div class="field">
          <label for="return-photos">Photos of the item (up to 5)</label>
          <input class="input" id="return-photos" type="file" name="photos" multiple accept="image/*" />
          {box("photos")}
        </div>
        {/* Drop several photos here first; they go up with the form. */}
        <div class="dropzone" dropTo="#return-photos">Or drop photos here</div>
        <p class="form-error" data-yx-error role="alert"></p>
        <button class="btn">Request the return</button>
      </form>
    </Region>
  );
}

/** Return photos: the order's owner and staff only; anyone else gets a 404. */
@route("/img/returns/:id", { guards: [auth.required] })
export class ReturnPhotoRoute {
  @inject(Orders) accessor orders!: Orders;
  @auth.user accessor me!: User;
  @param("id", { transform: [trim, toUuid] }) accessor id!: Uuid;
  @query("n", { transform: toInt, validate: between(0, 4) }) accessor n = 0;

  @get @setHeader("cache-control", "private, max-age=3600") photo() {
    const order = this.orders.get(this.id);
    const allowed = order && (order.userId === this.me.id || this.me.roles.includes("staff"));
    const photo = allowed ? this.orders.returnPhoto(this.id, this.n) : undefined;
    if (!photo) throw new HttpError(404, "No such photo");
    return res(photo.bytes, { headers: { "content-type": photo.type } });
  }
}

@route("/orders", { group: Shop, guards: [auth.required], meta: { title: "My orders", area: "orders" } })
export class MyOrders {
  @inject(Orders) accessor orders!: Orders;
  @inject(Viewer) accessor viewer!: Viewer;
  @auth.user accessor me!: User;

  @get page() {
    const mine = this.orders.forUser(this.me.id);
    return (
      <>
        <h1 class="page-title">My orders</h1>
        {/* Status changes (the warehouse job, staff, a cancel in another tab) refresh the list. */}
        <div data-yx-live="/orders/events" hidden></div>
        <Region id="my-orders" class="panel">
          {mine.length === 0 ? (
            <p class="empty">
              No orders yet. <a href="/">The rocks are waiting.</a>
            </p>
          ) : (
            <table class="table plain">
              <thead>
                <tr><th>Order</th><th>Placed</th><th>Items</th><th>Total</th><th>Status</th></tr>
              </thead>
              <tbody>
                {mine.map((order) => (
                  <tr key={order.id}>
                    <td><a href={`/orders/${order.id}`} prefetch>{order.number}</a></td>
                    <td><Ago iso={order.at} /></td>
                    <td>{order.lines.reduce((n, l) => n + l.qty, 0)}</td>
                    <td><Price cents={order.totalCents + order.shippingCents} /></td>
                    <td><StatusBadge order={order} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Region>
        <p class="muted">
          Something not right? Open a shipped order and request a return.
        </p>
        {/* Signed in, the session's cart is also saved against the account: it's here on any device. */}
        <section class="panel saved-cart">
          <h2>Your saved cart</h2>
          {this.viewer.cart.lines.length === 0 ? (
            <p class="muted">Empty. It's kept with your account, so whatever you add follows you to any device.</p>
          ) : (
            <>
              <ul class="low">
                {this.viewer.cart.lines.map((line) => (
                  <li>
                    {line.qty} x {line.name}
                  </li>
                ))}
              </ul>
              <p>
                <Price cents={this.viewer.cart.total} /> · <a href="/cart">Go to the cart</a>
              </p>
            </>
          )}
        </section>
      </>
    );
  }
}

@route("/orders/:id", { group: Shop, guards: [auth.required], meta: { title: "Order", area: "orders" } })
export class OrderPage {
  @inject(Orders) accessor orders!: Orders;
  @auth.user accessor me!: User;
  /** A transform pipeline on a param: trimmed, then checked and branded (a malformed id is a 404). */
  @param("id", { transform: [trim, toUuid] }) accessor id!: Uuid;
  @session accessor session!: Session<{ notice?: string }>;

  /** Someone else's order is a 404, not a 403: no hint that it exists. */
  #order(): Order {
    const order = this.orders.get(this.id);
    if (!order || order.userId !== this.me.id) throw new HttpError(404, "There's no order with that number.");
    return order;
  }

  @get page() {
    const order = this.#order();
    const notice = this.session.flash("notice") as string | undefined;
    // The layout is picked at return time: res() adds ReceiptCard inside the shop shell.
    return res(
      <>
        <div data-yx-live="/orders/events" hidden></div>
        {notice ? <p class="notice" role="status">{notice}</p> : null}
        <a class="back" href="/orders">All my orders</a>
        <h1>Order {order.number}</h1>
        <p class="meta-line">
          Placed <Ago iso={order.at} /> for {order.name}, {order.address}. Card ending {order.card}.
        </p>
        <OrderProgress order={order} cancel={this.cancel} />
        <ReturnPanel order={order} request={this.requestReturn} />
        <ul class="cart-lines">
          {order.lines.map((line) => (
            <li class="cart-line">
              <span class="cart-name">{line.qty} x {line.name}</span>
              <Price cents={line.priceCents * line.qty} />
            </li>
          ))}
        </ul>
        <p class="cart-total">Shipping <Price cents={order.shippingCents} /></p>
        <p class="cart-total">Total <Price cents={order.totalCents + order.shippingCents} class="price-big" /></p>
        <p class="row">
          <a class="btn" href="/">Keep shopping</a>
        </p>
      </>,
      { layout: ReceiptCard },
    );
  }

  @action async cancel() {
    const order = await this.orders.cancel(this.#order().id);
    return <OrderProgress order={order} cancel={this.cancel} />;
  }

  /** Own orders only (#order() is a 404 otherwise); the DTO checks the reason, the note and every photo. */
  @action async requestReturn(_: {}, form: ActionForm) {
    const order = await this.orders.requestReturn(this.#order().id, form.parse(OrderReturnForm));
    return <ReturnPanel order={order} request={this.requestReturn} />;
  }
}

function ReturnForm({ order, submit, error }: { order: string; submit: Action; error?: string }) {
  // One box per field ([data-yx-error="<name>"]): with JavaScript, each validation message lands next to its field.
  const box = (name: string) => <span class="field-error" data-yx-error={name}></span>;
  return (
    <Region id="return-form" class="panel">
      {/* novalidate: the server checks every field, and the browser's own checks would get there first. */}
      <form action={submit} novalidate>
        <div class="field"><label for="order">Order id (the long one, from the order page's address)</label><input class="input" id="order" name="order" value={order} required />{box("order")}</div>
        <div class="row">
          <div class="field grow"><label for="email">Email</label><input class="input" id="email" name="email" type="email" required />{box("email")}</div>
          <div class="field"><label for="received">Received on</label><input class="input" id="received" name="received" type="date" required />{box("received")}</div>
        </div>
        <div class="field">
          <label for="wants">You'd like</label>
          <select class="input" id="wants" name="wants">
            <option value="refund">A refund</option>
            <option value="exchange">An exchange</option>
            <option value="a sincere apology">A sincere apology</option>
          </select>
        </div>
        <div class="field"><label for="evidence">Photo link (optional)</label><input class="input" id="evidence" name="evidence" type="url" placeholder="https://..." />{box("evidence")}</div>
        <div class="field"><label for="reason">What happened?</label><textarea class="input" id="reason" name="reason" rows={3} required></textarea>{box("reason")}</div>
        <p class="form-error" data-yx-error role="alert">{error}</p>
        <button class="btn">Send the return request</button>
      </form>
    </Region>
  );
}

/**
 * Guest returns: a DTO with is.email, is.date, is.url and a type-changing
 * pipeline. With JavaScript, a bad field's message goes into its own box;
 * without it, the first message comes back as a flash above the form.
 */
@route("/returns", { group: Shop, meta: { title: "Guest returns" } })
export class ReturnsPage {
  @inject(Returns) accessor returns!: Returns;
  @query("order", { transform: trim }) accessor order = "";
  @session accessor session!: Session<{ returnError?: string }>;

  @get page() {
    const error = this.session.flash("returnError") as string | undefined;
    return (
      <>
        <h1 class="page-title">Guest returns</h1>
        <p class="meta-line">
          Got it as a gift, or no account? Tell us here. (Signed in? Request a return from the order itself, under <a href="/orders">My orders</a>.)
        </p>
        <ReturnForm order={this.order} submit={this.submit} error={error} />
      </>
    );
  }

  @action submit(_: {}, form: ActionForm) {
    let request: ReturnRequest;
    try {
      request = form.parse(ReturnRequest);
    } catch (error) {
      if (fromScript() || !(error instanceof HttpError)) throw error;
      this.session.flash("returnError", firstIssue(error));
      return undefined;
    }
    const ticket = this.returns.file(request);
    return (
      <Region id="return-form" class="panel">
        <p class="notice" role="status">Return request {ticket.id.slice(0, 8)} received. We'll ask the gnome what happened.</p>
      </Region>
    );
  }
}
