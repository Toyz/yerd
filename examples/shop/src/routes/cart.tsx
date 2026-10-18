import { ActionForm, Region, action, get, inject, route, session, type Session } from "@toyz/yerd";
import { Cart, QtyForm, priceCart } from "../cart.js";
import { Catalog } from "../catalog.js";
import { Price } from "../components.js";
import { CartBadge } from "../layouts.js";

@route("/cart", { meta: { title: "Your cart" } })
export class CartPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @session(Cart) accessor cart!: Session<Cart>;

  @get page() {
    return (
      <>
        <h1>Your cart</h1>
        {this.lines()}
      </>
    );
  }

  /** The lines and the total: one Region, so every cart action can send it back. */
  lines() {
    const { lines, total } = priceCart(this.cart.lines, this.catalog);
    if (lines.length === 0) {
      return (
        <Region id="cart">
          <p class="empty">Your cart is empty. <a href="/">Go shopping</a>.</p>
        </Region>
      );
    }
    return (
      <Region id="cart">
        <ul class="lines">
          {lines.map(({ product, qty, subtotal }) => (
            <li key={product.id}>
              <a href={`/products/${product.id}`}>{product.name}</a>
              {/* The id is signed into the action; the quantity is a form field. */}
              <form action={({ form }) => this.setQty({ id: product.id }, form)}>
                <label for={`qty-${product.id}`} class="visually-hidden">Quantity of {product.name}</label>
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
        </ul>
        <p class="total">Total <Price cents={total} /></p>
        <a class="button" href="/checkout">Check out</a>
      </Region>
    );
  }

  /** Every Region a cart change touches. */
  regions() {
    return (
      <>
        {this.lines()}
        <CartBadge count={this.cart.count} />
      </>
    );
  }

  @action setQty({ id }: { id: number }, form: ActionForm) {
    const { qty } = form.parse(QtyForm);
    this.cart.setQty(id, qty);
    return this.regions();
  }

  @action remove({ id }: { id: number }) {
    this.cart.remove(id);
    return this.regions();
  }
}
