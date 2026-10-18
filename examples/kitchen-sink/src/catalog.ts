import { randomUUID } from "node:crypto";
import { Conflict, NotFound, between, is, length, logger, lower, onBoot, onShutdown, service, trim, type Logger } from "@toyz/yerd";

/** The five aisles of the Bazaar. The ids double as URL values (`/?category=gnomes`). */
export const CATEGORY_IDS = ["gnomes", "flamingos", "fountains", "rocks", "signs"] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const CATEGORIES: Record<CategoryId, { name: string; blurb: string; hue: number }> = {
  gnomes: { name: "Garden Gnomes", blurb: "Hand-painted, mildly judgmental.", hue: 8 },
  flamingos: { name: "Lawn Flamingos", blurb: "Pink, plastic, proud.", hue: 330 },
  fountains: { name: "Birdbaths & Fountains", blurb: "Water features for birds with standards.", hue: 200 },
  rocks: { name: "Suspicious Rocks", blurb: "Some of them are just rocks.", hue: 35 },
  signs: { name: "Yard Signs", blurb: "Say it with plywood.", hue: 140 },
};

export interface Product {
  id: string;
  slug: string;
  name: string;
  category: CategoryId;
  priceCents: number;
  description: string;
  stock: number;
  tags: string[];
  /** Colour of the generated product art. */
  hue: number;
  /** How many uploaded photos it has; 0 means the generated SVG is shown. */
  photos: number;
  /** Bumped on every photo upload, so image URLs change and caches let go. */
  photoVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface Review {
  id: string;
  productId: string;
  author: string;
  rating: number;
  text: string;
  hasPhoto: boolean;
  createdAt: string;
}

/** An uploaded image, kept in memory: this is a demo, not a CDN. */
export interface Photo {
  type: string;
  bytes: Uint8Array;
}

/** The REST API's create / replace body (`POST` and `PUT /api/products`). */
export class ProductInput {
  @is.string({ transform: trim, validate: length(3, 60) }) name!: string;
  @is.oneOf(CATEGORY_IDS) category!: CategoryId;
  @is.int({ validate: between(1, 1_000_000) }) priceCents!: number;
  @is.string({ transform: trim, validate: length(0, 600) }) description = "";
  @is.int({ validate: between(0, 9999) }) stock = 10;
  @is.array(is.string({ transform: [trim, lower], validate: length(1, 24) }), { optional: true, max: 6 }) tags?: string[];
}

/**
 * `PATCH /api/products/:id`: every field optional. A field the client left
 * out isn't on the instance at all, so `{ "stock": 3 }` keeps the rest.
 */
export class ProductChanges {
  @is.string({ optional: true, transform: trim, validate: length(3, 60) }) name?: string;
  @is.oneOf(CATEGORY_IDS, { optional: true }) category?: CategoryId;
  @is.int({ optional: true, validate: between(1, 1_000_000) }) priceCents?: number;
  @is.string({ optional: true, transform: trim, validate: length(0, 600) }) description?: string;
  @is.int({ optional: true, validate: between(0, 9999) }) stock?: number;
}

/** The admin's "new product" form: dollars, not cents, and up to four staged photos. */
export class NewProductForm {
  @is.string({ transform: trim, validate: length(3, 60) }) name!: string;
  @is.oneOf(CATEGORY_IDS) category!: CategoryId;
  @is.number({ validate: between(0.5, 10_000) }) price!: number;
  @is.string({ optional: true, transform: trim, validate: length(0, 600) }) description?: string;
  @is.files({ optional: true, types: ["image/*"], maxSize: 2_000_000, max: 4 }) photos?: File[];
}

/** The inline edit row on /admin/products. */
export class EditProductForm {
  @is.string({ transform: trim, validate: length(3, 60) }) name!: string;
  @is.number({ validate: between(0.5, 10_000) }) price!: number;
}

/** Files dropped on a `trigger="drop:files"` zone arrive under "files". */
export class DroppedPhotos {
  @is.files({ types: ["image/*"], maxSize: 2_000_000, min: 1, max: 4 }) files!: File[];
}

/** A domain error: a NotFound, so the API answers a JSON 404 with the id, and pages show the error page. */
export class ProductNotFound extends NotFound {
  constructor(readonly id: string) {
    super(`No product with id ${id}`, { details: { id } });
  }
}

/** More in the cart than on the shelf: a 409, which the runtime shows as a notice. */
export class OutOfStock extends Conflict {
  constructor(readonly product: string, readonly left: number) {
    super(left === 0 ? `${product} just sold out.` : `Only ${left} of ${product} left on the shelf.`, { code: "out_of_stock", details: { left } });
  }
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The generated art (or the uploaded photo) at a given width, for <img src> and srcset. */
export function imageUrl(product: Product, width = 320, n = 0): string {
  const query = new URLSearchParams({ w: String(width) });
  if (n > 0) query.set("n", String(n));
  if (product.photoVersion > 0) query.set("v", String(product.photoVersion));
  return `/img/products/${product.slug}?${query}`;
}

/** The generated art comes in three views; uploaded photos replace them. */
const VIEWS = ["front view", "side view", "at night"];

/** How many slides a product's gallery has. */
export function slideCount(product: Product): number {
  return product.photos > 0 ? product.photos : VIEWS.length;
}

export function slideLabel(product: Product, n: number): string {
  return product.photos > 0 ? `photo ${n + 1}` : VIEWS[n] ?? `view ${n + 1}`;
}

const NAMES: Record<CategoryId, string[]> = {
  gnomes: [
    "Philosophical Gnome", "Gnome With a Tiny Leaf Blower", "Disco Gnome", "Gnome Who Knows What You Did",
    "Off-Duty Gnome", "Gnome Holding a Smaller Gnome", "Gnome in Witness Protection", "Sleepy Gnome",
    "Gnome Astronaut", "Gnome Accountant", "Retired Pirate Gnome", "Gnome That Moves When You Blink",
  ],
  flamingos: [
    "Classic Pink Flamingo", "Flamingo in a Tuxedo", "Flamingo on Both Legs", "Neon Flamingo",
    "Flamingo Flock, Pack of Twelve", "Grumpy Flamingo", "Flamingo With Sunglasses", "Emergency Inflatable Flamingo",
    "Glow-in-the-Dark Flamingo", "Flamingo Doing Yoga", "Camouflage Flamingo", "Flamingo Mid-Sneeze",
  ],
  fountains: [
    "Birdbath for Discerning Birds", "Fountain That Hums Off-Key", "Slightly Leaning Tiered Fountain", "Birdbath Jacuzzi",
    "Wishing Well, Wishes Sold Separately", "Solar Bubbler", "Fountain Shaped Like a Fountain", "Cherub With Hiccups",
    "Minimalist Puddle", "Birdbath With Diving Board", "Koi Pond Starter Bucket", "Small Dramatic Waterfall",
  ],
  rocks: [
    "Rock That Looks Like a Potato", "House-Trained Pet Rock", "Hollow Decorative Boulder", "Rock With Googly Eyes",
    "Obviously Fake Key Rock", "Suspiciously Warm Rock", "Motivational Rock", "Rock Shaped Like Ohio",
    "Single Artisanal Pebble", "Zen Rake Kit", "Probably a Meteorite", "Rock That Was Here First",
  ],
  signs: [
    "Beware of the Gnome", "Keep Off the Grass, Politely", "Flamingo Surveillance Sign", "Please Do Not Feed the Rocks",
    "Lawn Closed for Renovations", "Free Gravel, Ask Inside", "Slow: Snails Crossing", "Yes, We Know About the Gnome",
    "Custom Sign, Says Whatever", "Lost Flamingo Poster", "Garden Party Cancelled Again", "Neighborhood Gnome Watch",
  ],
};

const QUIPS = [
  "Weatherproof, mostly.",
  "Ships in a box that is also a gnome-sized apartment.",
  "Comes with a certificate of authenticity we printed ourselves.",
  "Your neighbors will have questions.",
  "Assembly not required, but emotionally encouraged.",
  "Approved by at least one bird.",
  "Not responsible for nocturnal wandering.",
];

/**
 * The catalog: products, their photos and reviews, in memory. A singleton,
 * so every request (and the background jobs) sees the same shelves.
 */
@service
export class Catalog {
  #products: Product[] = [];
  #photos = new Map<string, Photo[]>();
  #reviews: Review[] = [];
  #reviewPhotos = new Map<string, Photo>();
  #next = 1;
  /** Logs as "Catalog", from whichever request (or job) is running. */
  @logger accessor log!: Logger;

  /** Stock the shelves before the server takes requests: 12 oddities per aisle. */
  @onBoot seed() {
    const now = Date.now();
    for (const category of CATEGORY_IDS) {
      NAMES[category].forEach((name, i) => {
        const at = new Date(now - (this.#next * 3_600_000)).toISOString();
        this.#products.push({
          id: `p${String(this.#next).padStart(2, "0")}`,
          slug: slugify(name),
          name,
          category,
          priceCents: 499 + ((i * 1373 + category.length * 211) % 60) * 100,
          description: `${name}. ${CATEGORIES[category].blurb} ${QUIPS[(this.#next * 3) % QUIPS.length]}`,
          stock: (i * 7 + category.length) % 17,
          tags: [category, i % 3 === 0 ? "bestseller" : i % 3 === 1 ? "new" : "classic"],
          hue: (CATEGORIES[category].hue + i * 9) % 360,
          photos: 0,
          photoVersion: 0,
          createdAt: at,
          updatedAt: at,
        });
        this.#next++;
      });
    }
    this.#reviews.push(
      { id: randomUUID(), productId: "p01", author: "cy", rating: 5, text: "He disapproves of my lawn and he is right.", hasPhoto: false, createdAt: new Date(now - 86_400_000).toISOString() },
      { id: randomUUID(), productId: "p13", author: "bo", rating: 4, text: "Stands on one leg as advertised. Sometimes zero.", hasPhoto: false, createdAt: new Date(now - 7_200_000).toISOString() },
    );
    this.log.info("shelves stocked", { products: this.#products.length });
  }

  @onShutdown goodbye() {
    this.log.info("closing the shop", { products: this.#products.length, reviews: this.#reviews.length });
  }

  all(): Product[] {
    return this.#products;
  }

  get(id: string): Product | undefined {
    return this.#products.find((p) => p.id === id);
  }

  /** Like get(), but a missing product is a ProductNotFound. */
  find(id: string): Product {
    const product = this.get(id);
    if (!product) throw new ProductNotFound(id);
    return product;
  }

  bySlug(slug: string): Product | undefined {
    return this.#products.find((p) => p.slug === slug);
  }

  /** One page of search results. `q` matches names, descriptions and tags. */
  search({ q = "", category = "" }: { q?: string; category?: string }, page = 1, size = 12) {
    const needle = q.trim().toLowerCase();
    const hits = this.#products.filter(
      (p) =>
        (category === "" || p.category === category) &&
        (needle === "" || p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle) || p.tags.includes(needle)),
    );
    const pages = Math.max(1, Math.ceil(hits.length / size));
    return { items: hits.slice((page - 1) * size, page * size), total: hits.length, page, pages };
  }

  lowStock(limit = 3): Product[] {
    return this.#products.filter((p) => p.stock < limit).sort((a, b) => a.stock - b.stock);
  }

  create(input: Omit<ProductInput, "tags"> & { tags?: string[] }): Product {
    const now = new Date().toISOString();
    let slug = slugify(input.name);
    while (this.bySlug(slug)) slug = `${slug}-${this.#next}`;
    const product: Product = {
      id: `p${String(this.#next++).padStart(2, "0")}`,
      slug,
      name: input.name,
      category: input.category,
      priceCents: input.priceCents,
      description: input.description,
      stock: input.stock,
      tags: input.tags ?? [input.category],
      hue: Math.floor(Math.random() * 360),
      photos: 0,
      photoVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#products.unshift(product);
    this.log.info("product added", { id: product.id, name: product.name });
    return product;
  }

  update(id: string, changes: ProductChanges | ProductInput): Product {
    const product = this.find(id);
    // A renamed product keeps its slug: links people shared still work.
    Object.assign(product, changes, { updatedAt: new Date().toISOString() });
    return product;
  }

  duplicate(id: string): Product {
    const source = this.find(id);
    return this.create({ ...source, name: `${source.name} (Again)` });
  }

  remove(id: string): boolean {
    const before = this.#products.length;
    this.#products = this.#products.filter((p) => p.id !== id);
    this.#photos.delete(id);
    return this.#products.length < before;
  }

  /** Sell `qty` of a product; false when there isn't enough stock. */
  take(id: string, qty: number): boolean {
    const product = this.get(id);
    if (!product || product.stock < qty) return false;
    product.stock -= qty;
    return true;
  }

  /** Put stock back (a cancelled order). */
  restock(id: string, qty: number): void {
    const product = this.get(id);
    if (product) product.stock += qty;
  }

  // ── photos ──

  async addPhotos(id: string, files: File[], replace = false): Promise<Product> {
    const product = this.find(id);
    const photos = await Promise.all(files.map(async (f) => ({ type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const list = replace ? photos : [...(this.#photos.get(id) ?? []), ...photos];
    this.#photos.set(id, list);
    product.photos = list.length;
    product.photoVersion++;
    return product;
  }

  photo(id: string, n = 0): Photo | undefined {
    return this.#photos.get(id)?.[n];
  }

  // ── reviews ──

  reviews(productId: string): Review[] {
    return this.#reviews.filter((r) => r.productId === productId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addReview(productId: string, review: { author: string; rating: number; text: string }, photo?: File): Promise<Review> {
    const saved: Review = { id: randomUUID(), productId, ...review, hasPhoto: photo !== undefined, createdAt: new Date().toISOString() };
    if (photo) this.#reviewPhotos.set(saved.id, { type: photo.type, bytes: new Uint8Array(await photo.arrayBuffer()) });
    this.#reviews.push(saved);
    return saved;
  }

  reviewPhoto(id: string): Photo | undefined {
    return this.#reviewPhotos.get(id);
  }
}
