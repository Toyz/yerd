import { ActionForm, NotFound, ValidationFailed, action, currentContext, get, group, inject, param, redirect, route, session, toInt, type Session } from "@toyz/yerd";
import { Cart, priceCart } from "../cart.js";
import { Catalog } from "../catalog.js";
import { Field, Price } from "../components.js";
import { Narrow } from "../layouts.js";
import { CheckoutForm, Orders } from "../orders.js";
import { auth, type User } from "../users.js";

/** Everything here needs a signed-in user, in a narrow column. No URL prefix. */
@group("/", { guards: [auth.required], layout: Narrow })
export class Account {}

/** What a failed plain (no JavaScript) post leaves for the page it goes back to. */
interface CheckoutState {
  errors?: Record<string, string>;
  draft?: Record<string, string | undefined>;
}

@route("/checkout", { group: Account, meta: { title: "Check out" } })
export class CheckoutPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(Orders) accessor orders!: Orders;
  @auth.user accessor me!: User;
  @session(Cart) accessor cart!: Session<Cart>;
  @session accessor session!: Session;

  @get page() {
    const { lines, total } = priceCart(this.cart.lines, this.catalog);
    if (lines.length === 0) return redirect("/cart");
    const { errors = {}, draft = { name: this.me.name } } = (this.session.flash("checkout") ?? {}) as CheckoutState;
    return (
      <>
        <h1>Check out</h1>
        <ul class="summary">
          {lines.map(({ product, qty, subtotal }) => (
            <li>
              {qty} x {product.name} <Price cents={subtotal} />
            </li>
          ))}
        </ul>
        <p class="total">
          Total <Price cents={total} />
        </p>
        <form action={this.place}>
          <Field name="name" label="Name" value={draft.name} error={errors.name} autocomplete="name" />
          <Field name="email" label="Email" type="email" value={draft.email} error={errors.email} autocomplete="email" />
          <Field name="address" label="Address" value={draft.address} error={errors.address} autocomplete="street-address" />
          <p class="form-error" data-yx-error role="alert"></p>
          <button>Place order</button>
        </form>
      </>
    );
  }

  @action place(_: {}, form: ActionForm) {
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
    const order = this.orders.place(this.me, details, this.cart.lines);
    this.cart.empty();
    return redirect(`/orders/${order.id}`);
  }
}

@route("/orders/:id", { group: Account, meta: { title: "Thank you" } })
export class OrderPage {
  @inject(Orders) accessor orders!: Orders;
  @auth.user accessor me!: User;
  @param("id", { transform: toInt }) accessor id!: number;

  @get page() {
    const order = this.orders.get(this.id, this.me);
    if (!order) throw new NotFound("No such order");
    return (
      <>
        <h1>Order {order.id} is in</h1>
        <p>A receipt is on its way to {order.email}.</p>
        <ul class="summary">
          {order.lines.map((line) => (
            <li>
              {line.qty} x {line.name} <Price cents={line.price * line.qty} />
            </li>
          ))}
        </ul>
        <p class="total">
          Total <Price cents={order.total} />
        </p>
      </>
    );
  }
}
