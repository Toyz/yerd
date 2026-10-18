import { Channels, inject, logger, maybe, on, service, type Logger } from "@toyz/yerd";
import { formatMoney } from "./attributes.js";
import { orderChannel, type Uuid } from "./cart.js";
import { Catalog } from "./catalog.js";
import { EventLog, OrderPlaced, OrderStatusChanged } from "./events.js";
import { Mailer } from "./shop.js";

/**
 * Who reacts to an order. Checkout only emits OrderPlaced; each of these
 * hears it on its own, in the background, after the checkout request has
 * succeeded (a declined card throws, and the event is never sent).
 */

/** The receipt: emailed if a Mailer is registered (none is here), logged either way. */
@service
export class Receipts {
  @maybe(Mailer) accessor mailer: Mailer | undefined;
  @inject(EventLog) accessor eventLog!: EventLog;
  @logger accessor log!: Logger;

  @on(OrderPlaced) async send(event: OrderPlaced) {
    const body = `${event.items} item(s), ${formatMoney(event.totalCents)}. The gnomes are on it.`;
    await this.mailer?.send(event.customer, `Your Bazaar order ${event.number}`, body);
    this.log.info("receipt sent", { order: event.number, to: event.customer, by: this.mailer ? "mail" : "log only" });
    this.eventLog.ran(event.id, "Receipts.send", "ok", this.mailer ? "emailed" : "logged (no Mailer registered)");
  }
}

/**
 * The warehouse takes the stock off the shelf. Its forklift jams now and
 * then: the first two tries fail half the time, so the retries (and their
 * log lines) show up regularly. The third try always works.
 */
@service
export class Warehouse {
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(EventLog) accessor eventLog!: EventLog;
  @logger accessor log!: Logger;
  #attempts = new Map<string, number>();

  @on(OrderPlaced, { retries: 3, backoff: "200ms" }) reserve(event: OrderPlaced) {
    const attempt = (this.#attempts.get(event.id) ?? 0) + 1;
    this.#attempts.set(event.id, attempt);
    if (attempt < 3 && Math.random() < 0.5) {
      this.eventLog.ran(event.id, "Warehouse.reserve", "retrying", `forklift jammed on try ${attempt}`);
      throw new Error(`forklift jammed reserving ${event.number} (try ${attempt})`);
    }
    this.#attempts.delete(event.id);
    const short = event.lines.filter((line) => !this.catalog.take(line.id, line.qty)).map((line) => line.name);
    if (short.length > 0) this.log.warn("reserved what was left", { order: event.number, short });
    this.eventLog.ran(event.id, "Warehouse.reserve", "ok", `${attempt === 1 ? "first try" : `on try ${attempt}`}${short.length ? `, short on ${short.join(", ")}` : ""}`);
  }
}

/** Turns order events into pings on the orders channel: what the live order pages listen to. */
@service
export class OrderFeed {
  @inject(Channels) accessor channels!: Channels;
  @inject(EventLog) accessor eventLog!: EventLog;

  @on(OrderPlaced) async placed(event: OrderPlaced) {
    await this.channels.publish(orderChannel, { id: event.orderId as Uuid, userId: event.userId, status: "pending" });
    this.eventLog.ran(event.id, "OrderFeed.placed", "ok");
  }

  @on(OrderStatusChanged) async changed(event: OrderStatusChanged) {
    await this.channels.publish(orderChannel, { id: event.orderId as Uuid, userId: event.userId, status: event.status });
    this.eventLog.ran(event.id, "OrderFeed.changed", "ok");
  }
}
