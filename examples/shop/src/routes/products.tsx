import { Channels, Conflict, Region, action, get, inject, oneOf, param, query, route, session, setMeta, signal, sse, toInt, trim, type Session } from "@toyz/yerd";
import { Cart } from "../cart.js";
import { CATEGORIES, Catalog, stockChannel, type Category } from "../catalog.js";
import { Price, ProductCard } from "../components.js";
import { CartBadge } from "../layouts.js";

/** The shop's front page: every product, narrowed by ?q= and ?category=. */
@route("/", { meta: { title: "Shop" } })
export class ProductList {
  @inject(Catalog) accessor catalog!: Catalog;
  @query("q", { transform: trim }) accessor q = "";
  // Anything but a known category is a 400, before the handler runs.
  @query("category", { transform: oneOf(...CATEGORIES) }) accessor category: Category | undefined;

  @get page() {
    const products = this.catalog.search({ q: this.q, category: this.category });
    return (
      <>
        {/* A GET form: the search is a URL you can share and reload. */}
        <form class="search" method="get" role="search">
          <input type="search" name="q" value={this.q} placeholder="Search" aria-label="Search" />
          {this.category ? <input type="hidden" name="category" value={this.category} /> : null}
          <button>Search</button>
        </form>
        <nav class="categories" aria-label="Categories">
          <a href="/" aria-current={this.category ? undefined : "page"}>All</a>
          {CATEGORIES.map((c) => (
            <a href={`/?category=${c}`} aria-current={c === this.category ? "page" : undefined}>{c}</a>
          ))}
        </nav>
        {products.length === 0 ? (
          <p class="empty">Nothing matches "{this.q}".</p>
        ) : (
          <ul class="grid">{products.map((p) => <ProductCard product={p} />)}</ul>
        )}
      </>
    );
  }
}

/** Stock left, as a Region: live updates and the add action refresh it. */
function Stock({ stock }: { stock: number }) {
  return (
    <Region id="stock" as="p" class="stock" aria-live="polite">
      {stock === 0 ? "Sold out" : `${stock} in stock`}
    </Region>
  );
}

/** One product. An unknown id is the catalog's ProductNotFound: a 404. */
@route("/products/:id")
export class ProductPage {
  @inject(Catalog) accessor catalog!: Catalog;
  @param("id", { transform: toInt }) accessor id!: number;
  @session(Cart) accessor cart!: Session<Cart>;

  @get page() {
    const product = this.catalog.find(this.id);
    setMeta({ title: product.name, description: product.description });
    return (
      <article class="product">
        <h1>{product.name}</h1>
        <p>{product.description}</p>
        <Price cents={product.price} />
        <Stock stock={product.stock} />
        <form action={this.add}>
          <button disabled={product.stock === 0}>Add to cart</button>
        </form>
        {/* Every stock change on the channel refreshes this page's Regions. */}
        <div data-yx-live={`/products/${product.id}/stock`} hidden></div>
      </article>
    );
  }

  /** @param works in actions too: this.id is the product on the page. */
  @action add() {
    const product = this.catalog.find(this.id);
    const inCart = this.cart.lines.find((line) => line.id === product.id)?.qty ?? 0;
    // A 409: the runtime shows its message; checkout checks the stock again anyway.
    if (inCart >= product.stock) throw new Conflict(product.stock === 0 ? "Sold out." : `Only ${product.stock} in stock.`);
    this.cart.add(product.id);
    // With the runtime, these morph in; without it, the browser is sent back to the page.
    return (
      <>
        <CartBadge count={this.cart.count} />
        <Stock stock={product.stock} />
      </>
    );
  }
}

/** The product page's live feed: a message per stock change. No session needed for a stream. */
@route("/products/:id/stock", { session: false })
export class StockFeed {
  @inject(Catalog) accessor catalog!: Catalog;
  @inject(Channels) accessor channels!: Channels;
  @param("id", { transform: toInt }) accessor id!: number;
  @signal accessor stop!: AbortSignal;

  @get @sse feed() {
    this.catalog.find(this.id); // a 404 before the stream starts
    return this.channels.subscribe(stockChannel(this.id), this.stop);
  }
}
