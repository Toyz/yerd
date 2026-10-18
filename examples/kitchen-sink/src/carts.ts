import { inject, logger, service, type Logger } from "@toyz/yerd";
import { Catalog } from "./catalog.js";
import type { CartLine } from "./cart.js";

/** A demo account starts with something in its saved cart, so the merge on sign-in has something to show. */
const SEEDED: Record<string, Array<{ slug: string; qty: number }>> = {
  di: [
    { slug: "rock-that-was-here-first", qty: 1 },
    { slug: "neon-flamingo", qty: 1 },
  ],
};

/**
 * Saved carts, one per user, in memory: what a signed-in user had in their
 * cart, kept for next time (another day, another device). The session holds
 * the live cart; this is where it goes on sign-out and on every change.
 */
@service
export class Carts {
  @inject(Catalog) accessor catalog!: Catalog;
  @logger accessor log!: Logger;
  #saved = new Map<string, CartLine[]>();
  #seeded = new Set<string>();

  load(user: { id: string; name: string }): CartLine[] {
    if (!this.#seeded.has(user.id)) {
      this.#seeded.add(user.id);
      const seed = (SEEDED[user.name] ?? []).flatMap(({ slug, qty }) => {
        const product = this.catalog.bySlug(slug);
        return product ? [{ id: product.id, name: product.name, priceCents: product.priceCents, qty }] : [];
      });
      if (seed.length > 0 && !this.#saved.has(user.id)) this.#saved.set(user.id, seed);
    }
    return structuredClone(this.#saved.get(user.id) ?? []);
  }

  save(userId: string, lines: readonly CartLine[]): void {
    this.#saved.set(userId, structuredClone([...lines]));
  }

  /**
   * The saved cart with the guest's on top: the same item's quantities add
   * up, capped by what's in stock (and 99); sold-out items drop out.
   */
  merge(saved: readonly CartLine[], guest: readonly CartLine[]): CartLine[] {
    const merged = new Map<string, CartLine>();
    for (const line of [...saved, ...guest]) {
      const into = merged.get(line.id);
      if (into) into.qty += line.qty;
      else merged.set(line.id, { ...line });
    }
    return [...merged.values()].flatMap((line) => {
      const stock = this.catalog.get(line.id)?.stock ?? 0;
      const qty = Math.min(line.qty, stock, 99);
      return qty > 0 ? [{ ...line, qty }] : [];
    });
  }
}
