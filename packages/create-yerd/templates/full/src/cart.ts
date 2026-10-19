import type { Catalog, Product } from "./catalog.js";

export interface CartLine {
  id: number;
  qty: number;
}

/**
 * The cart, as a session shape: `@session(Cart) accessor cart!: Session<Cart>`.
 * Only ids and quantities are stored; names and prices come from the catalog
 * at render. A new visitor gets no cookie until they add something.
 */
export class Cart {
  lines: CartLine[] = [];

  get count(): number {
    return this.lines.reduce((sum, line) => sum + line.qty, 0);
  }

  add(id: number): void {
    const line = this.lines.find((l) => l.id === id);
    // In-place changes are noticed and saved, like assignments.
    if (line) line.qty++;
    else this.lines.push({ id, qty: 1 });
  }

  remove(id: number): void {
    this.lines = this.lines.filter((l) => l.id !== id);
  }

  /** Not `clear()`: that's the session's own, and would sign the user out too. */
  empty(): void {
    this.lines = [];
  }
}

export interface PricedLine {
  product: Product;
  qty: number;
  subtotal: number;
}

/** The cart's lines with their products and prices. Products gone from the catalog drop out. */
export function priceCart(lines: CartLine[], catalog: Catalog): { lines: PricedLine[]; total: number } {
  const priced = lines.flatMap(({ id, qty }) => {
    const product = catalog.get(id);
    return product ? [{ product, qty, subtotal: product.price * qty }] : [];
  });
  return { lines: priced, total: priced.reduce((sum, line) => sum + line.subtotal, 0) };
}
