import { ActionForm, Events, HttpError, Region, action, body, catches, get, inject, post, redirect, route } from "@toyz/yerd";
import { Price } from "../attributes.js";
import { CheckoutForm, Orders, PaymentDeclined, type Cart } from "../cart.js";
import { OrderPlaced, QuoteShipping } from "../events.js";
import { CartBadge } from "../layouts.js";
import { COUNTRIES } from "../shipping.js";
import { ShopConfig, firstIssue, fromScript } from "../shop.js";
import { auth, type User } from "../users.js";
import { Viewer } from "../viewer.js";
import { Shop } from "./shop.js";


function CartLines({ cart, actions }: { cart: Cart; actions: CartPage }) {
  return (
    <Region id="cart" class="panel cart">
      {cart.lines.length === 0 ? (
        <p class="empty">
          Your cart is empty. <a href="/">The gnomes miss you.</a>
        </p>
      ) : (
        <>
          <ul class="cart-lines">
            {cart.lines.map((line) => (
              <li key={line.id} class="cart-line">
                <span class="cart-name">{line.name}</span>
                <label class="visually-hidden" for={`qty-${line.id}`}>Quantity of {line.name}</label>
                {/* `change` trigger: the new number is read in the browser (el.valueAsNumber) and posted. */}
                <input
                  class="input qty"
                  id={`qty-${line.id}`}
                  type="number"
                  min="0"
                  max="99"
                  value={String(line.qty)}
                  action={({ el }) => actions.setQty({ id: line.id, qty: el.valueAsNumber })}
                  trigger="change"
                />
                <Price cents={line.priceCents * line.qty} />
                <form action={() => actions.remove({ id: line.id })}>
                  <button class="btn btn-ghost btn-danger" aria-label={`Remove ${line.name}`}>Remove</button>
                </form>
              </li>
            ))}
          </ul>
          <p class="cart-total">
            Total <Price cents={cart.total} class="price-big" />
          </p>
        </>
      )}
    </Region>
  );
}

/**
 * The shipping estimate, from a call (`events.call(new QuoteShipping(...))`)
 * that the Shipping service answers. The country select submits its form on
 * change; an impossible destination comes back from the handler as a 422,
 * shown in the select's own error box.
 */
function ShippingEstimate({ country, cents, freeFromCents, quote }: { country: string; cents: number; freeFromCents: number; quote: CartPage["quote"] }) {
  return (
    <Region id="shipping" class="panel shipping">
      <form action={quote}>
        <div class="row">
          <div class="field grow">
            <label for="country">Ship to</label>
            <select class="input" id="country" name="country" data-yx-submit>
              {COUNTRIES.map(([code, name]) => <option value={code} selected={code === country}>{name}</option>)}
            </select>
            <span class="field-error" data-yx-error="country"></span>
          </div>
          <noscript><button class="btn btn-ghost">Update</button></noscript>
        </div>
      </form>
      <p class="cart-total">
        Shipping {cents === 0 ? <span class="price">Free</span> : <Price cents={cents} />}
      </p>
      <p class="muted small">
        {cents === 0 ? "Free shipping. The flamingos will deliver it personally." : <>Free shipping from <Price cents={freeFromCents} />.</>}
      </p>
    </Region>
  );
}

/**
 * The cart: actions for quantities and removal (they return Regions), and a
 * plain `@post` for checkout. Only the checkout needs a login, so that one
 * method carries the guard (`@post @auth.required`): browsing and filling a
 * cart stay anonymous.
 */
@route("/cart", { group: Shop, meta: { title: "Your cart", area: "cart" } })
export class CartPage {
  @inject(Viewer) accessor viewer!: Viewer;
  @inject(Orders) accessor orders!: Orders;
  @inject(ShopConfig) accessor config!: ShopConfig;
  @inject(Events) accessor events!: Events;
  @auth.maybeUser accessor me: User | undefined;

  get cart() {
    return this.viewer.cart;
  }

  get country() {
    return this.viewer.session.shipTo ?? "US";
  }

  /** Ask whoever answers QuoteShipping (the Shipping service) and wait for the number. */
  shippingFor(country: string): Promise<number> {
    const lines = this.cart.lines.map(({ id, qty }) => ({ id, qty }));
    return this.events.call(new QuoteShipping(lines, country, this.cart.total), { timeout: "3s" });
  }

  async shipping() {
    const cents = await this.shippingFor(this.country);
    return <ShippingEstimate country={this.country} cents={cents} freeFromCents={this.config.freeShippingCents} quote={this.quote} />;
  }

  @get async page() {
    const error = this.cart.flash("error") as string | undefined;
    // Set by the sign-in hook when it merged a saved cart; shown once.
    const kept = this.viewer.session.cartWelcome;
    if (kept) this.viewer.session.cartWelcome = undefined;
    return (
      <>
        <h1 class="page-title">Your cart</h1>
        {kept ? (
          <p class="notice" role="status">
            Welcome back, we kept {kept} item{kept === 1 ? "" : "s"} from last time.
          </p>
        ) : null}
        <CartLines cart={this.cart} actions={this} />
        {this.cart.lines.length > 0 ? await this.shipping() : null}
        {this.cart.lines.length > 0 ? (
          <section class="panel checkout">
            <h2>Check out</h2>
            {this.me ? null : (
              <p class="muted">
                You'll be asked to <a href="/login?next=/cart">log in</a> first.
              </p>
            )}
            {/* An action: a validation error comes back as issues, each shown under its field. */}
            <form action={this.placeOrder}>
              <div class="field">
                <label for="name">Name</label><input class="input" id="name" name="name" autocomplete="name" required />
                <span class="field-error" data-yx-error="name"></span>
              </div>
              <div class="field">
                <label for="address">Address</label><input class="input" id="address" name="address" autocomplete="street-address" required />
                <span class="field-error" data-yx-error="address"></span>
              </div>
              <div class="row">
                <div class="field grow">
                  <label for="card">Card number</label>
                  <input class="input" id="card" name="card" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" required />
                  <span class="field-error" data-yx-error="card"></span>
                </div>
                <div class="field">
                  <label for="cvc">CVC</label><input class="input" id="cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" maxlength={4} required />
                  <span class="field-error" data-yx-error="cvc"></span>
                </div>
              </div>
              <p class="form-error" data-yx-error role="alert">{error}</p>
              <button class="btn btn-block">Place order</button>
              <p class="muted small">Test cards: 4242 4242 4242 4242 works, 4000 0000 0000 0002 declines.</p>
            </form>
          </section>
        ) : null}
      </>
    );
  }

  /** Every Region a cart change touches: the lines, the badge, and the estimate (quoted again). */
  async regions() {
    return (
      <>
        <CartLines cart={this.cart} actions={this} />
        <CartBadge count={this.cart.count} />
        {this.cart.lines.length > 0 ? await this.shipping() : null}
      </>
    );
  }

  @action async setQty({ id, qty }: { id: string; qty: number }) {
    this.cart.setQty(id, qty);
    this.viewer.cartChanged();
    return this.regions();
  }

  @action async remove({ id }: { id: string }) {
    this.cart.remove(id);
    this.viewer.cartChanged();
    return this.regions();
  }

  /**
   * A new destination. The handler's HttpError arrives here as an HttpError;
   * re-thrown with an issue for `country`, the runtime puts its message in
   * the select's [data-yx-error="country"] box.
   */
  @action async quote(_: {}, form: ActionForm) {
    const country = form.string("country");
    try {
      await this.shippingFor(country);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      throw new HttpError(error.status, error.message, { details: { issues: [{ path: "country", message: error.message }] } });
    }
    this.viewer.session.shipTo = country;
    return this.shipping();
  }

  @action @auth.required async placeOrder(_: {}, fields: ActionForm) {
    let form: CheckoutForm;
    try {
      form = fields.parse(CheckoutForm);
    } catch (error) {
      // With the runtime, the issues go back as they are and land under their fields;
      // a plain form post gets the first one as a message above the form.
      if (!(error instanceof HttpError) || error.status >= 500 || fromScript()) throw error;
      this.cart.flash("error", firstIssue(error));
      return redirect("/cart");
    }
    const order = this.orders.place({ id: this.me!.id, name: this.me!.name }, this.cart.lines, form, await this.shippingFor(this.country));
    // Announce it. Inside a request, the event waits until the handler has succeeded:
    this.events.emit(new OrderPlaced(order, this.me!.name));
    // ...so when the card is declined here, the request fails and the event is dropped (no receipt, no stock taken).
    this.orders.charge(order, form);
    // The saved cart is cleared by Carts, which hears OrderPlaced.
    this.cart.empty();
    this.cart.flash("notice", `Order ${order.number} placed. The gnomes are packing it now.`);
    return redirect(`/orders/${order.id}`);
  }

  /** The order service throws a domain error; on this page it's a message above the form, not an error page. */
  @catches(PaymentDeclined)
  declined(error: PaymentDeclined) {
    this.cart.flash("error", error.message);
    return redirect("/cart");
  }
}
