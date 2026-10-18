import { Channels, NotFound, channel, inject, service } from "@toyz/yerd";

export const CATEGORIES = ["pens", "notebooks", "desk"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Product {
  id: number;
  name: string;
  category: Category;
  /** In cents: money is never a float. */
  price: number;
  stock: number;
  description: string;
}

/** A NotFound, so pages get the error page and the API a JSON 404 carrying the id. */
export class ProductNotFound extends NotFound {
  constructor(readonly id: number) {
    super(`No product ${id}`, { details: { id } });
  }
}

/** One channel per product: its page listens for stock changes. */
export const stockChannel = (id: number) => channel<{ id: number; stock: number }>(`stock:${id}`);

const PRODUCTS: Product[] = [
  { id: 1, name: "Fountain pen", category: "pens", price: 4800, stock: 5, description: "Steel nib, fine point, refillable." },
  { id: 2, name: "Gel pens, 3 pack", category: "pens", price: 750, stock: 40, description: "Black, blue and a red for corrections." },
  { id: 3, name: "Mechanical pencil", category: "pens", price: 1200, stock: 18, description: "0.5 mm lead and an eraser that works." },
  { id: 4, name: "Desk lamp", category: "desk", price: 6500, stock: 3, description: "Warm light, one arm, no app." },
  { id: 5, name: "Brass ruler", category: "desk", price: 1800, stock: 9, description: "Thirty centimetres, gets better with age." },
  { id: 6, name: "Pocket notebook", category: "notebooks", price: 900, stock: 25, description: "48 lined pages that fit a back pocket." },
  { id: 7, name: "Field notebook", category: "notebooks", price: 2400, stock: 12, description: "Waterproof paper for notes in the rain." },
  { id: 8, name: "Dot grid journal", category: "notebooks", price: 3200, stock: 0, description: "A5, 160 pages, numbered and dotted." },
];

/** The shelves, in memory. A singleton: every request sees the same stock. */
@service
export class Catalog {
  @inject(Channels) accessor channels!: Channels;
  // Copies, so tests and restarts start from the same shelves.
  #products = PRODUCTS.map((p) => ({ ...p }));

  /** Products whose name or description contains `q`, optionally in one category. */
  search({ q = "", category }: { q?: string; category?: Category | undefined } = {}): Product[] {
    const needle = q.toLowerCase();
    return this.#products.filter(
      (p) => (!category || p.category === category) && (!needle || `${p.name} ${p.description}`.toLowerCase().includes(needle)),
    );
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

  /** Take sold items off the shelf and tell every open product page. */
  async take(id: number, qty: number): Promise<void> {
    const product = this.find(id);
    product.stock -= qty;
    await this.channels.publish(stockChannel(id), { id, stock: product.stock });
  }
}

/** 2400 -> "$24.00". */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
