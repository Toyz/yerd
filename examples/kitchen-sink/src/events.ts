import { randomUUID } from "node:crypto";
import { Call, Channels, channel, inject, named, on, service } from "@toyz/yerd";
import type { CartLine, Order, OrderStatus, ReturnStatus } from "./cart.js";

/**
 * Events: classes, named for the logs and the wire. They're copied through
 * JSON on the way to each handler, so they carry plain data (and an id, so
 * the event log can tell which handlers ran for which event).
 */
@named("order.placed")
export class OrderPlaced {
  readonly id = randomUUID();
  readonly at = new Date().toISOString();
  readonly orderId: string;
  readonly number: string;
  readonly userId: string;
  readonly customer: string;
  readonly lines: CartLine[];
  readonly totalCents: number;

  constructor(order: Order, customer: string) {
    this.orderId = order.id;
    this.number = order.number;
    this.userId = order.userId;
    this.customer = customer;
    this.lines = order.lines;
    this.totalCents = order.totalCents + order.shippingCents;
  }

  /** A getter works on the handler's copy too: events arrive as instances of their class. */
  get items(): number {
    return this.lines.reduce((sum, line) => sum + line.qty, 0);
  }
}

/** Packed, shipped, cancelled, or a return asked for or decided: the order pages refresh on it. */
@named("order.status")
export class OrderStatusChanged {
  readonly id = randomUUID();
  readonly at = new Date().toISOString();
  readonly orderId: string;
  readonly number: string;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly returnStatus: ReturnStatus | undefined;

  constructor(order: Order) {
    this.orderId = order.id;
    this.number = order.number;
    this.userId = order.userId;
    this.status = order.status;
    this.returnStatus = order.return?.status;
  }
}

/** A call: one @handles method answers it (Shipping), and `events.call()` resolves to the number, in cents. */
@named("shipping.quote")
export class QuoteShipping extends Call<number> {
  constructor(
    readonly lines: Array<{ id: string; qty: number }>,
    readonly country: string,
    readonly subtotalCents: number,
  ) {
    super();
  }
}

export interface HandlerRun {
  handler: string;
  status: "ok" | "retrying" | "failed";
  note?: string;
  at: string;
}

export interface LoggedEvent {
  id: string;
  kind: "event" | "call";
  name: string;
  summary: string;
  at: string;
  handlers: HandlerRun[];
}

/** A ping per change to the log: the admin's event log page refreshes (data-yx-live). */
export const eventLogChannel = channel<{ id: string }>("event-log");

/**
 * The last 50 events and calls, newest first, with the handlers that ran for
 * each. It hears every event itself (@on, like any other reacting service),
 * and the handlers report in with `ran()`.
 */
@service
export class EventLog {
  @inject(Channels) accessor channels!: Channels;
  #entries: LoggedEvent[] = [];

  @on(OrderPlaced) placed(event: OrderPlaced) {
    this.#entry(event.id, "event", "order.placed", `${event.number} for @${event.customer}: ${event.items} item${event.items === 1 ? "" : "s"}`, event.at);
  }

  @on(OrderStatusChanged) statusChanged(event: OrderStatusChanged) {
    const what = event.returnStatus ? `return ${event.returnStatus}` : event.status;
    this.#entry(event.id, "event", "order.status", `${event.number} is now ${what}`, event.at);
  }

  /** A call and its answer (calls don't go through @on: one handler answers, here Shipping). */
  call(name: string, summary: string, handler: string, outcome: Omit<HandlerRun, "handler" | "at">) {
    const entry = this.#entry(randomUUID(), "call", name, summary, new Date().toISOString());
    entry.handlers.push({ handler, ...outcome, at: new Date().toISOString() });
    this.#changed(entry.id);
  }

  /** A handler reporting what happened to an event (handlers run in any order, so the entry may not exist yet). */
  ran(eventId: string, handler: string, status: HandlerRun["status"], note?: string) {
    const entry = this.#entry(eventId, "event", "", "", new Date().toISOString());
    const run: HandlerRun = { handler, status, at: new Date().toISOString(), ...(note ? { note } : {}) };
    const existing = entry.handlers.findIndex((h) => h.handler === handler);
    if (existing >= 0) entry.handlers[existing] = run;
    else entry.handlers.push(run);
    this.#changed(entry.id);
  }

  recent(): LoggedEvent[] {
    return this.#entries;
  }

  #entry(id: string, kind: LoggedEvent["kind"], name: string, summary: string, at: string): LoggedEvent {
    let entry = this.#entries.find((e) => e.id === id);
    if (!entry) {
      entry = { id, kind, name, summary, at, handlers: [] };
      this.#entries.unshift(entry);
      this.#entries.length = Math.min(this.#entries.length, 50);
    } else if (name) {
      Object.assign(entry, { name, summary, at });
    }
    this.#changed(id);
    return entry;
  }

  #changed(id: string) {
    void this.channels.publish(eventLogChannel, { id });
  }
}
