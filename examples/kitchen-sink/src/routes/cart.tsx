import { HttpError, Region, action, body, catches, get, inject, post, redirect, route } from "@toyz/yerd";
import { Price } from "../attributes.js";
import { CheckoutForm, Orders, PaymentDeclined, type Cart } from "../cart.js";
import { CartBadge } from "../layouts.js";
import { ShopConfig, firstIssue } from "../shop.js";
import { auth, type User } from "../users.js";
import { Viewer } from "../viewer.js";
import { Shop } from "./shop.js";


function CartLines({ cart, actions, freeShippingCents }: { cart: Cart; actions: CartPage; freeShippingCents: number }) {
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
          <p class="muted small">
            {cart.total >= freeShippingCents ? "Free shipping. The flamingos will deliver it personally." : <>Free shipping from <Price cents={freeShippingCents} />.</>}
          </p>
        </>
      )}
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
  @auth.maybeUser accessor me: User | undefined;
  @body(CheckoutForm) accessor checkoutForm!: Promise<CheckoutForm>;

  get cart() {
    return this.viewer.cart;
  }

  @get page() {
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
        <CartLines cart={this.cart} actions={this} freeShippingCents={this.config.freeShippingCents} />
        {this.cart.lines.length > 0 ? (
          <section class="panel checkout">
            <h2>Check out</h2>
            {this.me ? null : (
              <p class="muted">
                You'll be asked to <a href="/login?next=/cart">log in</a> first.
              </p>
            )}
            {/* A classic form: posts to this page's @post handler, which redirects. Auto mode morphs the result in. */}
            <form method="post" action="/cart">
              <div class="field"><label for="name">Name</label><input class="input" id="name" name="name" autocomplete="name" required /></div>
              <div class="field"><label for="address">Address</label><input class="input" id="address" name="address" autocomplete="street-address" required /></div>
              <div class="row">
                <div class="field grow"><label for="card">Card number</label><input class="input" id="card" name="card" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" required /></div>
                <div class="field"><label for="cvc">CVC</label><input class="input" id="cvc" name="cvc" inputmode="numeric" autocomplete="cc-csc" maxlength={4} required /></div>
              </div>
              <p class="form-error" role="alert">{error}</p>
              <button class="btn btn-block">Place order</button>
              <p class="muted small">Test cards: 4242 4242 4242 4242 works, 4000 0000 0000 0002 declines.</p>
            </form>
          </section>
        ) : null}
      </>
    );
  }

  regions() {
    return (
      <>
        <CartLines cart={this.cart} actions={this} freeShippingCents={this.config.freeShippingCents} />
        <CartBadge count={this.cart.count} />
      </>
    );
  }

  @action setQty({ id, qty }: { id: string; qty: number }) {
    this.cart.setQty(id, qty);
    this.viewer.cartChanged();
    return this.regions();
  }

  @action remove({ id }: { id: string }) {
    this.cart.remove(id);
    this.viewer.cartChanged();
    return this.regions();
  }

  @post @auth.required async checkout() {
    let form: CheckoutForm;
    try {
      form = await this.checkoutForm;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      this.cart.flash("error", firstIssue(error));
      return redirect("/cart");
    }
    const order = await this.orders.place({ id: this.me!.id, name: this.me!.name }, this.cart.lines, form);
    this.cart.empty();
    this.viewer.cartChanged();
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
