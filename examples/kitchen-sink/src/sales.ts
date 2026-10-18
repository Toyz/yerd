import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Channels, channel, every, hosted, inject, logger, on, service, type HostedService, type Logger } from "@toyz/yerd";
import { Catalog } from "./catalog.js";
import { EventLog, OrderPlaced } from "./events.js";

export interface Sale {
  id: string;
  productId: string;
  name: string;
  qty: number;
  totalCents: number;
  city: string;
  at: string;
  /** "crowd" sales are made up by SalesFeed; "order" ones came through the checkout. */
  source: "crowd" | "order";
}

/** Every sale, real or imagined: the shop's ticker and the admin dashboard listen here. */
export const salesChannel = channel<Sale>("sales");

const CITIES = ["Ohio", "Lisbon", "Osaka", "a moving vehicle", "Reykjavik", "Duluth", "an undisclosed bunker", "Nairobi", "Leeds", "the Moon (allegedly)"];

/**
 * The sales floor. Real orders are recorded here, and so are the imaginary
 * customers @every invents, so the ticker and the dashboard always have
 * something to show.
 */
@service
export class SalesFeed {
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(Channels) accessor channels!: Channels;
  @inject(EventLog) accessor eventLog!: EventLog;
  @logger accessor log!: Logger;
  #sales: Sale[] = [];
  #tick = 0;

  /** A made-up customer buys something every few seconds (runs never overlap; stops at shutdown). */
  @every("4s") async crowd() {
    const products = this.catalog.all().filter((p) => p.stock > 0);
    if (products.length === 0) return;
    this.#tick++;
    const product = products[(this.#tick * 7919) % products.length]!;
    const qty = 1 + (this.#tick % 3 === 0 ? 1 : 0);
    if (!this.catalog.take(product.id, qty)) return;
    await this.record({ productId: product.id, name: product.name, qty, totalCents: product.priceCents * qty, city: CITIES[this.#tick % CITIES.length]!, source: "crowd" });
  }

  /** A real order: each line is a sale on the ticker and the dashboard. */
  @on(OrderPlaced) async fromOrder(event: OrderPlaced) {
    for (const line of event.lines) {
      await this.record({ productId: line.id, name: line.name, qty: line.qty, totalCents: line.priceCents * line.qty, city: "right here", source: "order" });
    }
    this.eventLog.ran(event.id, "SalesFeed.fromOrder", "ok", `${event.lines.length} sale${event.lines.length === 1 ? "" : "s"} on the ticker`);
  }

  async record(sale: Omit<Sale, "id" | "at">): Promise<Sale> {
    const saved: Sale = { id: randomUUID(), at: new Date().toISOString(), ...sale };
    this.#sales.unshift(saved);
    this.#sales.length = Math.min(this.#sales.length, 200);
    this.log.debug("sold", { name: saved.name, qty: saved.qty, source: saved.source });
    await this.channels.publish(salesChannel, saved);
    return saved;
  }

  recent(count = 10): Sale[] {
    return this.#sales.slice(0, count);
  }

  stats() {
    const revenue = this.#sales.reduce((sum, s) => sum + s.totalCents, 0);
    const units = new Map<string, number>();
    for (const sale of this.#sales) units.set(sale.name, (units.get(sale.name) ?? 0) + sale.qty);
    const top = [...units.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      revenue,
      count: this.#sales.length,
      orders: this.#sales.filter((s) => s.source === "order").length,
      top: top ? { name: top[0], units: top[1] } : undefined,
    };
  }
}

/**
 * A hosted service: long-running background work that starts after boot and
 * is told to stop (the signal) at shutdown. It tops up whatever the crowd
 * bought out.
 */
@hosted
export class RestockWorker implements HostedService {
  @inject(Catalog) accessor catalog!: Catalog;
  @logger accessor log!: Logger;

  async run(signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        // The signal ends the wait at once on shutdown instead of after the next round.
        await sleep(20_000, undefined, { signal });
        const empty = this.catalog.lowStock(1);
        for (const product of empty) product.stock += 6;
        if (empty.length > 0) this.log.info("restocked", { products: empty.map((p) => p.name) });
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
