import { BadRequest, Conflict, inject, is, length, named, service, trim } from "@toyz/yerd";
import { priceCart, type CartLine } from "./cart.js";
import { Catalog } from "./catalog.js";
import type { User } from "./users.js";

/** The checkout form. Every field is checked on the server; the browser's checks are a courtesy. */
export class CheckoutForm {
  @is.string({ transform: trim, validate: length(2, 80) }) name!: string;
  @is.email() email!: string;
  @is.string({ transform: trim, validate: length(5, 200) }) address!: string;
}

export interface Order {
  id: number;
  userId: string;
  name: string;
  email: string;
  address: string;
  /** Names and prices as they were when the order was placed. */
  lines: Array<{ id: number; name: string; price: number; qty: number }>;
  total: number;
  placedAt: string;
}

/**
 * Announced after checkout. Handlers run after the response, so it carries
 * what they need (no "current user" by then). Plain data: events travel as JSON.
 */
@named("order.placed")
export class OrderPlaced {
  constructor(
    readonly orderId: number,
    readonly email: string,
    readonly total: number,
  ) {}
}

@service
export class Orders {
  @inject(Catalog) accessor catalog!: Catalog;
  #orders: Order[] = [];
  #next = 1001;

  /** Check the stock, take it, keep the order. Throws before taking anything if a line can't be filled. */
  async place(user: User, details: CheckoutForm, cart: CartLine[]): Promise<Order> {
    const { lines, total } = priceCart(cart, this.catalog);
    if (lines.length === 0) throw new BadRequest("Your cart is empty.");
    for (const { product, qty } of lines) {
      if (product.stock < qty) throw new Conflict(`Only ${product.stock} of ${product.name} left.`);
    }
    for (const { product, qty } of lines) await this.catalog.take(product.id, qty);

    const order: Order = {
      id: this.#next++,
      userId: user.id,
      name: details.name,
      email: details.email,
      address: details.address,
      lines: lines.map(({ product, qty }) => ({ id: product.id, name: product.name, price: product.price, qty })),
      total,
      placedAt: new Date().toISOString(),
    };
    this.#orders.push(order);
    return order;
  }

  /** Someone's own order; another user's is as missing as one that never existed. */
  get(id: number, user: User): Order | undefined {
    return this.#orders.find((o) => o.id === id && o.userId === user.id);
  }
}
