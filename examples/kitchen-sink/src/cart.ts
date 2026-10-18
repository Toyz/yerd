import { randomUUID } from "node:crypto";
import { Events, HttpError, channel, every, inject, instrument, is, length, logger, matches, service, trim, uuid, type Logger, type Transform } from "@toyz/yerd";
import { Catalog, type Photo, type Product } from "./catalog.js";
import { OrderStatusChanged } from "./events.js";

export interface CartLine {
  id: string;
  name: string;
  priceCents: number;
  qty: number;
}

/**
 * The cart, as a session shape: `@session(Cart) accessor cart!: Session<Cart>`.
 * Only `lines` is stored (in the session); the getters and methods run with
 * `this` as the session, and `lines = []` is the default for a new visitor,
 * who gets no cookie until they actually add something.
 */
export class Cart {
  lines: CartLine[] = [];
  /** How many saved items the last sign-in brought back; the cart page says so once. */
  welcomeBack?: number;
  /** Where the shipping estimate is for (a country code). */
  shipTo?: string;

  get count(): number {
    return this.lines.reduce((sum, line) => sum + line.qty, 0);
  }

  get total(): number {
    return this.lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
  }

  add(product: Product, qty = 1): void {
    const line = this.lines.find((l) => l.id === product.id);
    // Changes made in place are noticed and saved.
    if (line) line.qty = Math.min(99, line.qty + qty);
    else this.lines.push({ id: product.id, name: product.name, priceCents: product.priceCents, qty });
  }

  setQty(id: string, qty: number): void {
    if (!Number.isFinite(qty) || qty <= 0) return this.remove(id);
    const line = this.lines.find((l) => l.id === id);
    if (line) line.qty = Math.min(99, Math.floor(qty));
  }

  remove(id: string): void {
    this.lines = this.lines.filter((l) => l.id !== id);
  }

  /** Not `clear()`: that's the session's own (it would wipe everything, sign-in included), and yerd refuses the clash. */
  empty(): void {
    this.lines = [];
  }
}

const digits: Transform<string, string> = (raw) => raw.replace(/[\s-]/g, "");

/** The checkout form. Card details only live for the length of one request (and never reach the logs). */
export class CheckoutForm {
  @is.string({ transform: trim, validate: length(2, 80) }) name!: string;
  @is.string({ transform: trim, validate: length(5, 200) }) address!: string;
  @is.string({ transform: digits, validate: matches(/^\d{12,19}$/, "That doesn't look like a card number") }) card!: string;
  @is.string({ transform: trim, validate: matches(/^\d{3,4}$/, "The security code is 3 or 4 digits") }) cvc!: string;
}

/** Declined at checkout: CartPage's @catches turns it into a flash message, not an error page. */
export class PaymentDeclined extends Error {}

/** An order id: a UUID that has been checked. The brand keeps unchecked strings out of `Orders.get()`. */
export type Uuid = string & { readonly __brand: "Uuid" };

/**
 * A transform step that changes the type: string in, branded Uuid out. Used
 * in a pipeline (`[trim, toUuid]`) by DTOs and by the order page's @param.
 * A bad id is a 404 rather than a 400: an order URL either exists or it doesn't.
 */
export function toUuid(value: string): Uuid {
  if (uuid()(value) !== true) throw new HttpError(404, "There's no order with that number.");
  return value.toLowerCase() as Uuid;
}

export type OrderStatus = "pending" | "packed" | "shipped" | "cancelled";
export const ORDER_STEPS: OrderStatus[] = ["pending", "packed", "shipped"];

export type ReturnReason = "damaged" | "wrong item" | "changed my mind" | "other";
export type ReturnStatus = "requested" | "approved" | "refused";

/** A return on a shipped order. Its photos live in Orders, served by /img/returns/:order. */
export interface OrderReturn {
  reason: ReturnReason;
  note: string;
  photos: number;
  status: ReturnStatus;
  at: string;
}

export interface Order {
  id: Uuid;
  /** The short number people say out loud: Y-1001. */
  number: string;
  userId: string;
  name: string;
  address: string;
  lines: CartLine[];
  totalCents: number;
  shippingCents: number;
  /** Last four digits only. */
  card: string;
  status: OrderStatus;
  at: string;
  updatedAt: string;
  return?: OrderReturn;
}

/** A ping per status change: the customer's order pages and the admin's orders page refresh. */
export const orderChannel = channel<{ id: Uuid; userId: string; status: OrderStatus }>("orders");

/** Luhn check: catches typos in card numbers. */
function luhn(number: string): boolean {
  let sum = 0;
  for (let i = 0; i < number.length; i++) {
    let d = Number(number[number.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

@service
export class Orders {
  @inject(Catalog) accessor catalog!: Catalog;
  /** Status changes go out as events; OrderFeed turns them into live updates, EventLog records them. */
  @inject(Events) accessor events!: Events;
  @logger accessor log!: Logger;
  #orders: Order[] = [];
  #returnPhotos = new Map<Uuid, Photo[]>();
  #next = 1001;

  /**
   * Create the order. Nothing else happens here: the checkout emits
   * OrderPlaced, and the receipt, the stock, the sales feed and the saved
   * cart are each handled by whoever listens (src/reactions.ts and friends).
   *
   * A span per order with the customer and the lines, but not the card: the
   * skip paths go into the argument (`payment.card`), and a typo there is a
   * compile error.
   */
  @instrument({ level: "info", skip: ["payment.card", "payment.cvc"], ret: false })
  place(customer: { id: string; name: string }, lines: CartLine[], payment: CheckoutForm, shippingCents: number): Order {
    if (lines.length === 0) throw new HttpError(400, "Your cart is empty.");
    if (!luhn(payment.card)) throw new PaymentDeclined("That card number has a typo in it (it fails the checksum).");
    for (const line of lines) {
      // Only a check: the Warehouse takes the stock when it hears about the order.
      if ((this.catalog.get(line.id)?.stock ?? 0) < line.qty) throw new PaymentDeclined(`Sorry, ${line.name} sold out while you were deciding.`);
    }
    const totalCents = lines.reduce((sum, l) => sum + l.priceCents * l.qty, 0);
    const now = new Date().toISOString();
    const order: Order = {
      id: randomUUID() as Uuid,
      number: `Y-${this.#next++}`,
      userId: customer.id,
      name: payment.name,
      address: payment.address,
      lines: structuredClone(lines),
      totalCents,
      shippingCents,
      card: payment.card.slice(-4),
      status: "pending",
      at: now,
      updatedAt: now,
    };
    this.#orders.push(order);
    return order;
  }

  /**
   * Take the money, after the order exists (and after the checkout has
   * emitted OrderPlaced). The classic decline test card throws: the order is
   * rolled back, the request fails, and yerd drops the event it emitted, so
   * no receipt goes out and the warehouse never hears of it.
   */
  charge(order: Order, payment: CheckoutForm): void {
    if (payment.card === "4000000000000002") {
      this.#orders = this.#orders.filter((o) => o !== order);
      throw new PaymentDeclined("The bank said no. The gnomes are sympathetic.");
    }
  }

  get(id: Uuid): Order | undefined {
    return this.#orders.find((o) => o.id === id);
  }

  /** Newest first. */
  forUser(userId: string): Order[] {
    return this.#orders.filter((o) => o.userId === userId).reverse();
  }

  all(): Order[] {
    return [...this.#orders].reverse();
  }

  /** One step along pending, packed, shipped. Cancelled and shipped orders stay put. */
  async advance(id: Uuid): Promise<Order | undefined> {
    const order = this.get(id);
    const at = order ? ORDER_STEPS.indexOf(order.status) : -1;
    if (!order || at < 0 || at === ORDER_STEPS.length - 1) return order;
    await this.#set(order, ORDER_STEPS[at + 1]!);
    return order;
  }

  /** Only while pending: the stock goes back on the shelf. */
  async cancel(id: Uuid): Promise<Order> {
    const order = this.get(id);
    if (!order) throw new HttpError(404, "There's no order with that number.");
    if (order.status !== "pending") throw new HttpError(409, `Too late: it's already ${order.status}.`);
    for (const line of order.lines) this.catalog.restock(line.id, line.qty);
    await this.#set(order, "cancelled");
    return order;
  }

  /** Ask to send a shipped order back, with photos of the item. One return per order. */
  async requestReturn(id: Uuid, request: { reason: ReturnReason; note: string; photos?: File[] }): Promise<Order> {
    const order = this.get(id);
    if (!order) throw new HttpError(404, "There's no order with that number.");
    if (order.status !== "shipped") throw new HttpError(409, "Returns open once the order has shipped.");
    if (order.return) throw new HttpError(409, "There's already a return for this order.");
    const photos = await Promise.all((request.photos ?? []).map(async (f) => ({ type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })));
    this.#returnPhotos.set(id, photos);
    order.return = { reason: request.reason, note: request.note, photos: photos.length, status: "requested", at: new Date().toISOString() };
    await this.#changed(order);
    return order;
  }

  /** Staff approve or refuse a return; the customer's order page hears about it. */
  async decideReturn(id: Uuid, status: "approved" | "refused"): Promise<Order | undefined> {
    const order = this.get(id);
    if (!order?.return || order.return.status !== "requested") return order;
    order.return.status = status;
    await this.#changed(order);
    return order;
  }

  returnPhoto(id: Uuid, n: number): Photo | undefined {
    return this.#returnPhotos.get(id)?.[n];
  }

  /**
   * The warehouse gnomes: every few seconds, orders that have sat in one
   * state for a while move on by themselves (staff can also move them by hand
   * on /admin/orders). Runs never overlap, and stop at shutdown.
   */
  @every("5s") async warehouse() {
    const due = Date.now() - 30_000;
    for (const order of this.#orders) {
      if (Date.parse(order.updatedAt) < due) await this.advance(order.id);
    }
  }

  async #set(order: Order, status: OrderStatus): Promise<void> {
    order.status = status;
    order.updatedAt = new Date().toISOString();
    this.log.info("order status", { order: order.number, status });
    await this.#changed(order);
  }

  /** Inside a request (staff, a cancel) it goes out once the request has succeeded; from the warehouse job, at once. */
  #changed(order: Order): void {
    this.events.emit(new OrderStatusChanged(order));
  }
}
