import { between, is } from "@toyz/yerd";
import type { Catalog, Product } from "./catalog.js";

export interface CartLine {
  id: number;
  qty: number;
}

const MAX_QTY = 99;

/**
 * The cart, as a session shape: `@session(Cart) accessor cart!: Session<Cart>`.
 * Only `lines` is stored, ids and quantities: names and prices come from the
 * catalog at render, so a price change can't leave stale copies in cookies.
 * `this` is the session, so a new visitor gets no cookie until they add something.
 */
export class Cart {
  lines: CartLine[] = [];

  get count(): number {
    return this.lines.reduce((sum, line) => sum + line.qty, 0);
  }

  add(id: number, qty = 1): void {
    const line = this.lines.find((l) => l.id === id);
    // In-place changes are noticed and saved, like assignments.
    if (line) line.qty = Math.min(MAX_QTY, line.qty + qty);
    else this.lines.push({ id, qty: Math.min(MAX_QTY, qty) });
  }

  /** 0 removes the line. */
  setQty(id: number, qty: number): void {
    if (qty <= 0) return this.remove(id);
    const line = this.lines.find((l) => l.id === id);
    if (line) line.qty = Math.min(MAX_QTY, qty);
  }

  remove(id: number): void {
    this.lines = this.lines.filter((l) => l.id !== id);
  }

  /** Not `clear()`: that's the session's own, and would sign the user out too. */
  empty(): void {
    this.lines = [];
  }
}

/** The quantity box on the cart page. */
export class QtyForm {
  @is.int({ validate: between(0, MAX_QTY) }) qty!: number;
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
