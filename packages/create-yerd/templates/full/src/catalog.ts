import { NotFound, service } from "@toyz/yerd";

export interface Product {
  id: number;
  name: string;
  /** In cents: money is never a float. */
  price: number;
  stock: number;
  description: string;
}

/** A NotFound: pages get the error page, the API a JSON 404 carrying the id. */
export class ProductNotFound extends NotFound {
  constructor(readonly id: number) {
    super(`No product ${id}`, { details: { id } });
  }
}

const PRODUCTS: Product[] = [
  { id: 1, name: "Fountain pen", price: 4800, stock: 5, description: "Steel nib, fine point, refillable." },
  { id: 2, name: "Pocket notebook", price: 900, stock: 25, description: "48 lined pages that fit a back pocket." },
  { id: 3, name: "Desk lamp", price: 6500, stock: 3, description: "Warm light, one arm, no app." },
  { id: 4, name: "Brass ruler", price: 1800, stock: 9, description: "Thirty centimetres, gets better with age." },
  { id: 5, name: "Dot grid journal", price: 3200, stock: 0, description: "A5, 160 pages, numbered and dotted." },
];

/** The shelves, in memory. A singleton: every request sees the same stock. */
@service
export class Catalog {
  // Copies, so tests and restarts start from the same shelves.
  #products = PRODUCTS.map((p) => ({ ...p }));

  /** Products whose name or description contains `q`. */
  search(q = ""): Product[] {
    const needle = q.toLowerCase();
    return this.#products.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(needle));
  }

  get(id: number): Product | undefined {
    return this.#products.find((p) => p.id === id);
  }

  /** Like get(), but a missing product answers the request with a 404. */
  find(id: number): Product {
    const product = this.get(id);
    if (!product) throw new ProductNotFound(id);
    return product;
  }

  /** Take sold items off the shelf. */
  take(id: number, qty: number): void {
    this.find(id).stock -= qty;
  }
}

/** 2400 -> "$24.00". */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
