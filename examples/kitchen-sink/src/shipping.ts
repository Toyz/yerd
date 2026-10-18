import { HttpError, handles, inject, service } from "@toyz/yerd";
import { formatMoney } from "./attributes.js";
import { Catalog, type CategoryId } from "./catalog.js";
import { EventLog, QuoteShipping } from "./events.js";
import { ShopConfig } from "./shop.js";

/** Where the Bazaar ships, and where it would like to. */
export const COUNTRIES: Array<[code: string, name: string]> = [
  ["US", "United States"],
  ["PT", "Portugal"],
  ["JP", "Japan"],
  ["IS", "Iceland"],
  ["AQ", "Antarctica"],
  ["MOON", "The Moon"],
];

const BASE: Record<string, number> = { US: 499, PT: 899, JP: 1199, IS: 1099 };
const GRAMS: Record<CategoryId, number> = { gnomes: 2000, flamingos: 800, fountains: 6000, rocks: 9000, signs: 1500 };

/**
 * Shipping quotes, answered as a call: `await events.call(new QuoteShipping(...))`
 * anywhere gets a number back from here. Its HttpErrors reach the caller as
 * HttpErrors, so an impossible destination is a 422 the cart can show.
 */
@service
export class Shipping {
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(ShopConfig) accessor config!: ShopConfig;
  @inject(EventLog) accessor eventLog!: EventLog;

  @handles(QuoteShipping) quote(q: QuoteShipping): number {
    const summary = `${q.lines.length} line${q.lines.length === 1 ? "" : "s"} to ${q.country}`;
    try {
      const cents = this.#price(q);
      this.eventLog.call("shipping.quote", summary, "Shipping.quote", { status: "ok", note: cents === 0 ? "free" : formatMoney(cents) });
      return cents;
    } catch (error) {
      this.eventLog.call("shipping.quote", summary, "Shipping.quote", { status: "failed", note: (error as Error).message });
      throw error;
    }
  }

  #price(q: QuoteShipping): number {
    if (q.country === "AQ") throw new HttpError(422, "We don't ship to Antarctica: the penguins send everything back.");
    if (q.country === "MOON") throw new HttpError(422, "The Moon is out of range until our rocket clears customs.");
    const base = BASE[q.country];
    if (base === undefined) throw new HttpError(422, `We don't ship to ${q.country} yet.`);
    if (q.subtotalCents >= this.config.freeShippingCents) return 0;
    const grams = q.lines.reduce((sum, line) => {
      const product = this.catalog.get(line.id);
      return sum + (product ? GRAMS[product.category] : 1000) * line.qty;
    }, 0);
    return base + Math.ceil(grams / 1000) * 150;
  }
}
