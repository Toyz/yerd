import { Region, action, get, inject, route, session, type Session } from "@toyz/yerd";
import { Cart, priceCart } from "../cart.js";
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

  /** The lines and the total: one Region, so the remove action can send it back. */
  lines() {
    const { lines, total } = priceCart(this.cart.lines, this.catalog);
    if (lines.length === 0) {
      return (
        <Region id="cart">
          <p class="empty">
            Your cart is empty. <a href="/">Go shopping</a>.
          </p>
        </Region>
      );
    }
    return (
      <Region id="cart">
        <ul class="lines">
          {lines.map(({ product, qty, subtotal }) => (
            <li key={product.id}>
              <a href={`/products/${product.id}`}>{product.name}</a>
              <span>x {qty}</span>
              <Price cents={subtotal} />
              {/* The id is signed into the action: the browser can't change which line goes. */}
              <form action={() => this.remove({ id: product.id })}>
                <button class="link" aria-label={`Remove ${product.name}`}>Remove</button>
              </form>
            </li>
          ))}
        </ul>
        <p class="total">
          Total <Price cents={total} />
        </p>
        <a class="button" href="/checkout">Check out</a>
      </Region>
    );
  }

  @action remove({ id }: { id: number }) {
    this.cart.remove(id);
    // Every Region the change touches.
    return (
      <>
        {this.lines()}
        <CartBadge count={this.cart.count} />
      </>
    );
  }
}
