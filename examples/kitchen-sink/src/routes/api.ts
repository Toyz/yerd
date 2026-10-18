import {
  Channels, Unauthorized, between, body, createGuard, currentContext, del, event, get, inject, ndjson, oneOf, param, patch, post, put, query, resolve, route, setHeader, signal,
  sse, status, toInt, trim,
} from "@toyz/yerd";
import { CATEGORY_IDS, Catalog, ProductChanges, ProductInput, ProductNotFound, type CategoryId, type Product } from "../catalog.js";
import { SalesFeed, salesChannel } from "../sales.js";
import { Presence, ShopConfig } from "../shop.js";
import { auth } from "../users.js";

/**
 * Who may write to the API: a script with the shop's key in `x-api-key`, or
 * a signed-in staff member (their browser session). Reads are public.
 */
export const apiWriter = createGuard("apiWriter", (ctx) => {
  if (ctx.headers["x-api-key"] === resolve(ShopConfig).apiKey) return true;
  if (auth.current()?.roles.includes("staff")) return true;
  return new Unauthorized("Send x-api-key, or sign in as staff", { details: { hint: "x-api-key: let-me-in (the demo key)" } });
});

/** What the API shows of a product: everything but the internals of photo storage. */
function view(product: Product) {
  const { photoVersion: _, ...rest } = product;
  return { ...rest, url: `/products/${product.slug}` };
}

/**
 * The REST API, next to the HTML shop.
 *
 * ```sh
 * curl localhost:3300/api/products?category=gnomes&limit=3
 * curl -H 'x-api-key: let-me-in' -H 'content-type: application/json' \
 *   -d '{"name":"Gnome Lawyer","category":"gnomes","priceCents":4200}' localhost:3300/api/products
 * curl -X PATCH -H 'x-api-key: let-me-in' -H 'content-type: application/json' -d '{"stock":0}' localhost:3300/api/products/p61
 * curl -X DELETE -H 'x-api-key: let-me-in' localhost:3300/api/products/p61
 * ```
 */
@route("/api/products")
export class ProductsApi {
  @inject(Catalog) accessor catalog!: Catalog;
  @query("category", { transform: oneOf(...CATEGORY_IDS) }) accessor category: CategoryId | undefined;
  @query("q", { transform: trim }) accessor q = "";
  @query("limit", { transform: toInt, validate: between(1, 100) }) accessor limit = 20;
  @query("page", { transform: toInt, validate: between(1, 1000) }) accessor page = 1;
  @body(ProductInput) accessor input!: Promise<ProductInput>;

  @get list() {
    const found = this.catalog.search({ q: this.q, category: this.category ?? "" }, this.page, this.limit);
    return { products: found.items.map(view), total: found.total, page: found.page, pages: found.pages };
  }

  /** 201 with the new product, and where it lives (only known once it exists, hence ctx.setHeader). */
  @post @apiWriter @status(201) @setHeader("cache-control", "no-store")
  async create() {
    const product = this.catalog.create(await this.input);
    currentContext().setHeader("location", `/api/products/${product.id}`);
    return view(product);
  }
}

@route("/api/products/:id")
export class ProductApi {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id") accessor id!: string;
  /** Two body shapes on one route: they're promises, so each handler awaits (and validates) only its own. */
  @body(ProductInput) accessor replacement!: Promise<ProductInput>;
  @body(ProductChanges) accessor changes!: Promise<ProductChanges>;

  @get show() {
    return view(this.catalog.find(this.id));
  }

  @put @apiWriter async replace() {
    return view(this.catalog.update(this.id, await this.replacement));
  }

  /** Only what was sent changes: an all-optional DTO is a PATCH body. */
  @patch @apiWriter async update() {
    return view(this.catalog.update(this.id, await this.changes));
  }

  /** Nothing to say: undefined is a 204. */
  @del @apiWriter remove() {
    if (!this.catalog.remove(this.id)) throw new ProductNotFound(this.id);
  }

}

/** The whole catalog as NDJSON, one product per line, streamed: `curl -N localhost:3300/api/products.ndjson`. */
@route("/api/products.ndjson")
export class ProductExport {
  @inject(Catalog) accessor catalog!: Catalog;

  @get @ndjson async *export() {
    for (const product of this.catalog.all()) yield view(product);
  }
}

/** Recent sales as JSON, for scripts (and the README's curl examples). */
@route("/api/sales")
export class SalesApi {
  @inject(SalesFeed) accessor sales!: SalesFeed;

  @get list() {
    return { stats: this.sales.stats(), recent: this.sales.recent(20) };
  }
}

/**
 * The shop's sales ticker: named `sale` events (`event()`), read by the
 * `ticker` attribute's EventSource. Each open ticker counts as a shopper
 * online until it disconnects (the generator's finally runs on disconnect).
 */
@route("/sales/ticker")
export class SalesTicker {
  @inject(Channels) accessor channels!: Channels;
  @inject(Presence) accessor presence!: Presence;
  @signal accessor stop!: AbortSignal;

  @get @sse({ retry: 5_000 }) async *ticker() {
    this.presence.join();
    try {
      for await (const sale of this.channels.subscribe(salesChannel, this.stop)) {
        yield event({ event: "sale", id: sale.id, data: sale });
      }
    } finally {
      this.presence.leave();
    }
  }
}
