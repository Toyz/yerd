import { logger, on, service, type Logger } from "@toyz/yerd";
import { formatPrice } from "./catalog.js";
import { OrderPlaced } from "./orders.js";

/**
 * Sends the receipt. Checkout doesn't know this exists: it announces
 * OrderPlaced, and this runs after the response, so a slow mail server
 * never holds up the customer. Nothing injects it, so app.ts imports it.
 */
@service
export class Receipts {
  @logger accessor log!: Logger;

  @on(OrderPlaced) send(event: OrderPlaced) {
    // A real shop hands this to a mail service; this one writes it to the log.
    this.log.info("receipt sent", { order: event.orderId, to: event.email, total: formatPrice(event.total) });
  }
}
